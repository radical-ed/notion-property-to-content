import {
  fetchBlockChildren,
  fetchPageContentTree,
  blockTreeToPlainText,
  getTitleText,
  richTextToPlainText,
  appendBlocksRecursive,
  fetchDatabasePages,
  diffProperties,
  SKIPPED_PROPERTY_TYPES
} from './notion.js'
import { uploadImageToNotion } from './notion-blocks.js'

const ARCHIVED_PREFIX = '[archived] '

const FILE_LIKE_BLOCK_TYPES = new Set(['image', 'file', 'pdf', 'video', 'audio'])

// Block types that reference something local to the source workspace (a
// synced-block source, a workspace-relative alias, etc.) with no meaningful
// equivalent in a different Notion account - dropped rather than copied.
const SKIPPED_BLOCK_TYPES = new Set(['synced_block', 'ai_block', 'unsupported', 'template', 'breadcrumb', 'link_to_page'])

// Property types that can't be created via the API at all (`status`), or
// whose values identify something specific to the source workspace/account
// that has no equivalent on the other side (source-workspace user ids for
// `people`, Notion-hosted file references for `files`) - on top of
// `SKIPPED_PROPERTY_TYPES` (relation/rollup/formula/computed), which is
// reused as-is since it already identifies non-portable-across-databases
// property types for the same underlying reason.
const NON_CREATABLE_PROPERTY_TYPES = new Set(['status', 'people', 'files'])

// Notion block-content limits: a single rich_text run's text content maxes
// out at 2000 chars, and a block's whole rich_text array maxes out at 100
// items - either one being exceeded fails the block outright.
const MAX_TEXT_RUN_LENGTH = 2000
const MAX_RICH_TEXT_ITEMS = 100

// Common Notion-uploadable file extensions the File Upload API expects,
// keyed by content-type - used to fix up a filename that's missing or has
// the wrong extension (common with files exported from other tools), rather
// than letting a perfectly valid file fail on a technicality.
const EXTENSION_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'text/plain': 'txt'
}

// ---------------------------------
// Finds the direct children of the root archive page and classifies each as
// a page (`child_page`), a database (`child_database`), or unsupported
// (anything else living directly under root isn't an archive unit). A
// child already titled with the archived marker is flagged so a re-run
// against a partially-processed root skips what's already done.
export async function discoverArchiveTargets (notion, rootPageId) {
  const children = await fetchBlockChildren(notion, rootPageId)

  return children.map(block => {
    if (block.type === 'child_page') {
      return { type: 'page', blockId: block.id, title: block.child_page.title, alreadyArchived: block.child_page.title.startsWith(ARCHIVED_PREFIX) }
    }
    if (block.type === 'child_database') {
      return { type: 'database', blockId: block.id, title: block.child_database.title, alreadyArchived: block.child_database.title.startsWith(ARCHIVED_PREFIX) }
    }
    return { type: 'skip', blockId: block.id, title: `(${block.type} block, not a page)`, alreadyArchived: false }
  })
}

// ---------------------------------
// Copies, validates and (unless `dryRun`) archives every actionable target.
// Returns one result per target: { target, status: 'ok'|'skipped'|'failed', ... }.
// `onResult`, if given, fires with each result as soon as its target
// finishes, so a caller can report/log progress live rather than waiting
// for the whole (potentially long) run to end.
export async function processTargets (ctx, targets, { sourceRootId, destinationParentId, dryRun, onResult }) {
  ctx.rootPageId = sourceRootId
  ctx.pageMap = new Map()
  ctx.databaseMap = new Map()
  // Copying already fetches the exact page/row object validation needs
  // (title, icon, cover) - cached here so validateCopy can reuse it instead
  // of a redundant re-fetch of something that can't have changed since (the
  // source isn't touched until stubSourcePage, which runs after validation).
  ctx.sourcePageCache = new Map()

  const results = []
  const record = (result) => {
    results.push(result)
    onResult?.(result)
  }

  for (const target of targets) {
    if (target.type === 'skip') {
      record({ target, status: 'skipped', reason: 'not a page or database', warnings: [] })
      continue
    }
    if (target.alreadyArchived) {
      record({ target, status: 'skipped', reason: 'already archived', warnings: [] })
      continue
    }

    ctx.warnings = []
    ctx.currentSourcePageId = target.blockId

    try {
      const destObject = target.type === 'page'
        ? await copyPage(ctx, target.blockId, destinationParentId)
        : await copyDatabase(ctx, target.blockId, destinationParentId)

      const validation = target.type === 'page'
        ? await validateCopy(ctx, target.blockId, destObject.id)
        : await validateDatabaseCopy(ctx, target.blockId, destObject.id)

      if (!validation.ok) {
        record({ target, status: 'failed', reason: `validation failed: ${validation.issues.join('; ')}`, warnings: ctx.warnings })
        continue
      }

      if (!dryRun) {
        await stubSourcePage(ctx, target, destObject.url)
      }

      record({ target, status: 'ok', destUrl: destObject.url, warnings: ctx.warnings })
    } catch (error) {
      record({ target, status: 'failed', reason: error.message, warnings: ctx.warnings })
    }
  }

  return results
}

