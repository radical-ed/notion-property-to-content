const RICH_TEXT_CHUNK_SIZE = 2000

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
