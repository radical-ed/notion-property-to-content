#!/usr/bin/env node

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { createNotionClient } from './lib/notion.js'
import { discoverArchiveTargets, processTargets } from './lib/archive.js'

const USAGE = 'Usage: node archive-to-backup.js <source-root-page-id> <destination-parent-page-id> [--mode=archive] [--dry-run] [--yes]'

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

const KNOWN_FLAGS = new Set(['mode', 'dry-run', 'yes'])
for (const key of flags.keys()) {
  if (!KNOWN_FLAGS.has(key)) {
    console.error(`Unknown option: --${key}\n${USAGE}`)
    process.exit(1)
  }
}

const [sourceRootId, destinationParentId] = positional
if (!sourceRootId || !destinationParentId) {
  console.error(USAGE)
  process.exit(1)
}

// Only "archive" (copy, then wipe+mark the source) is implemented. "backup"
// (copy/merge, leave source untouched, re-runnable) is a planned future
// mode - see docs/plans/2026-07-23-notion-archive-to-backup-account.md -
// recognized here already so the CLI contract won't need to change later.
const mode = flags.get('mode') ?? 'archive'
if (mode !== 'archive') {
  console.error(`Mode "${mode}" is not implemented yet - only "archive" is supported in this version.`)
  process.exit(1)
}

const dryRun = flags.get('dry-run') === true
const skipConfirm = flags.get('yes') === true

if (!process.env.NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN in environment (source account)')
  process.exit(1)
}
if (!process.env.NOTION_BACKUP_TOKEN) {
  console.error('Missing NOTION_BACKUP_TOKEN in environment (destination account)')
  process.exit(1)
}

const ctx = {
  sourceNotion: createNotionClient(process.env.NOTION_TOKEN),
  destNotion: createNotionClient(process.env.NOTION_BACKUP_TOKEN)
}

// --------------------------------------------------------------------------------------

console.info(`Discovering archive targets under ${sourceRootId}...`)
const targets = await discoverArchiveTargets(ctx.sourceNotion, sourceRootId)
const actionable = targets.filter(t => t.type !== 'skip' && !t.alreadyArchived)
const alreadyArchived = targets.filter(t => t.alreadyArchived)
const notPages = targets.filter(t => t.type === 'skip')

console.info(`\nFound ${targets.length} direct child(ren) under the root page:`)
for (const t of actionable) console.info(`  - [${t.type}] ${t.title}`)
for (const t of alreadyArchived) console.info(`  - (already archived, will skip) ${t.title}`)
for (const t of notPages) console.info(`  - (not a page/database, will skip) ${t.title}`)

if (actionable.length === 0) {
  console.info('\nNothing to do.')
  process.exit(0)
}

if (dryRun) {
  console.info(`\nDry run: will copy and validate ${actionable.length} target(s) into ${destinationParentId}, but will NOT modify the source.`)
} else if (!skipConfirm) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`\nThis will copy ${actionable.length} target(s) to ${destinationParentId}, then blank out and mark the originals as archived. Continue? [y/N] `)
  rl.close()
  if (answer.trim().toLowerCase() !== 'y') {
    console.info('Aborted.')
    process.exit(0)
  }
}

mkdirSync('out', { recursive: true })
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const logPath = `out/archive-log-${timestamp}.txt`
writeFileSync(logPath, [
  `Notion archive run - ${new Date().toISOString()}`,
  `Root page: ${sourceRootId} (source account)`,
  `Destination parent: ${destinationParentId} (destination account)`,
  `Mode: ${mode} | Dry-run: ${dryRun ? 'yes' : 'no'}`,
  '',
  '=== Per-target results (written live as each target finishes) ===',
  ''
].join('\n'))
console.info(`Logging progress to ${logPath} as it runs...\n`)

const results = await processTargets(ctx, targets, {
  sourceRootId,
  destinationParentId,
  dryRun,
  onResult: (result) => {
    printResult(result)
    appendFileSync(logPath, formatResultBlock(result))
  }
})

const succeeded = results.filter(r => r.status === 'ok')
const failed = results.filter(r => r.status === 'failed')
const skipped = results.filter(r => r.status === 'skipped')
const totalWarnings = results.reduce((sum, r) => sum + (r.warnings?.length ?? 0), 0)

console.info(`\nDone: ${succeeded.length} succeeded, ${skipped.length} skipped, ${failed.length} failed, ${totalWarnings} warning(s) logged.`)

appendFileSync(logPath, buildSummary(results))
console.info(`\nFull log at ${logPath}`)

// A target can succeed overall (title/content validation passed) while
// still having plenty of individual pieces - a database row, a nested
// block - skipped or failed underneath it. "N succeeded" alone hides that,
// so call out anything with warnings explicitly rather than making the log
// file the only place this is visible.
function printResult (result) {
  const warningCount = result.warnings?.length ?? 0
  const suffix = warningCount > 0 ? ` (${warningCount} warning(s), see log)` : ''
  if (result.status === 'ok') {
    console.info(`  [OK] "${result.target.title}" -> ${result.destUrl}${suffix}`)
  } else if (result.status === 'skipped') {
    console.info(`  [SKIPPED] "${result.target.title}" - ${result.reason}`)
  } else {
    console.error(`  [FAILED] "${result.target.title}" - ${result.reason}${suffix}`)
  }
}

function formatResultBlock (result) {
  const lines = []
  const warningCount = result.warnings?.length ?? 0
  const suffix = warningCount > 0 ? ` (${warningCount} warning(s))` : ''
  if (result.status === 'ok') {
    lines.push(`[OK] "${result.target.title}" -> ${result.destUrl}${suffix}`)
  } else if (result.status === 'skipped') {
    lines.push(`[SKIPPED] "${result.target.title}" - ${result.reason}`)
  } else {
    lines.push(`[FAILED] "${result.target.title}" - ${result.reason}${suffix}`)
  }
  for (const w of result.warnings ?? []) {
    lines.push(`    warning: ${w.type ? `(${w.type}) ` : ''}${w.reason}${w.blockId ? ` [block ${w.blockId}]` : ''}`)
  }
  return lines.join('\n') + '\n'
}

function buildSummary (results) {
  const allWarnings = results.flatMap(r => r.warnings ?? [])
  const warningsByType = {}
  for (const w of allWarnings) {
    const category = w.type ?? 'other'
    warningsByType[category] = (warningsByType[category] ?? 0) + 1
  }

  const lines = ['', '=== Summary ===']
  lines.push(`Targets found: ${results.length}`)
  lines.push(`Succeeded: ${results.filter(r => r.status === 'ok').length}`)
  lines.push(`Skipped: ${results.filter(r => r.status === 'skipped').length}`)
  lines.push(`Failed: ${results.filter(r => r.status === 'failed').length}`)
  lines.push(`Total warnings: ${allWarnings.length} (individual pieces skipped/failed within otherwise-successful targets - see per-target detail above)`)
  for (const [category, count] of Object.entries(warningsByType).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${category}: ${count}`)
  }
  return lines.join('\n') + '\n'
}