// ---------------------------------------------------------------- copying

async function copyPage (ctx, sourcePageId, destParentId) {
  const sourcePage = await ctx.sourceNotion.pages.retrieve({ page_id: sourcePageId })
  ctx.sourcePageCache.set(sourcePageId, sourcePage)
  const title = getTitleText(sourcePage)

  const destPage = await ctx.destNotion.pages.create({
    parent: { page_id: destParentId },
    properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
    icon: sanitizeIconOrCover(ctx, sourcePage.icon, sourcePageId, 'icon'),
    cover: sanitizeIconOrCover(ctx, sourcePage.cover, sourcePageId, 'cover')
  })

  ctx.currentSourcePageId = sourcePageId
  await copyBlockChildren(ctx, sourcePageId, destPage.id)
  ctx.pageMap.set(sourcePageId, destPage.id)
  return destPage
}

// Copies one level of children, preserving source order across the
// block/page boundary: ordinary blocks are batched via appendBlocksRecursive,
// but a page can only be created via pages.create (not as an appended
// block), so a run of ordinary blocks is flushed right before each
// child_page/child_database is created, rather than deferring all page
// creation to the end (which would silently reorder content relative to
// the source and break the plain-text validation diff).
async function copyBlockChildren (ctx, sourceParentId, destParentId) {
  const blocks = await fetchBlockChildren(ctx.sourceNotion, sourceParentId)
  let pending = []

  const flush = async () => {
    if (pending.length === 0) return
    await appendBlocksRecursive(ctx.destNotion, destParentId, pending, {
      onBlockError: (node, error) => ctx.warnings.push({ pageId: sourceParentId, type: node.payload.type, reason: `block rejected by destination, skipped: ${error.message}` })
    })
    pending = []
  }

  for (const block of blocks) {
    ctx.currentSourcePageId = sourceParentId

    // A nested page/database that fails must not take its whole container
    // down with it - without this, one unreadable database three levels
    // deep silently drops every sibling block in the page around it (the
    // rest of the page never even gets attempted, since the exception
    // propagates all the way up to the top-level target). Isolated here the
    // same way a bad database row is already isolated in copyDatabase.
    if (block.type === 'child_page') {
      await flush()
      try {
        await copyPage(ctx, block.id, destParentId)
      } catch (error) {
        ctx.warnings.push({ pageId: sourceParentId, blockId: block.id, type: 'child_page', reason: `nested page "${block.child_page?.title ?? block.id}" failed to copy, skipped so the rest of this page isn't lost: ${error.message}` })
      }
    } else if (block.type === 'child_database') {
      await flush()
      try {
        await copyDatabase(ctx, block.id, destParentId)
      } catch (error) {
        ctx.warnings.push({ pageId: sourceParentId, blockId: block.id, type: 'child_database', reason: `nested database "${block.child_database?.title ?? block.id}" failed to copy, skipped so the rest of this page isn't lost: ${error.message}` })
      }
    } else if (SKIPPED_BLOCK_TYPES.has(block.type)) {
      ctx.warnings.push({ pageId: sourceParentId, blockId: block.id, type: block.type, reason: 'unsupported block type, skipped' })
    } else {
      const nodes = await convertBlock(ctx, block)
      pending.push(...nodes)
    }
  }

  await flush()
}

