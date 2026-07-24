import { fetchPageContentTree, richTextToPlainText, getTitleText } from './notion.js'

// Block types that act as a "section header" in these GTD templates: either a
// heading, or a toggle wrapping a linked database view (Actions/References/
// Someday-Maybe). Anything else at the top level of a template is ignored -
// it's boilerplate (an empty leading paragraph, etc.), not a mergeable unit.
const HEADER_BLOCK_TYPES = new Set(['heading_1', 'heading_2', 'heading_3', 'toggle'])

// Block types with a simple `rich_text` payload we know how to rebuild from
// scratch when recreating a missing header's placeholder content. Anything
// richer (images, tables, embeds...) is skipped with a warning - not expected
// under a "write your notes here" placeholder, and not worth the complexity.
const SIMPLE_RICH_TEXT_BLOCK_TYPES = new Set([
  'paragraph', 'heading_1', 'heading_2', 'heading_3', 'toggle',
  'bulleted_list_item', 'numbered_list_item', 'quote', 'callout'
])

function normalizeId (id) {
  return String(id).replace(/-/g, '').toLowerCase()
}

// Deep-clones `value`, replacing any string that equals `fromId` with `toId`.
// Used to turn a template's self-referencing relation filter ("this page")
// into a filter pointing at the real target page.
export function substituteSelfReferences (value, fromId, toId) {
  if (typeof value === 'string') {
    return normalizeId(value) === normalizeId(fromId) ? toId : value
  }
  if (Array.isArray(value)) {
    return value.map(v => substituteSelfReferences(v, fromId, toId))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteSelfReferences(v, fromId, toId)]))
  }
  return value
}

// ---------------------------------
export async function listDataSourceTemplates (notion, dataSourceId) {
  const result = await notion.dataSources.listTemplates({ data_source_id: dataSourceId })
  return result.templates
}

// Picks the template to use: the explicit `templateArg` (matched by id or
// case-insensitive name) if given, the sole template if there's only one, the
// data source's default template if there's no explicit arg but one is
// flagged `is_default`, or - if none of that resolves it - asks the caller to
// choose via `chooseTemplate(templates)`.
export async function resolveTemplate (notion, dataSourceId, { templateArg, chooseTemplate } = {}) {
  const templates = await listDataSourceTemplates(notion, dataSourceId)
  if (templates.length === 0) {
    throw new Error(`Data source ${dataSourceId} has no page templates`)
  }

  if (templateArg) {
    const match = templates.find(t => t.id === templateArg || t.name.toLowerCase() === templateArg.toLowerCase())
    if (!match) {
      throw new Error(`No template named or with id "${templateArg}" found. Available: ${templates.map(t => t.name).join(', ')}`)
    }
    return match
  }

  if (templates.length === 1) {
    return templates[0]
  }

  const byDefault = templates.find(t => t.is_default)
  if (byDefault && !chooseTemplate) {
    return byDefault
  }

  if (!chooseTemplate) {
    throw new Error(`Multiple templates found (${templates.map(t => t.name).join(', ')}); pass --template=<name-or-id>`)
  }

  return chooseTemplate(templates)
}

function findChildDatabaseBlock (toggleBlock) {
  return (toggleBlock.children ?? []).find(b => b.type === 'child_database')
}

// Fetches a template page's content and groups it into "segments": each one
// starts at a header block (heading or toggle) and carries whatever's needed
// to reapply it to a target page - either the linked view(s) config for a
// toggle wrapping a database, or the trailing placeholder blocks for a plain
// heading.
export async function resolveTemplateSegments (notion, templateId) {
  const tree = await fetchPageContentTree(notion, templateId)

  const segments = []
  for (const block of tree) {
    if (HEADER_BLOCK_TYPES.has(block.type)) {
      segments.push({
        headerType: block.type,
        headerText: richTextToPlainText(block[block.type]?.rich_text).trim(),
        templateBlock: block,
        trailingBlocks: []
      })
    } else if (segments.length > 0) {
      segments[segments.length - 1].trailingBlocks.push(block)
    }
    // Blocks before the first header (e.g. a stray empty paragraph) are boilerplate, ignored.
  }

  for (const segment of segments) {
    const childDbBlock = segment.headerType === 'toggle' ? findChildDatabaseBlock(segment.templateBlock) : null

    if (!childDbBlock) {
      segment.kind = 'text'
      continue
    }

    segment.kind = 'view'
    segment.childDbBlockId = childDbBlock.id
    const views = await notion.views.list({ database_id: childDbBlock.id })
    segment.views = await Promise.all(views.results.map(v => notion.views.retrieve({ view_id: v.id })))
  }

  return segments
}

