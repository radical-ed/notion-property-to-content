# Reapply a database template to existing pages

Date: 2026-07-24
Status: implemented (`reapply-template.js` / `lib/template-reapply.js`)

## Context

The user's GTD system (Notion) has databases (e.g. `Contexts`, `Projects`)
whose "new item" template contains a structure of headers: some are toggles
wrapping a linked view of another database (e.g. an "Actions" toggle showing
that context's open actions, filtered and configured a specific way), others
are plain headings under which the user writes freeform notes. Notion has no
built-in way to re-push template edits onto pages created earlier from that
template - editing the template only affects pages created *after* the edit.
Concretely: the `Contexts` template's "Actions" view has `Tags` visible, but
existing rows created before that edit still have it hidden.

`reapply-template.js` walks every row of a database and reapplies the current
template's structure, merging rather than overwriting: existing headers (and
whatever the user wrote under them) are left alone; only database-view
sections get their view configuration (filter, property visibility, sorts,
group-by) actively reapplied, since - unlike freeform notes - a view's config
is meant to always match the template, not accumulate local edits.

## What the public API actually supports (found by testing directly, 2026-07-24)

The installed `@notionhq/client` (5.23.2, Notion API version `2025-09-03`)
turned out to expose far more than the rest of this repo uses:

- `dataSources.listTemplates` - lists a data source's page templates
  (id/name/is_default). No endpoint returns full template *content* through
  this list - you fetch the template like any other page (`pages.retrieve` +
  the usual block-children endpoints).
- `views.list` / `views.retrieve` / `views.create` / `views.update` - full
  read/write access to a database's (or an inline linked database's) views:
  filter, `quick_filters`, sorts, `configuration` (property visibility/order/
  width, group-by, etc).
- `pages.create`/`pages.update` accept a `template: { type: 'template_id',
  template_id }` field that looks like exactly what we'd want - but **it's a
  no-op**: tested against two different templates (one trivial, one with the
  full toggle+view structure), applied to both a fresh page and an existing
  one, `erase_content: true` and without - in every case the resulting page
  had zero content blocks. Not usable; this script reimplements the merge
  itself instead, same philosophy as `property-to-content.js`.

## The "dynamic filter" mechanism

A template's linked-view toggle (e.g. "Actions") filters on a relation
property using `quick_filters`, e.g. for Contexts:

```json
"quick_filters": {
  "vLEb": { "relation": { "contains": "<the template page's own id>" } }
}
```

On a real row, the same view's `quick_filters.vLEb.contains` is that row's
*own* page id instead. So "reapply the template's filter" just means: deep-
clone the template view's `filter`/`quick_filters`, and substitute the
template's page id for the target page's id anywhere it appears as a string
(`substituteSelfReferences` in `lib/template-reapply.js`). Verified end to
end on the real `Contexts` → `To Watch` row: the view's `Tags` visibility now
matches the template, and its `quick_filters` still correctly points at
`To Watch`'s own id, not the template's.

## A real API limitation: no nesting a new linked view inside a toggle

`views.create`'s `create_database.parent` only accepts `{ type: 'page_id' }`
- confirmed by testing `position: { type: 'after_block', block_id }` with the
block_id of a block *inside* a toggle: the API rejects it ("not a child of
the parent page"). A brand-new linked database view can only be created as a
**direct child of the page**. Existing rows in this workspace already have
their toggle-wrapping-child_database structure (created some other way,
possibly manually or by an older template-apply flow), so *updating* those
in place works fine and is the common case. But if a section is missing
entirely on some row, the best this script can do is recreate it as a
heading/toggle block followed immediately by the linked view as a sibling -
functionally identical (same filtered view) but not visually nested/
collapsible the way the template's is. Every occurrence of this compromise is
called out in the run's log and console summary so it can be tidied up by
hand in the Notion UI if it matters.

## Merge semantics

Per template, walk its top-level blocks and group them into "segments", each
starting at a header block (`heading_1/2/3` or `toggle`):

- **View segment** (a toggle wrapping a `child_database` block): the target
  page's matching toggle (matched by block type + exact header text) has its
  linked view(s) config replaced wholesale from the template (with self-
  reference substitution). If the toggle exists but its view was deleted, or
  the toggle doesn't exist at all, the view is (re)created flat per the
  limitation above.
- **Text segment** (a heading, or a toggle with no view): if a matching
  header already exists on the page, it - and everything the user wrote under
  it - is left untouched. If missing, the header (and the template's trivial
  placeholder content under it, e.g. an empty paragraph) is appended.

Property reapply is a separate, opt-in flag (`--properties`, or answered
interactively at the start if not passed). When on: for every property that
has a *non-empty* value on the template page, that value **overwrites**
whatever the target page currently has (not just fills blanks) - this
matches what the user actually asked for, since most template properties are
blank placeholders and the few that are meaningfully set (e.g. a default
Status) are meant to be pushed out deliberately and sparingly, not on every
run by default.

## CLI

```
node reapply-template.js <database-id> [--properties|--content-only] [--template=<name-or-id>] [--only=<page-id>[,<page-id>...]] [--dry-run] [--yes]
```

- No `--properties`/`--content-only` and running interactively → asked at
  the start (matches the original ask: "have options or ask at the start").
- No `--template` and the data source has more than one → asked to pick
  interactively; non-interactively, it's an error asking for `--template`.
- `--only` restricts the run to specific page ids - useful for validating
  against one row (as done here against `Contexts` → `To Watch`) before
  running the full database.
- Logs live to `out/reapply-template-log-<timestamp>.txt` as each page
  finishes (not just at the end - established convention from
  `archive-to-backup.js`), with a per-action-type summary and finish
  timestamp/duration at the end.

## Out of scope / open questions for later

- Header matching is exact (same block type + same trimmed text). Renaming a
  template header means every row gets the new header *added* rather than
  the old one being renamed/merged - old header stays as extra content. Fine
  for now, no data loss, just a manual tidy-up if it happens.
- Only `heading_1/2/3` and `toggle` are treated as headers; other structural
  block types (columns, callouts-as-headers, etc.) aren't recognized.
- Content under a missing text-segment header is only rebuilt for simple
  rich-text block types (paragraph/heading/list-item/quote/callout); richer
  placeholder content (images, tables) is skipped with a warning rather than
  guessed at.
- Multiple views per toggle are supported (matched by order), but not
  reordering/removing a target's extra views beyond what the template has.