// Returns an array of nodes (usually one) - a block whose rich_text
// exceeds Notion's 100-item cap after sanitizing is split across multiple
// sibling blocks of the same type, since the API rejects the block outright
// otherwise. Any node with children attaches them to the very last sibling
// so nested content isn't duplicated across the split-out fragments.
async function convertBlock (ctx, block) {
  if (FILE_LIKE_BLOCK_TYPES.has(block.type)) {
    const node = await convertFileBlock(ctx, block)
    return node ? [node] : []
  }

  const typeData = sanitizeTypeData(ctx, block[block.type])

  // bookmark/embed carry a bare url (not text.link like a rich_text run,
  // and not typeData.external.url like an image/file) - same
  // rejected-on-write risk, same fallback: keep the URL visible as plain
  // text rather than lose the whole block.
  if ((block.type === 'bookmark' || block.type === 'embed') && !isValidNotionUrl(typeData.url)) {
    ctx.warnings.push({ pageId: ctx.currentSourcePageId, blockId: block.id, type: block.type, reason: `${block.type} URL "${typeData.url}" was rejected as invalid by Notion - converted to a plain-text paragraph instead of losing it` })
    return [{ payload: urlFallbackParagraph(typeData.url, typeData.caption), children: [] }]
  }

  const children = block.has_children ? await convertChildBlocks(ctx, block.id) : []

  if (Array.isArray(typeData?.rich_text) && typeData.rich_text.length > MAX_RICH_TEXT_ITEMS) {
    const chunks = chunkArray(typeData.rich_text, MAX_RICH_TEXT_ITEMS)
    ctx.warnings.push({ pageId: ctx.currentSourcePageId, blockId: block.id, type: block.type, reason: `rich_text had ${typeData.rich_text.length} items (Notion's cap is ${MAX_RICH_TEXT_ITEMS}); split into ${chunks.length} sibling "${block.type}" blocks` })
    return chunks.map((chunk, i) => ({
      payload: { object: 'block', type: block.type, [block.type]: { ...typeData, rich_text: chunk } },
      children: i === chunks.length - 1 ? children : []
    }))
  }

  return [{ payload: { object: 'block', type: block.type, [block.type]: typeData }, children }]
}

function chunkArray (array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size))
  return chunks
}

// Recurses into a non-page block's own children. child_page/child_database
// found here (nested inside e.g. a toggle, rather than directly under a
// page) aren't supported - creating them would need the destination block
// id for a not-yet-created parent, which appendBlocksRecursive doesn't
// expose. Rare in practice; skipped with a warning instead.
async function convertChildBlocks (ctx, parentBlockId) {
  const blocks = await fetchBlockChildren(ctx.sourceNotion, parentBlockId)
  const nodes = []

  for (const block of blocks) {
    if (block.type === 'child_page' || block.type === 'child_database') {
      ctx.warnings.push({ pageId: ctx.currentSourcePageId, blockId: block.id, type: block.type, reason: 'nested page/database inside a non-page block is not supported, skipped' })
      continue
    }
    if (SKIPPED_BLOCK_TYPES.has(block.type)) {
      ctx.warnings.push({ pageId: ctx.currentSourcePageId, blockId: block.id, type: block.type, reason: 'unsupported block type, skipped' })
      continue
    }
    nodes.push(...await convertBlock(ctx, block))
  }

  return nodes
}

