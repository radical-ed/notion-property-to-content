# Proposal: upgrade the Notion client, then consolidate block-appending logic

Date: 2026-07-23
Status: **proposal only — not scheduled, not implemented.** Revisit and refine before doing this work.

## Problem

This repo has three separate places that solve the same underlying problem — writing a batch of new blocks into a Notion page/block, working around Notion's API limits (block-append calls accept at most 100 children, and only 2 levels of nesting per call) — each at a different level of robustness:

1. **`property-to-content.js`** — `calculateDepth` + `preprocessBlocks` + `appendRecursive`. Walks a `markdownToBlocks`-produced tree and appends it. This is not naive one-block-at-a-time recursion: `appendRecursive` already batches every sibling at a tree level into a single `blocks.children.append` call, then recurses into each child in parallel via `Promise.all`. That design is deliberate — the file has an earlier, truly naive draft (append one block, recurse immediately) left in as a commented-out block, with Czech comments explaining the change. It was rewritten because the naive version didn't hold up against Workflowy exports with thousands of bullets and deep nesting. That trial-log commenting (plus the pasted sample block object documenting the shape being processed) is normal for a helper-script repo and isn't being proposed for removal on cosmetic grounds.

   The real, narrower gaps versus `lib/notion-blocks.js`'s `appendBlocksRecursive` (item 3 below) are:
   - No chunking to stay under Notion's 100-children-per-call limit — a single tree level with more than 100 siblings (plausible at Workflowy scale) will fail or behave unpredictably, since the current code appends the whole sibling array in one call.
   - No retry/backoff on HTTP 429 rate-limit responses.
   - Depth counting only descends into `bulleted_list_item`/`numbered_list_item` children, not other nestable block types (toggles, callouts, quotes, columns, tables) — those may not get the same depth-safe handling.

   Separately, `calculateDepth` is dead code — it's never called anywhere in the file — and has a real bug (`blocks.each`, which isn't a method; it would throw if ever invoked). That's uncontroversial to delete regardless of the comments question, since nothing depends on it.

2. **`lib/report.js`** — a bespoke inline loop that chunks a flat list of table rows into batches of 90 before calling `blocks.children.append`. Simpler (no recursion needed, since report rows are flat), but it's a second, independent implementation of "respect the block-append batch-size limit."

3. **`lib/notion-blocks.js`** (added for `workflowy-to-notion.js`, see `docs/plans/2026-07-23-workflowy-to-notion.md`) — `appendBlocksRecursive`. Solves the same nested-block-tree-vs-API-limit problem as (1), with a uniform strategy: strip `children` off the current level, append flat in batches of 90 (`appendWithRetry`, which retries on 429 using the `retry-after` header), then recurse into each returned block id for its own children. No separate depth-counting pass needed, and it's robust to arbitrarily wide/deep trees.

Net effect: the same problem is solved three times, at three different robustness levels. A bug fix (e.g. Notion changing its batch-size limit, or a rate-limit handling improvement) would need to be found and applied in three places, and two of the three (`property-to-content.js`'s and `lib/report.js`'s) lack protections the third already has.

## The Notion client library is also out of date, and that's the real blocker

Installed `@notionhq/client` is `1.0.4` (published ~2022); its `Client` only exposes `blocks`/`databases`/`pages`/`users` namespaces. Latest published version is `5.23.2`.

This matters here specifically because of file uploads. Notion's File Upload API (create a `file_upload` object → POST bytes to its `upload_url` → reference the id in a block) postdates `1.0.4`, so `lib/notion-blocks.js`'s `uploadImageToNotion` calls `fetch('https://api.notion.com/v1/file_uploads', ...)` directly, with an explicit comment saying this is because the installed client predates the feature. That's a stopgap for a missing SDK capability, not a deliberate move away from the library. Confirmed against the npm registry: `5.23.2`'s `Client` has native `fileUploads.create`, `fileUploads.send`, and `fileUploads.complete` methods matching that exact three-step flow. The repo's Node runtime (v20) already satisfies the SDK's `engines.node >= 18` requirement.

