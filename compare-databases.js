#!/usr/bin/env node

import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import {
  createNotionClient,
  fetchDatabasePages,
  fetchPageContentTree,
  blockTreeToPlainText,
  getTitleText,
  diffProperties
} from './lib/notion.js'
import { createComparisonReportPage } from './lib/report.js'

if (process.argv.length < 4) {
  console.error('Usage: node compare-databases.js <database-id-a> <database-id-b> [report-parent-page-id]')
  process.exit(1)
}

const databaseIdA = process.argv[2]
const databaseIdB = process.argv[3]
const reportParentId = process.argv[4]

const notion = createNotionClient()

// ---------------------------------
async function loadDatabaseByTitle (databaseId) {
  const pages = await fetchDatabasePages(notion, databaseId)
  const byTitle = new Map()

  for (const page of pages) {
    const title = getTitleText(page)
    if (byTitle.has(title)) {
      console.warn(`WARNING: duplicate title "${title}" in database ${databaseId}, comparing only the first occurrence`)
      continue
    }
    byTitle.set(title, page)
  }

  return byTitle
}

// ---------------------------------
async function compareRow (title, pageA, pageB) {
  if (!pageA || !pageB) {
    return { title, pageA, pageB, propertyDiffs: [], types: [pageA ? 'Missing in DB B' : 'Missing in DB A'] }
  }

  const types = []

  const propertyDiffs = diffProperties(pageA.properties, pageB.properties)
  if (propertyDiffs.length > 0) {
    types.push(`Properties differ: ${propertyDiffs.map(d => d.property).join(', ')}`)
  }

  const [contentA, contentB] = await Promise.all([
    fetchPageContentTree(notion, pageA.id),
    fetchPageContentTree(notion, pageB.id)
  ])
  const textA = blockTreeToPlainText(contentA)
  const textB = blockTreeToPlainText(contentB)

  if (textA !== textB) {
    if (!textA) types.push('Content: empty in A, present in B')
    else if (!textB) types.push('Content: empty in B, present in A')
    else types.push('Content differs')
  }

  return types.length > 0 ? { title, pageA, pageB, propertyDiffs, types } : null
}

// --------------------------------------------------------------------------------------

console.info(`Loading database A: ${databaseIdA}`)
const pagesA = await loadDatabaseByTitle(databaseIdA)
console.info(`Loading database B: ${databaseIdB}`)
const pagesB = await loadDatabaseByTitle(databaseIdB)

const allTitles = new Set([...pagesA.keys(), ...pagesB.keys()])
const differences = []

for (const title of allTitles) {
  const diff = await compareRow(title, pagesA.get(title), pagesB.get(title))
  if (diff) {
    differences.push(diff)
  }
}

console.info(`\nCompared ${allTitles.size} row(s), found ${differences.length} difference(s).\n`)

for (const diff of differences) {
  console.info(`- ${diff.title}: ${diff.types.join('; ')}`)
}

const tsvLines = differences.map(d => [
  d.title,
  d.pageA?.url ?? '',
  d.pageB?.url ?? '',
  d.types.join('; ')
].join('\t'))

writeFileSync('database-differences.tsv', ['Title\tRow in A\tRow in B\tDifference', ...tsvLines].join('\n') + '\n')
console.info('\nWritten to database-differences.tsv')

if (differences.length > 0) {
  if (reportParentId) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\nCreate a Notion report page with ${differences.length} difference(s) under page ${reportParentId}? [y/N] `)
    rl.close()

    if (answer.trim().toLowerCase() === 'y') {
      const page = await createComparisonReportPage(notion, reportParentId, {
        title: `Database comparison: ${differences.length} difference(s)`,
        summary: `Comparing ${databaseIdA} and ${databaseIdB}. Found ${differences.length} difference(s) out of ${allTitles.size} row(s) compared.`,
        databaseIdA,
        databaseIdB,
        differences
      })
      console.info(`Report page created: ${page.url}`)
    }
  } else {
    console.info('\nPass a report-parent-page-id argument to be offered creation of a Notion report page with these differences.')
  }
}
