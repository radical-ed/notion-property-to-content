#!/usr/bin/env node

import { createNotionClient } from './lib/notion.js'

if (process.argv.length < 2) {
  console.error('Usage: node getPage.js <block-id>')
  process.exit(1)
}

const id = process.argv[2]

const notion = createNotionClient()

const resp = await notion.blocks.retrieve({
  block_id: id
});

console.info(resp);