function matchHeaderOnPage (pageBlocks, segment) {
  return pageBlocks.find(b => b.type === segment.headerType && richTextToPlainText(b[b.type]?.rich_text).trim() === segment.headerText)
}

function sanitizeRichText (richText) {
  return (richText ?? []).map(rt => ({
    type: 'text',
    text: { content: rt.plain_text ?? '', link: rt.href ? { url: rt.href } : null },
    annotations: rt.annotations
  }))
}

// Rebuilds a fetched block (with API-only fields like `id`/`created_time`)
// into a payload `blocks.children.append` will accept. Only handles the
// simple rich_text-bearing block types found under template placeholders;
// anything else is dropped (caller is expected to warn).
function toAppendablePayload (block) {
  if (!SIMPLE_RICH_TEXT_BLOCK_TYPES.has(block.type)) return null
  const payload = {
    object: 'block',
    type: block.type,
    [block.type]: { rich_text: sanitizeRichText(block[block.type]?.rich_text) }
  }
  return payload
}

// Applies one template segment to one target page. `pageBlocks` is the
// page's own top-level content (already fetched). Returns a result record
// describing what happened; never throws for expected/handled cases. With
// `dryRun`, no write calls are made - the result still says what *would*
// happen, prefixed "would-".
export async function reapplySegment (notion, { targetPageId, templateId, segment, pageBlocks, dryRun = false }) {
  const existingHeader = matchHeaderOnPage(pageBlocks, segment)
  const label = action => (dryRun ? `would-${action}` : action)

  if (segment.kind === 'text') {
    if (existingHeader) {
      return { header: segment.headerText, action: 'kept-existing' }
    }
    if (!dryRun) {
      const children = [toAppendablePayload(segment.templateBlock), ...segment.trailingBlocks.map(toAppendablePayload)].filter(Boolean)
      await notion.blocks.children.append({ block_id: targetPageId, children })
    }
    return { header: segment.headerText, action: label('added-header') }
  }

  // segment.kind === 'view'
  if (existingHeader) {
    const childDbBlock = findChildDatabaseBlock(existingHeader)
    if (childDbBlock) {
      const existingViews = await notion.views.list({ database_id: childDbBlock.id })
      const results = []
      for (let i = 0; i < segment.views.length; i++) {
        const templateView = segment.views[i]
        const targetViewRef = existingViews.results[i]
        if (targetViewRef) {
          if (!dryRun) {
            await notion.views.update({
              view_id: targetViewRef.id,
              name: templateView.name,
              filter: substituteSelfReferences(templateView.filter, templateId, targetPageId),
              sorts: templateView.sorts,
              quick_filters: substituteSelfReferences(templateView.quick_filters, templateId, targetPageId),
              configuration: templateView.configuration
            })
          }
          results.push(label('updated-view'))
        } else {
          if (!dryRun) {
            await notion.views.create({
              data_source_id: templateView.data_source_id,
              name: templateView.name,
              type: templateView.type,
              database_id: childDbBlock.id,
              filter: substituteSelfReferences(templateView.filter, templateId, targetPageId),
              sorts: templateView.sorts,
              quick_filters: substituteSelfReferences(templateView.quick_filters, templateId, targetPageId),
              configuration: templateView.configuration
            })
          }
          results.push(label('added-extra-view'))
        }
      }
      return { header: segment.headerText, action: results.join('+') }
    }
    // Header exists but its linked view was deleted - recreate the view as a
    // flat sibling right after the header (see recreate-flat note below).
    return recreateViewFlat(notion, { targetPageId, templateId, segment, afterBlockId: existingHeader.id, headerAlreadyExists: true, dryRun })
  }

  // Header missing entirely: create it, then the view(s) flat right after it.
  // The API can only place a new linked view as a direct child of the page,
  // never nested inside a (freshly created) toggle - so this can't reproduce
  // the collapsible toggle+view look the template has; it's reported as a
  // "recreated-flat" compromise instead.
  if (dryRun) {
    return recreateViewFlat(notion, { targetPageId, templateId, segment, afterBlockId: null, headerAlreadyExists: false, dryRun })
  }
  const toggleResult = await notion.blocks.children.append({
    block_id: targetPageId,
    children: [{ object: 'block', type: 'toggle', toggle: { rich_text: sanitizeRichText(segment.templateBlock.toggle?.rich_text) } }]
  })
  const newToggleId = toggleResult.results[0].id
  return recreateViewFlat(notion, { targetPageId, templateId, segment, afterBlockId: newToggleId, headerAlreadyExists: false, dryRun })
}

