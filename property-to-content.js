#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { markdownToBlocks } from '@tryfabric/martian'
import { createNotionClient, paginate, getTitleProperty } from './lib/notion.js'

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

// --- POMOCNÁ REKURZIVNÍ FUNKCE ---
// {
//   object: 'block',
//   type: 'bulleted_list_item',
//   bulleted_list_item: {
//     rich_text: [ [Object] ],
//     children: [
//       [Object], [Object],
//       [Object], [Object],
//       [Object], [Object],
//       [Object]
//     ]
//   }
// }

function calculateDepth(blocks) {
  // bulleted_list_item
  // numbered_list_item
  let maxDepth = 0;
  blocks.each(b => {
    let d = 0;
    if(b.bulleted_list_item?.children?.length > 0) {
      d = calculateDepth(b.bulleted_list_item.children) + 1;
    } else if(b.numbered_list_item?.children?.length > 0) {
      d = calculateDepth(b.numbered_list_item.children) + 1;
    } else {
      d = 0;
    }
    b.listDepth = d;
    if(d > maxDepth) {
      maxDepth = d;
    }
  })
} // calculateDepth


// ---------------------------------
// returns {maxDepth, blocksCustomStructure, blocksWOChildren}
// blocksCustomStructure = {
//   id,
//   origBlock,
//   maxDepth,
//   children,
//   childrenCustom,
//   childrenWOchildren
// }

function preprocessBlocks(blocks) {
  let blocksCustomStructure = [];
  let blocksWOChildren = []
  let blocksOrig = [];
  let maxDepth = 0;
  console.info("Preprocessing blocks:");
  console.info(blocks);
  console.info(blocks[0]?.bulleted_list_item?.rich_text);
  blocks.forEach(b => {
    let bout = {
      id: null,
      origBlock: b, //??
    };
    let bWOchildren = structuredClone(b);
     let d;
    if(b.bulleted_list_item?.children?.length > 0) {
      d = preprocessBlocks(b.bulleted_list_item.children);
      delete bWOchildren.bulleted_list_item.children;
    } else if(b.numbered_list_item?.children?.length > 0) {
      d = preprocessBlocks(b.numbered_list_item.children);
      delete bWOchildren.numbered_list_item.children;
    } else {
      d = {maxDepth: -1};
    }
    bout.maxDepth = d.maxDepth + 1;
    bout.children = d.blocksOrig;
    bout.childrenCustom = d.blocksCustomStructure;
    bout.childrenWOchildren = d.blocksWOChildren;
    if(bout.maxDepth > maxDepth) {
      maxDepth = bout.maxDepth;
    }
    
    blocksCustomStructure.push(bout);
    blocksWOChildren.push(bWOchildren);
    blocksOrig.push(b);
  });
  return {maxDepth, blocksCustomStructure, blocksWOChildren, blocksOrig};
} // preprocessBlocks

// function logBlocks(blocks, customFlag = false) {
//   if(!blocks.length) {
//     console.log("[]");
//   } else {
//     console.log("[")
//   }
// }

// ---------------------------------
async function appendRecursive(parentId, blocks, blocksCustom, blocksWOchildren, depth) {
  let options = {depth: 8};
  console.log("appendRecursive: ", parentId)
  console.dir( blocks, options );
  console.dir( blocksCustom, options);
  console.dir( blocksWOchildren, options);
  console.log(depth);
  console.log("----");
    // Extrahujeme children a zbytek bloku (vlastnosti jako type, text atd.)
    //const { children, ...blockData } = block;

  if(depth < 3) {
    console.log("Append all: ", blocks);
    return notion.blocks.children.append({
        block_id: parentId,
        children: blocks    
      });
  } else {
    // append blocks without children
    console.info("Append WO Children: ", blocksWOchildren);
    let parentBlocks = await notion.blocks.children.append({
        block_id: parentId,
        children: blocksWOchildren    
      });
    console.log("response: ", parentBlocks.results);
    // for 1..block.lenght - iterate thru all the arrays and append all the children
    let resPromises = [];
    for(let i = 0; i < blocks.length; ++i) {
      if(blocksCustom[i].maxDepth > 0) {
        resPromises.push(appendRecursive(
          parentBlocks.results[i].id,
          blocksCustom[i].children,
          blocksCustom[i].childrenCustom,
          blocksCustom[i].childrenWOchildren,
          blocksCustom[i].maxDepth
        ));
      }
    }

    return await Promise.all(resPromises);
    // await all
  } // appendRecursive
  
    
    // if ( block.bulleted_list_item?.children?.length > 0) {
    //   console.info(`blockData WITH children: `, block);
    //   const {bulleted_list_item: {children, ...list_data}, ...blockData} = block;

    //   // 1. Vytvoříme pouze rodičovský blok (bez dětí v tomto callu)
    //   const response = await notion.blocks.children.append({
    //     block_id: parentId,
    //     children: [{
    //       ...blockData,
    //       bulleted_list_item: list_data,
    //     }]
    //   });

    //   // 2. Získáme ID právě vytvořeného bloku (první prvek v poli results)
    //   const newBlockId = response.results[0].id;

    //   // 3. Rekurzivně nahrajeme děti do tohoto nového bloku
    //   await appendRecursive(newBlockId, children);
    // } else {
    //   console.info(`blockData WITHOUT: `, block);
    //   // Blok nemá děti, nahrajeme ho standardně
    //   await notion.blocks.children.append({
    //     block_id: parentId,
    //     children: [block]
    //   });
    // }
  
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
  const children = markdownToBlocks(markdown)

  
  let {maxDepth, blocksCustomStructure, blocksWOChildren} = preprocessBlocks(children);
  
  console.log("----------------------------------------------------------------");
  console.log("----------------------------------------------------------------");
  console.log("----------------------------------------------------------------");

  // --- ZMĚNA: Místo jednoho append voláme naši rekurzivní funkci ---
  

  try {
    
    await appendRecursive(page.id, children, blocksCustomStructure, blocksWOChildren, maxDepth);
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

const iterator = paginate(notion.databases.query, { database_id: id })

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