// Strips a block's type-specific data down to what pages.create /
// blocks.children.append accept, sanitizing any rich_text run (including
// table_row cells and captions) for cross-workspace mentions along the way.
function sanitizeTypeData (ctx, typeData) {
  if (!typeData || typeof typeData !== 'object') return typeData

  const result = {}
  for (const [key, value] of Object.entries(typeData)) {
    if (key === 'rich_text' && Array.isArray(value)) {
      // A too-long rich_text array here gets split into sibling blocks by
      // the caller (convertBlock) - it needs the post-sanitize length, so
      // this only sanitizes/splits individual runs, not the array itself.
      result[key] = sanitizeRichText(ctx, value)
    } else if (key === 'caption' && Array.isArray(value)) {
      result[key] = capRichTextItems(ctx, sanitizeRichText(ctx, value), 'caption')
    } else if (key === 'cells' && Array.isArray(value)) {
      result[key] = value.map(cell => capRichTextItems(ctx, sanitizeRichText(ctx, cell), 'table cell'))
    } else if (key === 'icon') {
      // Most blocks carry `icon: null` even when the type doesn't render one;
      // the create API rejects an explicit `null` (wants an object or the key
      // omitted entirely), so this can't just pass through like other fields.
      const sanitized = sanitizeIconOrCover(ctx, value, ctx.currentSourcePageId, 'icon')
      if (sanitized !== undefined) result[key] = sanitized
    } else {
      result[key] = value
    }
  }
  return result
}

