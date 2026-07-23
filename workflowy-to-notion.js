#!/usr/bin/env node

import { createNotionClient } from './lib/notion.js'
import { resolveShare, fetchTree, fetchOwnerId, resolveImageUrl, downloadImage } from './lib/workflowy.js'
import { htmlToRichText, uploadImageToNotion, appendBlocksRecursive } from './lib/notion-blocks.js'

if (process.argv.length < 4) {
  console.error('Usage: node workflowy-to-notion.js <workflowy-share-url> <notion-parent-page-id>')
  process.exit(1)
}

const shareUrl = process.argv[2]
const notionParentPageId = process.argv[3]
const IMAGE_CONCURRENCY = 4

const notion = createNotionClient()
const notionToken = process.env.NOTION_TOKEN

// ------------------------------------------------------------------------------------------------------------------------------

async function withRetry (fn, { attempts = 4, baseDelayMs = 1000 } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt))
    }
  }
  throw lastError
}

async function mapWithConcurrency (items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker () {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function isImageItem (item) {
  return !!item.metadata?.s3File?.isFile
}

function buildImageBlockPayload (fileUploadId) {
  return {
    object: 'block',
    type: 'image',
    image: { type: 'file_upload', file_upload: { id: fileUploadId } }
  }
}

// Converts one Workflowy item (plus its already-converted children) into the
// { payload, children } shape appendBlocksRecursive expects. Items can have
// text AND an attached image at once (Workflowy lets you attach a single
// image directly to a bullet); dedicated "image only" bullets (empty name)
// become bare image blocks instead of a wrapping list item.
function convertItem (item, childItems, fileUploadIds) {
  const text = item.nm || ''
  const hasImage = isImageItem(item)

  if (hasImage && !text.trim()) {
    if (childItems.length > 0) {
      console.warn(`Workflowy item ${item.id} is an image-only bullet but has ${childItems.length} children - dropping them (unexpected tree shape)`)
    }
    return { payload: buildImageBlockPayload(fileUploadIds.get(item.id)), children: [] }
  }

  const childNodes = childItems.map(child => convertItem(child, child.children, fileUploadIds))
  if (hasImage) {
    childNodes.unshift({ payload: buildImageBlockPayload(fileUploadIds.get(item.id)), children: [] })
  }

  const blockType = childNodes.length > 0 ? 'toggle' : 'bulleted_list_item'
  return {
    payload: {
      object: 'block',
      type: blockType,
      [blockType]: { rich_text: htmlToRichText(text) }
    },
    children: childNodes
  }
}

// ------------------------------------------------------------------------------------------------------------------------------

console.info(`Loading Workflowy share: ${shareUrl}`)
const { shareId, cookieHeader } = await resolveShare(shareUrl)

const [items, ownerId] = await Promise.all([
  fetchTree(shareId, cookieHeader),
  fetchOwnerId(shareId, cookieHeader)
])
console.info(`Fetched ${items.length} Workflowy items`)

const itemsById = new Map(items.map(item => [item.id, item]))
const childIdsByParent = new Map()
for (const item of items) {
  if (!childIdsByParent.has(item.prnt)) childIdsByParent.set(item.prnt, [])
  childIdsByParent.get(item.prnt).push(item)
}
for (const siblings of childIdsByParent.values()) {
  siblings.sort((a, b) => a.pr - b.pr)
}

function childrenOf (item) {
  return (childIdsByParent.get(item.id) || []).map(child => ({ ...child, children: childrenOf(child) }))
}

const rootItem = items.find(item => !itemsById.has(item.prnt))
if (!rootItem) {
  throw new Error('Could not find a root item in the Workflowy tree')
}
const rootChildren = childrenOf(rootItem)

const imageItems = items.filter(isImageItem)
console.info(`Uploading ${imageItems.length} image(s) to Notion...`)

const fileUploadIds = new Map()
await mapWithConcurrency(imageItems, IMAGE_CONCURRENCY, async (item) => {
  const fileName = item.metadata.s3File.fileName
  const contentType = item.metadata.s3File.fileType
  const signedUrl = await withRetry(() => resolveImageUrl(ownerId, item.id, cookieHeader))
  const { buffer } = await withRetry(() => downloadImage(signedUrl))
  const fileUploadId = await withRetry(() => uploadImageToNotion(notionToken, buffer, fileName, contentType))
  fileUploadIds.set(item.id, fileUploadId)
})
console.info('All images uploaded')

const blockTree = rootChildren.map(child => convertItem(child, child.children, fileUploadIds))

console.info(`Creating Notion page "${rootItem.nm}" under ${notionParentPageId}`)
const page = await notion.pages.create({
  parent: { page_id: notionParentPageId },
  properties: {
    title: { title: htmlToRichText(rootItem.nm) }
  },
  children: []
})

console.info('Appending content...')
await appendBlocksRecursive(notion, page.id, blockTree)

console.info(`Done: ${page.url}`)