Given that, **upgrading the client should happen before consolidating the block-append logic, not after.** Building the shared helper on top of the old `1.0.4` client and then upgrading later would mean migrating that shared helper's API calls a second time, plus re-touching every call site that adopted it in the meantime. Doing the upgrade first means the consolidation only has to happen once, on the client version the code will actually run on going forward.

## Proposed follow-up (two phases, in order)

### Phase 0 — upgrade `@notionhq/client` to latest (`5.23.2`)

1. Bump `@notionhq/client` in `package.json` from `^1.0.4` to the latest `5.x`.
2. Walk every existing call site for breaking changes across the 1→5 major-version jump (response shapes, pagination helpers, constructor options, and possible renames are the likely risk areas):
   - `lib/notion.js`: `databases.query`, `databases.retrieve`, `blocks.children.list` (used by the content-tree/diff helpers).
   - `getPage.js`: `blocks.retrieve`.
   - `property-to-content.js`: `blocks.children.append`, `blocks.children.list`, `pages.update`, `databases.query`.
   - `lib/report.js`: `pages.create`, `blocks.children.list`, `blocks.children.append`.
   - `workflowy-to-notion.js`: `pages.create`.
3. Migrate `lib/notion-blocks.js`'s `uploadImageToNotion` off raw `fetch`/`FormData` onto `notion.fileUploads.create` / `.send` / `.complete`, deleting the bespoke multipart-upload code.
4. This phase is infrastructure-wide by nature — every script shares the client — so it gets its own verification pass (below) before Phase 1 starts.

### Phase 1 — consolidate block-append logic on the upgraded client

1. Move `appendBlocksRecursive` (and its 90-item batching, now built against the `5.x` client) from `lib/notion-blocks.js` into `lib/notion.js`, since it's a generic Notion-content-writing helper with no Workflowy-specific behavior.
2. Rewrite `property-to-content.js` to build the same `{ payload, children }` shape from martian's `markdownToBlocks` output (a small mapping step: split each block's `children` property out into the wrapper's `children` field) and call the shared `appendBlocksRecursive` instead of its own `calculateDepth` / `preprocessBlocks` / `appendRecursive`. Delete those three functions (`calculateDepth` as dead/buggy code regardless; the other two because the refactor makes them functionally redundant) and any leftover debug `console.dir` calls. Leave the trial-log comments that don't reference deleted code alone — they're not the target of this change.
3. Point `lib/report.js`'s manual 90-row chunking loop at the same shared batching helper instead of its own inline loop (it can call `appendBlocksRecursive` with `children: []` on every node, since report rows are flat).
4. No behavior change intended beyond what Phase 0 already introduced — this phase is a pure internal consolidation. The existing CLI contracts of `property-to-content.js` and `compare-databases.js` (which drives `lib/report.js`) should stay identical.

## Verification (once this is picked up)

**Phase 0:**
- Run each script (`property-to-content.js`, `compare-databases.js`, `workflowy-to-notion.js`, `getPage.js`) against scratch data/pages before and after the version bump; diff resulting page content via `fetchPageContentTree`/`blockTreeToPlainText` (`lib/notion.js`) to confirm no behavior drift from the SDK upgrade itself.
- Specifically re-run `workflowy-to-notion.js` against content with images to confirm the new `fileUploads.create/send/complete` path uploads and attaches images identically to the old `fetch`-based path.

**Phase 1:**
- Re-run `property-to-content.js` against a scratch database/property with content deep enough to exercise multi-level recursion (3+ nested list levels) and wide enough to exceed 100 siblings at one level, before and after the refactor, and diff the resulting Notion page content tree.
- Re-run `compare-databases.js` against two scratch databases with enough differences to produce a report with >90 rows (to exercise the batching path), before and after, and confirm the report page content is identical.
- Confirm rate-limit/429 handling works via the shared helper's retry (neither old implementation in `property-to-content.js` or `lib/report.js` had this, so this is a net improvement to verify, not just a regression check).

## Not in scope

- Any change to `workflowy-to-notion.js`'s own block-append logic — it already uses the shared-quality helper via `lib/notion-blocks.js`; only the helper's *location* moves, and it picks up the upgraded client as shared infra.
- Any change to the martian-based Markdown-to-blocks conversion in `property-to-content.js` — only the append/recursion mechanism changes.