// Notion's write API validates link/media URLs more strictly than however
// this content originally got into Notion a year+ ago (a bulk importer
// likely went through a different, more lenient ingestion path) - so a URL
// that's sat here fine ever since can still be rejected on write today.
// Rather than lose the block, anything that fails this check gets its link
// stripped (rich text) or gets downgraded to a plain-text paragraph with the
// raw URL visible (media/bookmark blocks) - never dropped outright.
const VALID_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])
function isValidNotionUrl (url) {
  if (!url || typeof url !== 'string') return false
  try {
    return VALID_LINK_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

function sanitizeTextLink (ctx, text) {
  if (!text.link?.url || isValidNotionUrl(text.link.url)) return text
  ctx.warnings.push({ pageId: ctx.currentSourcePageId, type: 'invalid-link', reason: `link URL "${text.link.url}" was rejected as invalid by Notion - kept the text, dropped the link` })
  return { content: text.content }
}

// User/page/database mentions reference ids specific to the source
// workspace/account and won't resolve in the destination - downgraded to
// plain text of their rendered label instead so the block still creates
// successfully. Date mentions aren't workspace-identity-bound and pass
// through unchanged. Any text run over Notion's 2000-char-per-run cap is
// split into multiple consecutive runs (same annotations/link), since the
// cap is per-run, not per-block - this only ever grows the array, so it
// runs before the 100-item block-split decision in convertBlock.
function sanitizeRichText (ctx, richText) {
  return richText.flatMap(run => {
    if (run.type === 'mention' && run.mention.type !== 'date') {
      ctx.warnings.push({ pageId: ctx.currentSourcePageId, type: `mention:${run.mention.type}`, reason: `${run.mention.type} mention converted to plain text ("${run.plain_text}")` })
      return splitTextRun({ type: 'text', text: { content: run.plain_text }, annotations: run.annotations })
    }
    if (run.type === 'equation') {
      return [{ type: 'equation', equation: run.equation, annotations: run.annotations }]
    }
    if (run.type === 'mention') {
      return [{ type: 'mention', mention: run.mention, annotations: run.annotations }]
    }
    return splitTextRun({ type: 'text', text: sanitizeTextLink(ctx, run.text), annotations: run.annotations })
  })
}

function splitTextRun (run) {
  if (run.text.content.length <= MAX_TEXT_RUN_LENGTH) return [run]
  const chunks = []
  for (let i = 0; i < run.text.content.length; i += MAX_TEXT_RUN_LENGTH) {
    chunks.push({ type: 'text', text: { content: run.text.content.slice(i, i + MAX_TEXT_RUN_LENGTH), link: run.text.link }, annotations: run.annotations })
  }
  return chunks
}

// caption/cells can't be split across sibling blocks the way a block's own
// rich_text can (a caption belongs to one block; a table cell can't spill
// into another row), so on the rare case one still exceeds the 100-item cap
// after run-splitting, truncate with a warning rather than fail the block.
function capRichTextItems (ctx, richText, label) {
  if (richText.length <= MAX_RICH_TEXT_ITEMS) return richText
  ctx.warnings.push({ pageId: ctx.currentSourcePageId, type: label, reason: `${label} had ${richText.length} rich_text items (Notion's cap is ${MAX_RICH_TEXT_ITEMS}); truncated` })
  return richText.slice(0, MAX_RICH_TEXT_ITEMS)
}

// Only `emoji`/`external` icons and `external` covers are settable via
// pages.create/databases.create - a `file` (Notion-hosted upload) or
// `custom_emoji` (workspace-specific) icon/cover has no destination
// equivalent and would otherwise make the create call fail outright.
function sanitizeIconOrCover (ctx, value, sourceId, kind) {
  if (!value) return undefined
  if (value.type === 'emoji' || value.type === 'external') return value
  ctx.warnings.push({ pageId: sourceId, type: kind, reason: `${kind} of type "${value.type}" not portable across accounts, dropped` })
  return undefined
}

// This is a backup: the goal is that nothing gets silently dropped, even
// when it can't be migrated in its original form. An external image/file
// whose URL Notion's write API rejects becomes a plain-text paragraph with
// the raw URL instead of a real image block; a Notion-hosted file that
// can't be downloaded/reuploaded (broken/expired signed URL, unsupported
// extension, etc.) becomes a plain-text paragraph noting what was there
// instead of vanishing with only a log line to show for it.
async function convertFileBlock (ctx, block) {
  const typeData = block[block.type]

  if (typeData.type === 'external') {
    if (!isValidNotionUrl(typeData.external.url)) {
      ctx.warnings.push({ pageId: ctx.currentSourcePageId, blockId: block.id, type: block.type, reason: `external ${block.type} URL "${typeData.external.url}" was rejected as invalid by Notion - converted to a plain-text paragraph instead of losing it` })
      return { payload: urlFallbackParagraph(typeData.external.url, typeData.caption), children: [] }
    }
    return {
      payload: { object: 'block', type: block.type, [block.type]: { type: 'external', external: typeData.external, caption: sanitizeRichText(ctx, typeData.caption ?? []) } },
      children: []
    }
  }

  try {
    const fileTypeData = await downloadAndUploadFile(ctx, block, typeData)
    return {
      payload: { object: 'block', type: block.type, [block.type]: fileTypeData },
      children: []
    }
  } catch (error) {
    ctx.warnings.push({ pageId: ctx.currentSourcePageId, blockId: block.id, type: block.type, reason: `failed to copy file, kept as a text reference instead: ${error.message}` })
    const label = richTextToPlainText(typeData.caption) || `(${block.type} attachment could not be migrated: ${error.message})`
    return { payload: urlFallbackParagraph(null, typeData.caption, label), children: [] }
  }
}

// Notion's signed file URLs are short-lived; if enough time passed between
// fetching this block and reaching it here (a big page/database can take a
// while), the download can 403 on an otherwise-fine file. One re-fetch of
// the block for a fresh signed URL, then one retry, resolves that case
// without needing to fetch the whole tree freshly up front.
async function downloadAndUploadFile (ctx, block, typeData) {
  let url = typeData.file.url
  let response = await fetch(url)
  if (!response.ok && response.status === 403) {
    const fresh = await ctx.sourceNotion.blocks.retrieve({ block_id: block.id })
    url = fresh[block.type]?.file?.url ?? url
    response = await fetch(url)
  }
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)

  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const filename = guessFilename(block, typeData, contentType)
  const fileUploadId = await uploadImageToNotion(ctx.destNotion, buffer, filename, contentType)
  return { type: 'file_upload', file_upload: { id: fileUploadId }, caption: sanitizeRichText(ctx, typeData.caption ?? []) }
}

function urlFallbackParagraph (url, caption, fallbackLabel) {
  const captionText = richTextToPlainText(caption)
  const content = url ? (captionText ? `${captionText}: ${url}` : url) : (fallbackLabel ?? captionText ?? 'attachment could not be migrated')
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: content.slice(0, MAX_TEXT_RUN_LENGTH) } }] } }
}

