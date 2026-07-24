#!/usr/bin/env node

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { createNotionClient, getDataSourceId, fetchDatabasePages, getTitleText } from './lib/notion.js'
import { resolveTemplate, resolveTemplateSegments, reapplyTemplateToPage } from './lib/template-reapply.js'

const USAGE = 'Usage: node reapply-template.js <database-id> [--properties|--content-only] [--template=<name-or-id>] [--only=<page-id>[,<page-id>...]] [--dry-run] [--yes]'

const rawArgs = process.argv.slice(2)
const flags = new Map()
const positional = []
for (const arg of rawArgs) {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=')
    flags.set(key, value ?? true)
  } else {
    positional.push(arg)
  }
}

const KNOWN_FLAGS = new Set(['properties', 'content-only', 'template', 'only', 'dry-run', 'yes'])
for (const key of flags.keys()) {
  if (!KNOWN_FLAGS.has(key)) {
    console.error(`Unknown option: --${key}\n${USAGE}`)
    process.exit(1)
  }
}
if (flags.has('properties') && flags.has('content-only')) {
  console.error(`--properties and --content-only are mutually exclusive\n${USAGE}`)
  process.exit(1)
}

const [databaseId] = positional
if (!databaseId) {
  console.error(USAGE)
  process.exit(1)
}

const dryRun = flags.get('dry-run') === true
const skipConfirm = flags.get('yes') === true
const onlyPageIds = flags.get('only') ? String(flags.get('only')).split(',').map(s => s.trim()) : null

if (!process.env.NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN in environment')
  process.exit(1)
}

const notion = createNotionClient()
const runStartedAt = Date.now()
const canPrompt = process.stdin.isTTY

// --------------------------------------------------------------------------------------

let includeProperties
if (flags.has('properties')) {
  includeProperties = true
} else if (flags.has('content-only')) {
  includeProperties = false
} else if (canPrompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('Also reapply non-empty template properties (overwriting existing values on target pages)? [y/N] ')
  rl.close()
  includeProperties = answer.trim().toLowerCase() === 'y'
} else {
  console.error(`Not running interactively - pass --properties or --content-only explicitly.\n${USAGE}`)
  process.exit(1)
}

console.info(`Resolving data source and template for database ${databaseId}...`)
const dataSourceId = await getDataSourceId(notion, databaseId)

const template = await resolveTemplate(notion, dataSourceId, {
  templateArg: flags.get('template'),
  chooseTemplate: canPrompt
    ? async (templates) => {
        console.info('\nMultiple templates found:')
        templates.forEach((t, i) => console.info(`  ${i + 1}. ${t.name}${t.is_default ? ' (default)' : ''}`))
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        const answer = await rl.question(`Pick one [1-${templates.length}]: `)
        rl.close()
        const choice = templates[Number(answer.trim()) - 1]
        if (!choice) {
          console.error('Invalid choice.')
          process.exit(1)
        }
        return choice
      }
    : undefined
})
console.info(`Using template "${template.name}" (${template.id})`)

console.info('Reading template structure...')
const segments = await resolveTemplateSegments(notion, template.id)
console.info(`Found ${segments.length} section(s): ${segments.map(s => `${s.headerText || '(untitled)'} [${s.kind}]`).join(', ')}`)

const templatePage = await notion.pages.retrieve({ page_id: template.id })

console.info('Fetching target pages...')
let pages = await fetchDatabasePages(notion, databaseId)
if (onlyPageIds) {
  const idSet = new Set(onlyPageIds.map(id => id.replace(/-/g, '')))
  pages = pages.filter(p => idSet.has(p.id.replace(/-/g, '')))
}
console.info(`${pages.length} target page(s) to process.`)

if (pages.length === 0) {
  console.info('Nothing to do.')
  process.exit(0)
}

