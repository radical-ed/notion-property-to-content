import { Client } from '@notionhq/client'

export function createNotionClient (token = process.env.NOTION_TOKEN) {
  if (!token) {
    throw new Error('Missing NOTION_TOKEN in environment')
  }

  return new Client({
    auth: token,
    timeoutMs: 120_000
  })
}

// ---------------------------------
export async function * paginate (method, params) {
  const result = await method(params)
  yield result
  if (result.next_cursor) {
    yield * paginate(method, { ...params, start_cursor: result.next_cursor })
  }
}

// ---------------------------------
export async function collectPaginated (method, params) {
  const items = []
  for await (const result of paginate(method, params)) {
    items.push(...result.results)
  }
  return items
}

// ---------------------------------
export function getTitleProperty (properties) {
  return Object.values(properties).find(p => p.type === 'title')
}

// ---------------------------------
export function richTextToPlainText (richText) {
  return (richText ?? []).map(rt => rt.plain_text).join('')
}

// ---------------------------------
export function getTitleText (page) {
  const titleProperty = getTitleProperty(page.properties)
  const text = richTextToPlainText(titleProperty?.title).trim()
  return text || page.id
}

// As of Notion API 2025-09-03, a database's rows live under its data
// source(s), not the database itself - `databases.query` was removed in
// favor of `dataSources.query`. These scripts only ever dealt with
// single-source databases, so resolve and require exactly one.
export async function getDataSourceId (notion, databaseId) {
  const database = await notion.databases.retrieve({ database_id: databaseId })
  const dataSources = database.data_sources ?? []
  if (dataSources.length !== 1) {
    throw new Error(`Database ${databaseId} has ${dataSources.length} data source(s); expected exactly 1 (multi-source databases aren't supported by these scripts)`)
  }
  return dataSources[0].id
}

// ---------------------------------
export async function fetchDatabasePages (notion, databaseId) {
  const dataSourceId = await getDataSourceId(notion, databaseId)
  return collectPaginated(notion.dataSources.query, { data_source_id: dataSourceId })
}

// ---------------------------------
export async function getDatabaseName (notion, databaseId) {
  const database = await notion.databases.retrieve({ database_id: databaseId })
  return richTextToPlainText(database.title).trim() || databaseId
}

// ---------------------------------
export async function fetchBlockChildren (notion, blockId) {
  return collectPaginated(notion.blocks.children.list, { block_id: blockId })
}

// Recursively fetches a page's (or block's) content, including nested children.
export async function fetchPageContentTree (notion, blockId) {
  const blocks = await fetchBlockChildren(notion, blockId)
  for (const block of blocks) {
    if (block.has_children) {
      block.children = await fetchPageContentTree(notion, block.id)
    }
  }
  return blocks
}

// Canonical, comparable text representation of a block tree: block type and
// text content, ignoring IDs/timestamps so two equivalent trees compare equal.
export function blockTreeToPlainText (blocks, depth = 0) {
  const indent = '  '.repeat(depth)
  return blocks
    .map(block => {
      const richText = block[block.type]?.rich_text
      const text = richText ? richTextToPlainText(richText) : ''
      let line = `${indent}[${block.type}] ${text}`.trimEnd()
      if (block.children?.length > 0) {
        line += '\n' + blockTreeToPlainText(block.children, depth + 1)
      }
      return line
    })
    .join('\n')
}

// Property types that are computed, or reference IDs private to one database
// (e.g. relations point at pages within their own database), so comparing
// them across two databases isn't meaningful.
const SKIPPED_PROPERTY_TYPES = new Set([
  'title',
  'relation',
  'rollup',
  'formula',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'verification'
])

function extractPropertyValue (property) {
  switch (property.type) {
    case 'rich_text':
      return richTextToPlainText(property.rich_text)
    case 'number':
      return property.number
    case 'checkbox':
      return property.checkbox
    case 'select':
      return property.select?.name ?? null
    case 'status':
      return property.status?.name ?? null
    case 'multi_select':
      return property.multi_select.map(o => o.name).sort()
    case 'date':
      return property.date ? { start: property.date.start, end: property.date.end ?? null } : null
    case 'people':
      return property.people.map(p => p.name ?? p.id).sort()
    case 'files':
      return property.files.map(f => f.name).sort()
    case 'url':
      return property.url
    case 'email':
      return property.email
    case 'phone_number':
      return property.phone_number
    default:
      return undefined
  }
}

// Compares two pages' properties and returns a list of { property, reason, valueA, valueB }.
export function diffProperties (propertiesA, propertiesB) {
  const diffs = []
  const keys = new Set([...Object.keys(propertiesA), ...Object.keys(propertiesB)])

  for (const key of keys) {
    const a = propertiesA[key]
    const b = propertiesB[key]
    const type = a?.type ?? b?.type

    if (SKIPPED_PROPERTY_TYPES.has(type)) {
      continue
    }

    if (!a || !b) {
      diffs.push({ property: key, reason: !a ? 'missing-in-a' : 'missing-in-b' })
      continue
    }

    const valueA = extractPropertyValue(a)
    const valueB = extractPropertyValue(b)

    if (valueA === undefined || valueB === undefined) {
      continue // unhandled property type, don't report false positives
    }

    if (JSON.stringify(valueA) !== JSON.stringify(valueB)) {
      diffs.push({ property: key, reason: 'different', valueA, valueB })
    }
  }

  return diffs
}