// The File Upload API rejects unrecognized/missing extensions outright even
// when the underlying bytes are a perfectly ordinary file - a name derived
// from a caption or a source URL's last path segment often lacks one, or
// has the wrong one (common with exports from other tools). If the actual
// content-type maps to a known extension the guessed name doesn't already
// have, append/fix it rather than let a valid file fail on a technicality.
function guessFilename (block, typeData, contentType) {
  const caption = richTextToPlainText(typeData.caption)
  let base = caption
  if (!base) {
    try {
      base = decodeURIComponent(new URL(typeData.file.url).pathname.split('/').pop())
    } catch {
      // fall through to the generic name below
    }
  }
  if (!base) base = `${block.type}-${block.id}`

  const expectedExt = EXTENSION_BY_CONTENT_TYPE[contentType?.split(';')[0].trim()]
  if (expectedExt && !base.toLowerCase().endsWith(`.${expectedExt}`)) {
    base = `${base}.${expectedExt}`
  }
  return base
}

// -------------------------------------------------------------- databases

async function copyDatabase (ctx, sourceDatabaseId, destParentPageId) {
  ctx.currentSourcePageId = sourceDatabaseId
  const database = await ctx.sourceNotion.databases.retrieve({ database_id: sourceDatabaseId })

  // Reuses `database` (already fetched above) instead of getDataSourceId's
  // own internal databases.retrieve() call - same data, one less API call.
  // A database with 0 data sources here is a genuine, observed Notion-side
  // state (confirmed directly against the API, not a bug in this script) -
  // seen so far only on databases old enough to predate the Sept-2025 data
  // source model, whose data source was apparently never backfilled. There
  // is no working fallback read path (blocks.children.list on the database
  // id returns nothing either) - the database's schema/rows are genuinely
  // unreadable through today's API, so this specific database is skipped;
  // the caller (copyBlockChildren) isolates that failure so it doesn't take
  // down whatever page it's nested in.
  const sourceDataSources = database.data_sources ?? []
  if (sourceDataSources.length !== 1) {
    throw new Error(`has ${sourceDataSources.length} data source(s), expected 1 - Notion's API reports no readable schema/rows for this database (seen before on databases that predate the Sept-2025 data source model); nothing this script can do but skip it - check it directly in Notion`)
  }
  const dataSourceId = sourceDataSources[0].id
  const dataSource = await ctx.sourceNotion.dataSources.retrieve({ data_source_id: dataSourceId })

  const { properties: destProperties, droppedKeys } = filterSchemaProperties(dataSource.properties)
  for (const key of droppedKeys) {
    ctx.warnings.push({ pageId: sourceDatabaseId, type: 'database-property', reason: `property "${key}" not portable across accounts, dropped from destination schema` })
  }

  // NOTE: as of API version 2025-09-03, databases.create() has no top-level
  // `properties` field - the SDK's request body whitelist for this endpoint
  // is parent/title/description/is_inline/initial_data_source/icon/cover, so
  // a top-level `properties` is silently stripped client-side before the
  // request is even sent. Schema must go under `initial_data_source`.
  const destDatabase = await ctx.destNotion.databases.create({
    parent: { type: 'page_id', page_id: destParentPageId },
    title: sanitizeRichText(ctx, database.title),
    icon: sanitizeIconOrCover(ctx, database.icon, sourceDatabaseId, 'icon'),
    cover: sanitizeIconOrCover(ctx, database.cover, sourceDatabaseId, 'cover'),
    initial_data_source: { properties: destProperties }
  })
  const destDataSources = destDatabase.data_sources ?? []
  if (destDataSources.length !== 1) {
    throw new Error(`Newly created destination database ${destDatabase.id} has ${destDataSources.length} data source(s); expected exactly 1`)
  }
  const destDataSourceId = destDataSources[0].id

  const rows = await fetchDatabasePages(ctx.sourceNotion, sourceDatabaseId)
  const rowMap = new Map()
  for (const row of rows) {
    ctx.currentSourcePageId = row.id
    try {
      const destRow = await copyDatabaseRow(ctx, row, destDataSourceId, destProperties)
      rowMap.set(row.id, destRow.id)
    } catch (error) {
      ctx.warnings.push({ pageId: row.id, type: 'database-row', reason: `failed to copy row "${getTitleText(row)}": ${error.message}` })
    }
  }

  ctx.databaseMap.set(sourceDatabaseId, { destDatabaseId: destDatabase.id, destDataSourceId, rowMap, sourceRows: rows })
  return destDatabase
}

