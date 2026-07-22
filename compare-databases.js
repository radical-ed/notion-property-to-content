#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import {
  createNotionClient,
  fetchDatabasePages,
  fetchPageContentTree,
  blockTreeToPlainText,
  getTitleText,
  getDatabaseName,
  diffProperties
} from './lib/notion.js'
import { createComparisonReportPage } from './lib/report.js'

const USAGE = 'Usage: node compare-databases.js <database-id-a> <database-id-b> [report-parent-page-id] [--no-properties] [--no-content] [--one-way]'

const rawArgs = process.argv.slice(2)
const flags = new Set(rawArgs.filter(a => a.startsWith('--')))
const [databaseIdA, databaseIdB, reportParentId] = rawArgs.filter(a => !a.startsWith('--'))

const KNOWN_FLAGS = new Set(['--no-properties', '--no-content', '--one-way'])
for (const flag of flags) {
  if (!KNOWN_FLAGS.has(flag)) {
    console.error(`Unknown option: ${flag}\n${USAGE}`)
    process.exit(1)
  }
}

if (!databaseIdA || !databaseIdB) {
  console.error(USAGE)
  process.exit(1)
}

const compareProperties = !flags.has('--no-properties')
const compareContent = !flags.has('--no-content')
const oneWay = flags.has('--one-way')

if (!compareProperties && !compareContent) {
  console.error('Nothing to compare: both --no-properties and --no-content were given')
  process.exit(1)
}

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
  let propertyDiffs = []

  if (compareProperties) {
    propertyDiffs = diffProperties(pageA.properties, pageB.properties)
    if (propertyDiffs.length > 0) {
      types.push(`Properties differ: ${propertyDiffs.map(d => d.property).join(', ')}`)
    }
  }

  if (compareContent) {
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
  }

  return types.length > 0 ? { title, pageA, pageB, propertyDiffs, types } : null
}

// --------------------------------------------------------------------------------------

console.info(`Loading database A: ${databaseIdA}`)
const pagesA = await loadDatabaseByTitle(databaseIdA)
console.info(`Loading database B: ${databaseIdB}`)
const pagesB = await loadDatabaseByTitle(databaseIdB)

// One-way: only check that A's rows made it into B; extra rows only in B
// (e.g. a merge target with unrelated rows) aren't reported as differences.
const allTitles = new Set([...pagesA.keys(), ...pagesB.keys()])
const titlesToCompare = oneWay ? pagesA.keys() : allTitles

const differences = []

for (const title of titlesToCompare) {
  const diff = await compareRow(title, pagesA.get(title), pagesB.get(title))
  if (diff) {
    differences.push(diff)
  }
}

const comparedCount = oneWay ? pagesA.size : allTitles.size
console.info(`\nCompared ${comparedCount} row(s), found ${differences.length} difference(s).\n`)

for (const diff of differences) {
  console.info(`- ${diff.title}: ${diff.types.join('; ')}`)
}

const tsvLines = differences.map(d => [
  d.title,
  d.pageA?.url ?? '',
  d.pageB?.url ?? '',
  d.types.join('; ')
].join('\t'))

mkdirSync('out', { recursive: true })
writeFileSync('out/database-differences.tsv', ['Title\tRow in A\tRow in B\tDifference', ...tsvLines].join('\n') + '\n')
console.info('\nWritten to out/database-differences.tsv')

if (differences.length > 0) {
  if (reportParentId) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\nCreate a Notion report page with ${differences.length} difference(s) under page ${reportParentId}? [y/N] `)
    rl.close()

    if (answer.trim().toLowerCase() === 'y') {
      const [nameA, nameB] = await Promise.all([
        getDatabaseName(notion, databaseIdA),
        getDatabaseName(notion, databaseIdB)
      ])

      const optionsNote = [
        oneWay && 'one-way (A → B)',
        !compareProperties && 'properties not compared',
        !compareContent && 'content not compared'
      ].filter(Boolean).join(', ')

      const page = await createComparisonReportPage(notion, reportParentId, {
        title: `Database comparison: ${nameA} vs ${nameB} (${differences.length} difference(s))`,
        summary: `Comparing "${nameA}" (${databaseIdA}) and "${nameB}" (${databaseIdB})${optionsNote ? ` (${optionsNote})` : ''}. Found ${differences.length} difference(s) out of ${comparedCount} row(s) compared.`,
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
