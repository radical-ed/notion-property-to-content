#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { markdownToBlocks } from '@tryfabric/martian'
import { createNotionClient, paginate, getTitleProperty, getDataSourceId, appendBlocksRecursive } from './lib/notion.js'

if (process.argv.length < 4) {
  console.error('Usage: node property-to-content.js <database-id> <property> [--remove]')
  process.exit(1)
}

const id = process.argv[2]
const property = process.argv[3]
const remove = process.argv[4] === '--remove'

const notion = createNotionClient()

// ------------------------------------------------------------------------------------------------------------------------------
// pomocne funkce

// Markdown like "- 1. Skupiny munice" is ambiguous: CommonMark parses the
// "1." right after the bullet marker as a nested ordered list rather than as
// literal text, so martian's parseList (which expects a paragraph as the
// item's first child) silently drops the whole item. These numbers are
// clause labels from the source legal text, not real ordered lists (they
// don't increment), so escape the period/paren to keep them as plain text.
function escapeAmbiguousListMarkers (markdown) {
  return markdown.replace(/^(\s*[-*+]\s+)(\d+)([.)])(\s)/gm, '$1$2\\$3$4')
}

// Converts martian's markdownToBlocks output - blocks with a nested
// `children` array under `block[block.type].children` - into the
// { payload, children } shape appendBlocksRecursive (lib/notion.js) expects,
// which strips `children` out into its own field regardless of block type.
function toBlockTree (blocks) {
  return blocks.map(block => {
    const { children = [], ...body } = block[block.type] ?? {}
    return {
      payload: { ...block, [block.type]: body },
      children: toBlockTree(children)
    }
  })
}


const pagesWithExistingContent = []

// ---------------------------------
async function processPage (page) {
  if (!page.properties[property]) {
    return
  }
  const titleProperty = getTitleProperty(page.properties)
  const title = titleProperty?.title?.[0]?.plain_text ?? page.id
  const richText = page.properties[property].rich_text

  if (!richText || richText.length < 1) {
    console.info(`Page does not have content property: ${title}`);
    return
  }

  const existingContent = await notion.blocks.children.list({ block_id: page.id, page_size: 1 })
  if (existingContent.results.length > 0) {
    console.warn(`WARNING: Page already has content, skipping: ${title} (${page.id})`)
    pagesWithExistingContent.push({ id: page.id, title })
    return
  }

  console.info(`Processing: ${title}`);
  console.info(`Rich text len: ${richText.length}`)

  // Notion splits rich_text properties into multiple chunks once the plain
  // text exceeds ~2000 characters, so always join before parsing as Markdown.
  const markdown = escapeAmbiguousListMarkers(richText.map(rt => rt.plain_text).join(''))
  const blocks = markdownToBlocks(markdown)

  try {
    await appendBlocksRecursive(notion, page.id, toBlockTree(blocks));
    if (remove) {
    await notion.pages.update({
      page_id: page.id,
      properties: {
        [property]: {
          rich_text: []
        }
      }
    })
  }
  } catch (error) {
    console.error(`Error appending blocks to page ${page.id} | ${title}:`, error.message);
    /// !!!!!! zapsat si error nebo tak neco
  }

  console.log(`Successfully Processed: ${title}`)
} // processPage


// --------------------------------------------------------------------------------------
// ------
// --------------------------------------------------------------------------------------

const dataSourceId = await getDataSourceId(notion, id)
const iterator = paginate(notion.dataSources.query, { data_source_id: dataSourceId })

for await (const query of iterator) {
  for (const page of query.results) {
    await processPage(page)
  }
}

if (pagesWithExistingContent.length > 0) {
  console.warn(`\n${pagesWithExistingContent.length} page(s) already had content and were skipped:`)
  const lines = pagesWithExistingContent.map(p => `${p.id}\t${p.title}`)
  lines.forEach(line => console.warn(line))
  mkdirSync('out', { recursive: true })
  writeFileSync('out/skipped-pages.txt', lines.join('\n') + '\n')
  console.warn('Written to out/skipped-pages.txt')
}
