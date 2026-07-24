# Archive Notion pages to a backup account

Date: 2026-07-23
Status: implemented (`archive-to-backup.js` / `lib/archive.js`)

## Context

The user keeps a "root archive" page in their primary Notion account holding
content they want out of that account's search entirely, for privacy,
without losing the content. `archive-to-backup.js` copies everything under a
given root page into a second Notion account (a different integration token
= a different workspace/account), verifies the copy, then blanks out the
originals in place so they read as archived stubs rather than disappearing
outright — so a second run, or anyone who follows an old link, can tell what
happened.

This considered a future generalization — multiple source roots, and a
separate non-destructive "backup" mode (copy/merge, leave source alone) —
but only today's single-root "archive" mode is implemented; the rest is a
documented open question below, not code.

Decisions locked in before implementation:
- **Destination auth**: second env var `NOTION_BACKUP_TOKEN`, alongside the
  existing `NOTION_TOKEN` for the source. No new CLI flags for secrets.
- **Content Notion can't faithfully copy across accounts** (synced blocks,
  user/page mentions, non-portable database properties, etc.): skip that
  piece, warn, keep going — never abort a whole page over one unsupported
  block.
- **Every run writes a timestamped log** to `out/` (gitignored): summary
  stats (targets found/succeeded/skipped/failed) plus full warning and error
  detail.
- **Source stub**: title gets an `[archived] ` prefix, plus one paragraph
  block linking to the new copy's URL in the destination account.
- **Nested databases**: basic support — schema (minus non-portable property
  types) + rows + each row's own page content, not views/filters/sorts.

## How Notion's block/page model shapes this

A page *is* a block (a `child_page` block's `id` equals the sub-page's page
id), and `fetchPageContentTree` (`lib/notion.js`) already recurses into a
`child_page` block's own children when walking a tree. That has two
consequences here:

1. **Trashing a page's blocks cascades.** Archiving/deleting a `child_page`
   block trashes that entire sub-page and everything nested under it, same
   as using Notion's UI trash on a page. So "wipe the source" doesn't need
   to individually visit every nested subpage — deleting the direct children
   of one top-level page removes its whole subtree in one pass.
2. Because of (1), the unit of work is **each direct child of the root
   page** (a `child_page` or `child_database` block one level under the
   given root), not every page in the tree individually. Each such child is
   copied as a whole subtree, validated, then that *one* top-level source
   page becomes the `[archived]` stub — nested pages underneath it are
   trashed along with it, not separately stubbed.

This is a load-bearing assumption about Notion's trash-cascade behavior —
confirm it empirically on the first real (non-dry-run) run (see
Verification in the codebase's plan, or just check the destination/source
manually) before relying on it further at scale.

## What the implementation does (`lib/archive.js`)

- `discoverArchiveTargets` — lists the root's direct children, classifies
  each as `page` / `database` / non-page-skip, and flags anything already
  titled with the `[archived] ` marker so a re-run against a
  partially-completed root skips what's already done (idempotency).
- `processTargets` — for each actionable target: copy → validate → (unless
  `--dry-run`) stub the source. A failure on one target is recorded and the
  run continues with the next target rather than aborting.
- Page copy walks one block level at a time (not one deep upfront fetch), so
  file blocks' temporary signed URLs stay fresh, and interleaves ordinary
  block batches with page/database creation in source order — creating all
  sub-pages only after appending every ordinary block would silently
  reorder content relative to the source and break the validation diff.
- File-like blocks (`image`/`file`/`pdf`/`video`/`audio` with
  `type: 'file'`) are downloaded from their signed URL and re-uploaded via
  the existing `uploadImageToNotion` (`lib/notion-blocks.js` — already
  generic despite the name); `external`-type file blocks pass through
  unchanged.
- rich_text `mention` runs of type `user`/`page`/`database` are downgraded
  to plain text of their rendered label (destination account can't resolve
  source-account ids); `date` mentions pass through.
- Skip list (drop + warn): `synced_block`, `ai_block`, `unsupported`,
  `template`, `breadcrumb`, `link_to_page`; a `child_page`/`child_database`
  nested inside a *non*-page block (e.g. inside a toggle, rather than
  directly under a page) is also skipped + warned — supporting that would
  need the destination id of a not-yet-created parent block, which
  `appendBlocksRecursive` doesn't expose.
- Database copy drops the same non-portable property types
  `lib/notion.js`'s `SKIPPED_PROPERTY_TYPES` already names for comparison
  purposes (`relation`/`rollup`/`formula`/computed fields), plus `status`
  (can't be created via the API), `people` and `files` (values reference
  source-account users/files with no destination equivalent) — reusing that
  existing set rather than redefining it, with `title` carved out as a kept
  exception since every database needs one.
- Validation compares title + a filtered plain-text block-tree diff (source
  tree with anything this run's warnings already recorded as intentionally
  skipped removed first, so a known/logged gap isn't reported as a bug) via
  the existing `fetchPageContentTree`/`blockTreeToPlainText`. Database
  targets additionally diff each row's properties via the existing
  `diffProperties`, restricted to keys present in both schemas (dropped
  columns are an intentional, already-logged scope decision).
- The source stub: archives every direct child block of the page (cascades
  per the model above), renames the page with the archived marker, appends
  one paragraph linking back to the copy. A database target has no
  equivalent "blank but still a database" state, so its block is archived
  outright and a stub *page* is created next to it under the root instead.

## Explicitly out of scope (v1)

- Database views/filters/sorts, multi-data-source databases (consistent
  with `getDataSourceId`'s existing single-data-source assumption).
- Rewriting page/database mentions to point at the new destination ids
  (would need a full copy-everything-first-then-rewrite two-pass approach).
- Multi-part file uploads for anything over the single-part size limit
  already noted in `lib/notion-blocks.js` — logged as a failure for that one
  block, not fatal for the whole page.
- `--mode=backup` and multi-root config — see below.

## Future extensibility (documented, not implemented)

- **Multiple source roots**: the core logic already lives in `lib/archive.js`
  as `discoverArchiveTargets`/`processTargets`, called once per root by the
  thin CLI script rather than inlined — so a later `--config <file>` flag
  looping over several `{sourceRootId, destinationParentId}` pairs is an
  orchestration-only change, not a rewrite.
- **`backup` mode** (copy/merge, leave source untouched, re-runnable to pick
  up source changes): already a recognized `--mode` value that just exits
  with "not implemented yet" today, so the CLI contract won't need to
  change later. The open design gap is identity — nothing today lets a
  second run recognize "this destination page already corresponds to that
  source page" in order to update rather than duplicate it. Likely answer is
  a marker (hidden property or block) on the destination copy recording the
  source page id, but that's deferred until backup mode is actually built.