async function recreateViewFlat (notion, { targetPageId, templateId, segment, afterBlockId, headerAlreadyExists, dryRun }) {
  if (!dryRun) {
    let positionAfter = afterBlockId
    for (const templateView of segment.views) {
      const created = await notion.views.create({
        data_source_id: templateView.data_source_id,
        name: templateView.name,
        type: templateView.type,
        create_database: {
          parent: { type: 'page_id', page_id: targetPageId },
          position: { type: 'after_block', block_id: positionAfter }
        },
        filter: substituteSelfReferences(templateView.filter, templateId, targetPageId),
        sorts: templateView.sorts,
        quick_filters: substituteSelfReferences(templateView.quick_filters, templateId, targetPageId),
        configuration: templateView.configuration
      })
      positionAfter = created.parent.database_id
    }
  }
  return {
    header: segment.headerText,
    action: dryRun
      ? (headerAlreadyExists ? 'would-recreate-view-flat' : 'would-recreate-section-flat')
      : (headerAlreadyExists ? 'recreated-view-flat' : 'recreated-section-flat')
  }
}

// ---------------------------------
// Property reapply: for each non-empty property on the template page, write
// its value onto the target page, unconditionally overwriting whatever's
// there. Opt-in and meant to be used sparingly (see README) - most property
// types found in these templates (relation/rich_text/select/status/
// multi_select/date/number/url/email/phone_number/people) are supported;
// anything else (formula, rollup, computed, files, checkbox) is skipped,
// since it's either read-only or too ambiguous to treat "empty" safely.

const UNWRITABLE_PROPERTY_TYPES = new Set([
  'formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by',
  'unique_id', 'verification', 'button', 'checkbox', 'files', 'title'
])

function isNonEmptyPropertyValue (property) {
  switch (property.type) {
    case 'relation': return property.relation.length > 0
    case 'people': return property.people.length > 0
    case 'multi_select': return property.multi_select.length > 0
    case 'rich_text': return richTextToPlainText(property.rich_text).trim() !== ''
    case 'select': return property.select != null
    case 'status': return property.status != null
    case 'date': return property.date != null
    case 'number': return property.number != null
    case 'url': return !!property.url
    case 'email': return !!property.email
    case 'phone_number': return !!property.phone_number
    default: return false
  }
}

function toWritableValue (property) {
  switch (property.type) {
    case 'relation': return { relation: property.relation.map(r => ({ id: r.id })) }
    case 'people': return { people: property.people.map(p => ({ id: p.id })) }
    case 'multi_select': return { multi_select: property.multi_select.map(o => ({ name: o.name })) }
    case 'rich_text': return { rich_text: sanitizeRichText(property.rich_text) }
    case 'select': return { select: { name: property.select.name } }
    case 'status': return { status: { name: property.status.name } }
    case 'date': return { date: property.date }
    case 'number': return { number: property.number }
    case 'url': return { url: property.url }
    case 'email': return { email: property.email }
    case 'phone_number': return { phone_number: property.phone_number }
    default: return null
  }
}

// Returns the {propertyName: writableValue} patch to apply, given the
// template page's properties. Empty object if nothing qualifies.
export function buildPropertyPatch (templateProperties) {
  const patch = {}
  for (const [name, property] of Object.entries(templateProperties)) {
    if (UNWRITABLE_PROPERTY_TYPES.has(property.type)) continue
    if (!isNonEmptyPropertyValue(property)) continue
    const value = toWritableValue(property)
    if (value) patch[name] = value
  }
  return patch
}

// ---------------------------------
// Reapplies every segment of a resolved template to one target page.
// `includeProperties` triggers the (overwriting) property patch too.
export async function reapplyTemplateToPage (notion, { page, templateId, templateProperties, segments, includeProperties, dryRun = false }) {
  const pageBlocks = await fetchPageContentTree(notion, page.id)
  const segmentResults = []
  for (const segment of segments) {
    try {
      segmentResults.push(await reapplySegment(notion, { targetPageId: page.id, templateId, segment, pageBlocks, dryRun }))
    } catch (error) {
      segmentResults.push({ header: segment.headerText, action: 'error', error: error.message })
    }
  }

  let propertyChanges = null
  if (includeProperties) {
    const patch = buildPropertyPatch(templateProperties)
    if (Object.keys(patch).length > 0) {
      if (!dryRun) {
        await notion.pages.update({ page_id: page.id, properties: patch })
      }
      propertyChanges = Object.keys(patch)
    }
  }

  return { pageId: page.id, title: getTitleText(page), segmentResults, propertyChanges }
}
