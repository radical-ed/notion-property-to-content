#!/usr/bin/env node

import { Client } from '@notionhq/client'
import { markdownToBlocks } from '@tryfabric/martian'

if (process.argv.length < 4) {
  console.error('Usage: node property-to-content.js <database-id> <property> [--remove]')
  process.exit(1)
}

const token = process.env.NOTION_TOKEN

if (!token) {
  console.error('Missing NOTION_TOKEN in environment')
  process.exit(1)
}

const id = process.argv[2]
const property = process.argv[3]
const remove = process.argv[4] === '--remove'

const notion = new Client({
  auth: token
})

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
}

async function appendRecursive(parentId, blocks, maxDepth) {
  
    // Extrahujeme children a zbytek bloku (vlastnosti jako type, text atd.)
    //const { children, ...blockData } = block;

  if(maxDepth < 3) {
    await notion.blocks.children.append({
        block_id: parentId,
        children: blocks 
        // !!! pitome - mam tam tu svou informaci o depth - asi musim cele preprocessnout a ulozit si ve strukture:
        //  - original block
        //  - block w/o children
        //  - depth
        //  - children (?)
      });
  }
  let pureBlocks = [], children = [];
  blocks.each(b => {

  })

    
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

async function * paginate (method, params) {
  const result = await method(params)
  yield result
  if (result.next_cursor) {
    yield * paginate(method, { ...params, start_cursor: result.next_cursor })
  }
}

async function processPage (page) {
  if (!page.properties[property]) {
    return
  }

  const richText = page.properties[property].rich_text
  if (!richText || richText.length < 1) {
    return
  }

  let children = richText;

  console.info(`Processing: ${page.properties.name?.title?.[0]?.plain_text || page.id}`);

  // Pokud je to Markdown string v property, převedeme na bloky
  if (richText.length === 1) {
    children = markdownToBlocks(richText[0].plain_text)
  }

  let maxDepth = calculateDepth(children);

  // --- ZMĚNA: Místo jednoho append voláme naši rekurzivní funkci ---
  try {
    await appendRecursive(page.id, children, maxDepth);
  } catch (error) {
    console.error(`Error appending blocks to page ${page.id}:`, error.message);
  }

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

  const title = page.properties.name?.title?.[0]?.plain_text ?? page.id
  console.log(`Successfully Processed: ${title}`)
}

const iterator = paginate(notion.databases.query, { database_id: id })

for await (const query of iterator) {
  for (const page of query.results) {
    await processPage(page)
  }
}