if (dryRun) {
  console.info(`\nDry run: will compute what reapplying "${template.name}" would do to ${pages.length} page(s), but will NOT write anything.`)
} else if (!skipConfirm) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const propNote = includeProperties ? ', including overwriting non-empty template properties' : ' (content/views only)'
  const answer = await rl.question(`\nThis will reapply "${template.name}" to ${pages.length} page(s)${propNote}. Continue? [y/N] `)
  rl.close()
  if (answer.trim().toLowerCase() !== 'y') {
    console.info('Aborted.')
    process.exit(0)
  }
}

mkdirSync('out', { recursive: true })
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const logPath = `out/reapply-template-log-${timestamp}.txt`
writeFileSync(logPath, [
  `Notion template reapply run - ${new Date().toISOString()}`,
  `Database: ${databaseId}`,
  `Template: ${template.name} (${template.id})`,
  `Properties: ${includeProperties ? 'yes (overwrite non-empty)' : 'no (content/views only)'} | Dry-run: ${dryRun ? 'yes' : 'no'}`,
  '',
  '=== Per-page results (written live as each page finishes) ===',
  ''
].join('\n'))
console.info(`Logging progress to ${logPath} as it runs...\n`)

const results = []
for (const page of pages) {
  try {
    const result = await reapplyTemplateToPage(notion, {
      page,
      templateId: template.id,
      templateProperties: templatePage.properties,
      segments,
      includeProperties,
      dryRun
    })
    results.push(result)
    printResult(result)
    appendFileSync(logPath, formatResultBlock(result))
  } catch (error) {
    const result = { pageId: page.id, title: getTitleText(page), segmentResults: [], propertyChanges: null, error: error.message }
    results.push(result)
    console.error(`  [ERROR] "${result.title}" - ${error.message}`)
    appendFileSync(logPath, `[ERROR] "${result.title}" - ${error.message}\n`)
  }
}

const finishedAt = new Date()
const durationText = formatDuration(finishedAt.getTime() - runStartedAt)
const flatCompromises = results.flatMap(r => r.segmentResults ?? []).filter(s => s.action?.includes('recreated') || s.action?.includes('would-recreate'))

console.info(`\nDone: ${results.length} page(s) processed.`)
if (flatCompromises.length > 0) {
  console.info(`${flatCompromises.length} section(s) had to be (re)created as a flat heading+view instead of a nested toggle - see log for which pages.`)
}
console.info(`Finished at ${finishedAt.toISOString()} (took ${durationText}).`)

appendFileSync(logPath, buildSummary(results, finishedAt, durationText))
console.info(`\nFull log at ${logPath}`)

function formatDuration (ms) {
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []
  if (hours > 0) parts.push(`${hours}h`)
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

function printResult (result) {
  const parts = result.segmentResults.map(s => `${s.header || '(untitled)'}: ${s.action}`)
  if (result.propertyChanges) parts.push(`properties: ${result.propertyChanges.join(', ')}`)
  console.info(`  "${result.title}" -> ${parts.join(' | ') || 'no changes'}`)
}

function formatResultBlock (result) {
  const lines = [`"${result.title}" (${result.pageId})`]
  for (const s of result.segmentResults) {
    lines.push(`    ${s.header || '(untitled)'}: ${s.action}${s.error ? ` - ${s.error}` : ''}`)
  }
  if (result.propertyChanges) {
    lines.push(`    properties overwritten: ${result.propertyChanges.join(', ')}`)
  }
  return lines.join('\n') + '\n'
}

function buildSummary (results, finishedAt, durationText) {
  const allSegments = results.flatMap(r => r.segmentResults ?? [])
  const actionCounts = {}
  for (const s of allSegments) {
    actionCounts[s.action] = (actionCounts[s.action] ?? 0) + 1
  }
  const errors = results.filter(r => r.error)

  const lines = ['', '=== Summary ===']
  lines.push(`Finished: ${finishedAt.toISOString()} (took ${durationText})`)
  lines.push(`Pages processed: ${results.length}`)
  lines.push(`Pages with errors: ${errors.length}`)
  for (const [action, count] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${action}: ${count}`)
  }
  return lines.join('\n') + '\n'
}
