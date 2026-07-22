#!/usr/bin/env node

import { Client } from '@notionhq/client'
import { markdownToBlocks } from '@tryfabric/martian'

if (process.argv.length < 2) {
  console.error('Usage: node getPage.js <block-id>')
  process.exit(1)
}

const token = process.env.NOTION_TOKEN

if (!token) {
  console.error('Missing NOTION_TOKEN in environment')
  process.exit(1)
}

const id = process.argv[2]

const notion = new Client({
  auth: token,
  timeoutMs: 120_000
})

const resp = await notion.blocks.retrieve({
  block_id: id
});

console.info(resp);