function filterSchemaProperties (properties) {
  const destProperties = {}
  const droppedKeys = []

  for (const [key, prop] of Object.entries(properties)) {
    if (prop.type === 'title') {
      destProperties[key] = { title: {} }
      continue
    }
    if (SKIPPED_PROPERTY_TYPES.has(prop.type) || NON_CREATABLE_PROPERTY_TYPES.has(prop.type)) {
      droppedKeys.push(key)
      continue
    }
    destProperties[key] = stripPropertySchema(prop)
  }

  return { properties: destProperties, droppedKeys }
}

function stripPropertySchema (prop) {
  const config = prop[prop.type] ?? {}
  if (Array.isArray(config.options)) {
    return { type: prop.type, [prop.type]: { options: config.options.map(({ id, ...rest }) => rest) } }
  }
  return { type: prop.type, [prop.type]: config }
}

async function copyDatabaseRow (ctx, row, destDataSourceId, destProperties) {
  const properties = {}
  ctx.currentSourcePageId = row.id
  ctx.sourcePageCache.set(row.id, row)
  for (const [key, value] of Object.entries(row.properties)) {
    // Filter by what's actually in the created destination schema, not by
    // the drop-list used to build it - keeps this correct even if the two
    // ever drift (e.g. a property the API silently declined to create).
    if (!(key in destProperties)) continue
    const mapped = mapPropertyValueForCreate(ctx, value)
    if (mapped !== undefined) properties[key] = mapped
  }

  const destRow = await ctx.destNotion.pages.create({
    parent: { type: 'data_source_id', data_source_id: destDataSourceId },
    properties,
    icon: sanitizeIconOrCover(ctx, row.icon, row.id, 'icon'),
    cover: sanitizeIconOrCover(ctx, row.cover, row.id, 'cover')
  })

  await copyBlockChildren(ctx, row.id, destRow.id)
  ctx.pageMap.set(row.id, destRow.id)
  return destRow
}

function mapPropertyValueForCreate (ctx, prop) {
  switch (prop.type) {
    case 'title':
      return { title: sanitizeRichText(ctx, prop.title) }
    case 'rich_text':
      return { rich_text: sanitizeRichText(ctx, prop.rich_text) }
    case 'number':
      return { number: prop.number }
    case 'checkbox':
      return { checkbox: prop.checkbox }
    case 'select':
      return { select: prop.select ? { name: prop.select.name } : null }
    case 'multi_select':
      return { multi_select: prop.multi_select.map(o => ({ name: o.name })) }
    case 'date':
      return { date: prop.date }
    case 'url':
      return { url: prop.url }
    case 'email':
      return { email: prop.email }
    case 'phone_number':
      return { phone_number: prop.phone_number }
    default:
      return undefined // unhandled/dropped type - already excluded from destProperties, nothing to send
  }
}

// -------------------------------------------------------------- validation

// Compares title and a plain-text rendering of the block tree (source tree
// filtered to drop anything this run's warnings already recorded as
// intentionally skipped, so a known/logged gap isn't reported as a
// validation failure) against what actually landed in the destination.
async function validateCopy (ctx, sourcePageId, destPageId) {
  const issues = []

  // sourcePage was already fetched (and cached) by whichever of
  // copyPage/copyDatabaseRow produced this target - reuse it instead of
  // asking the API for the exact same object again.
  const [sourcePage, destPage] = await Promise.all([
    ctx.sourcePageCache.get(sourcePageId) ?? ctx.sourceNotion.pages.retrieve({ page_id: sourcePageId }),
    ctx.destNotion.pages.retrieve({ page_id: destPageId })
  ])
  const sourceTitle = getTitleText(sourcePage)
  const destTitle = getTitleText(destPage)
  if (sourceTitle !== destTitle) {
    issues.push(`title mismatch: "${sourceTitle}" vs "${destTitle}"`)
  }

  const [sourceTree, destTree] = await Promise.all([
    fetchPageContentTree(ctx.sourceNotion, sourcePageId),
    fetchPageContentTree(ctx.destNotion, destPageId)
  ])

  const skippedBlockIds = new Set(ctx.warnings.filter(w => w.blockId).map(w => w.blockId))
  const sourceText = blockTreeToPlainText(filterSkippedBlocks(sourceTree, skippedBlockIds))
  const destText = blockTreeToPlainText(destTree)
  if (sourceText !== destText) {
    issues.push('content mismatch after accounting for known skips (see warnings)')
  }

  return { ok: issues.length === 0, issues }
}

