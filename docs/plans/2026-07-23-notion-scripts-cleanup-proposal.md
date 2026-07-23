# Proposal: consolidate Notion block-appending logic across scripts

Date: 2026-07-23
Status: **proposal only — not scheduled, not implemented.** Revisit and refine before doing this work.

## Problem

This repo has three separate places that solve the same underlying problem — writing a batch of new blocks into a Notion page/block, working around Notion's API limits (block-append calls accept at most 100 children, and only 2 levels of nesting per call) — each at a different quality level:

1. **`property-to-content.js`** — `calculateDepth` + `preprocessBlocks` + `appendRecursive`. Walks a `markdownToBlocks`-produced tree, figures out nesting depth, and recursively appends. This is messy, debug-log-laden WIP code (leftover `console.dir` calls, Czech comments, commented-out earlier attempts still in the file).
2. **`lib/report.js`** — a bespoke inline loop that chunks a flat list of table rows into batches of 90 before calling `blocks.children.append`. Simpler (no recursion needed, since report rows are flat), but it's a second, independent implementation of "respect the block-append batch-size limit."
3. **`lib/notion-blocks.js`** (added for `workflowy-to-notion.js`, see `docs/plans/2026-07-23-workflowy-to-notion.md`) — `appendBlocksRecursive`. Solves the same nested-block-tree-vs-API-limit problem as (1), but with a simpler, uniform strategy: always strip `children` off the current level, append flat (batched to 90), then recurse into each returned block id for its own children. No separate depth-counting pass needed.

Net effect: the same problem is now solved three times in three places. A bug fix (e.g. Notion changing its batch-size limit, or a rate-limit handling improvement) would need to be found and applied in three separate spots, and two of the three implementations (`property-to-content.js`'s and `lib/report.js`'s) are strictly worse than the third.

## Proposed follow-up

1. Move `appendBlocksRecursive` (and its 90-item batching) from `lib/notion-blocks.js` into `lib/notion.js`, since it's a generic Notion-content-writing helper with no Workflowy-specific behavior — `lib/notion.js` is already the home for shared Notion helpers used across scripts.
2. Rewrite `property-to-content.js` to build the same `{ payload, children }` shape from martian's `markdownToBlocks` output (a small mapping step: split each block's `children` property out into the wrapper's `children` field) and call the shared `appendBlocksRecursive` instead of its own `calculateDepth` / `preprocessBlocks` / `appendRecursive`. Delete all three functions plus the leftover debug `console.dir` calls and commented-out dead code.
3. Point `lib/report.js`'s manual 90-row chunking loop at the same shared batching helper instead of its own inline loop (it can call `appendBlocksRecursive` with `children: []` on every node, since report rows are flat).
4. No behavior change intended — this is a pure internal consolidation. The existing CLI contracts of `property-to-content.js` and `compare-databases.js` (which drives `lib/report.js`) should stay identical.

## Verification (once this is picked up)

- Re-run `property-to-content.js` against a scratch database/property with content deep enough to exercise multi-level recursion (3+ nested list levels), before and after the refactor, and diff the resulting Notion page content tree (`fetchPageContentTree` / `blockTreeToPlainText` from `lib/notion.js` are already suited for this comparison).
- Re-run `compare-databases.js` against two scratch databases with enough differences to produce a report with >90 rows (to exercise the batching path), before and after, and confirm the report page content is identical.
- Confirm rate-limit/429 handling still works (the new shared helper should retry with backoff; neither old implementation had this, so this is a net improvement to verify, not just a regression check).

## Not in scope

- Any change to `workflowy-to-notion.js` itself — it already uses the new shared-quality helper via `lib/notion-blocks.js`; only the *location* of that helper moves.
- Any change to the martian-based Markdown-to-blocks conversion in `property-to-content.js` — only the append/recursion mechanism changes.
