const RICH_TEXT_CHUNK_SIZE = 2000
const APPEND_BATCH_SIZE = 90

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }

function decodeEntities (str) {
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10)
      return String.fromCodePoint(codePoint)
    }
    return HTML_ENTITIES[entity] ?? match
  })
}

function chunkString (str, maxLen) {
  if (str.length <= maxLen) return [str]
  const chunks = []
  let i = 0
  while (i < str.length) {
    let end = Math.min(i + maxLen, str.length)
    if (end < str.length) {
      const code = str.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1 // don't split a surrogate pair
    }
    chunks.push(str.slice(i, end))
    i = end
  }
  return chunks
}

// Converts Workflowy's `nm`/note fields (light HTML: only <b>/<i> observed in
// practice) into a Notion rich_text array. Unrecognized tags are stripped,
// not preserved as annotations.
export function htmlToRichText (html) {
  if (!html) return []

  const richText = []
  let bold = 0
  let italic = 0
  let lastIndex = 0

  const pushText = (raw) => {
    const decoded = decodeEntities(raw)
    if (!decoded) return
    for (const chunk of chunkString(decoded, RICH_TEXT_CHUNK_SIZE)) {
      richText.push({
        type: 'text',
        text: { content: chunk },
        annotations: {
          bold: bold > 0,
          italic: italic > 0,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default'
        }
      })
    }
  }

  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g
  let match
  while ((match = tagPattern.exec(html)) !== null) {
    pushText(html.slice(lastIndex, match.index))
    const tag = match[1].toLowerCase()
    const closing = match[0].startsWith('</')
    if (tag === 'b' || tag === 'strong') bold += closing ? -1 : 1
    else if (tag === 'i' || tag === 'em') italic += closing ? -1 : 1
    lastIndex = tagPattern.lastIndex
  }
  pushText(html.slice(lastIndex))

  return richText
}

// Three steps: create a file_upload object, send the bytes to it, then
// reference the id in a block. `fileUploads.send` alone completes a
// single-part upload (the default mode, for files under 20MB) - the
// `fileUploads.complete` endpoint is only needed for multi-part uploads.
// See docs/workflowy-to-notion.md for the reference this was validated
// against (originally implemented via raw fetch because the installed
// @notionhq/client predated this API; the client now supports it natively).
export async function uploadImageToNotion (notion, buffer, filename, contentType) {
  const fileUpload = await notion.fileUploads.create({ filename, content_type: contentType })
  await notion.fileUploads.send({
    file_upload_id: fileUpload.id,
    file: { filename, data: new Blob([buffer], { type: contentType }) }
  })
  return fileUpload.id
}

function chunkArray (array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

async function appendWithRetry (notion, blockId, children, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await notion.blocks.children.append({ block_id: blockId, children })
    } catch (error) {
      const isRateLimited = error.status === 429 || error.code === 'rate_limited'
      if (!isRateLimited || attempt === maxAttempts) throw error
      const retryAfterSeconds = Number(error.headers?.['retry-after']) || 1
      await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000))
    }
  }
}

// Appends an arbitrarily-deep block tree to a Notion page/block. Each node
// is { payload, children }, where `payload` is the Notion block object
// *without* a nested `children` key. The current level is always appended
// flat (batched to Notion's 100-child limit), then each returned block id
// is recursed into for its own children - this sidesteps the "2 levels of
// nesting per call" API limit uniformly, without needing to precompute
// subtree depth.
export async function appendBlocksRecursive (notion, parentId, blockTree) {
  for (const batch of chunkArray(blockTree, APPEND_BATCH_SIZE)) {
    const response = await appendWithRetry(notion, parentId, batch.map(node => node.payload))
    await Promise.all(batch.map((node, i) => {
      if (node.children.length === 0) return null
      return appendBlocksRecursive(notion, response.results[i].id, node.children)
    }))
  }
}