function filterSkippedBlocks (blocks, skippedBlockIds) {
  return blocks
    .filter(block => !skippedBlockIds.has(block.id))
    .map(block => block.children ? { ...block, children: filterSkippedBlocks(block.children, skippedBlockIds) } : block)
}

async function validateDatabaseCopy (ctx, sourceDatabaseId, destDatabaseId) {
  // Reuses the row list copyDatabase already fetched - it can't have
  // changed since (the source isn't touched until stubSourcePage, which
  // runs after validation), so re-querying it here would be pure waste.
  const { rowMap, sourceRows } = ctx.databaseMap.get(sourceDatabaseId)
  const issues = []

  if (sourceRows.length !== rowMap.size) {
    issues.push(`row count mismatch: ${sourceRows.length} source row(s), ${rowMap.size} copied`)
  }

  for (const sourceRow of sourceRows) {
    const destRowId = rowMap.get(sourceRow.id)
    const rowTitle = getTitleText(sourceRow)
    if (!destRowId) {
      issues.push(`row "${rowTitle}" was not copied`)
      continue
    }

    const destRow = await ctx.destNotion.pages.retrieve({ page_id: destRowId })
    // Only compare properties that exist on both sides - keys dropped from
    // the destination schema (see filterSchemaProperties) are an intentional,
    // already-logged scope decision, not a copy bug.
    const comparableSourceProps = Object.fromEntries(Object.entries(sourceRow.properties).filter(([key]) => key in destRow.properties))
    const diffs = diffProperties(comparableSourceProps, destRow.properties)
    if (diffs.length > 0) {
      issues.push(`row "${rowTitle}": properties differ (${diffs.map(d => d.property).join(', ')})`)
    }

    const rowValidation = await validateCopy(ctx, sourceRow.id, destRowId)
    if (!rowValidation.ok) {
      issues.push(`row "${rowTitle}": ${rowValidation.issues.join('; ')}`)
    }
  }

  return { ok: issues.length === 0, issues }
}

// ----------------------------------------------------------------- stub

function backupLinkParagraph (url) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: 'Archived copy: ' } }, { type: 'text', text: { content: url, link: { url } } }] }
  }
}

// Blanks out the source: archives (trashes) every direct child of the page
// - which, since a page IS a block and sub-pages are children of it,
// cascades to remove the whole nested subtree in one pass - then renames
// the page with the archived marker and leaves one paragraph linking back
// to the copy. A database target has no equivalent "blank but still a
// database" state, so its block is archived outright and a stub *page* is
// created next to it under the root instead.
async function stubSourcePage (ctx, target, destUrl) {
  const notion = ctx.sourceNotion

  if (target.type === 'page') {
    const children = await fetchBlockChildren(notion, target.blockId)
    for (const child of children) {
      await notion.blocks.update({ block_id: child.id, archived: true })
    }
    await notion.pages.update({
      page_id: target.blockId,
      properties: { title: { title: [{ type: 'text', text: { content: `${ARCHIVED_PREFIX}${target.title}` } }] } }
    })
    await notion.blocks.children.append({ block_id: target.blockId, children: [backupLinkParagraph(destUrl)] })
    return
  }

  await notion.blocks.update({ block_id: target.blockId, archived: true })
  await notion.pages.create({
    parent: { page_id: ctx.rootPageId },
    properties: { title: { title: [{ type: 'text', text: { content: `${ARCHIVED_PREFIX}${target.title}` } }] } },
    children: [backupLinkParagraph(destUrl)]
  })
}
