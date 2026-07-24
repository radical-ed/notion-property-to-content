# Notion property to content

> Notion API script to convert a property to the actual page content.

## Overview

Notion has a convenient feature to import CSV and other sources as a
database, but it doesn't allow setting the content of the pages it
creates.

To work around that, this script will take a property that contains the
content text (assumed to be Markdown) and appends it to the actual page
content.

## Requirements

[Node.js](https://nodejs.org/) version 18 or later.

## Installation

```sh
git clone https://github.com/valeriangalliat/notion-property-to-content
cd notion-property-to-content
npm install
```

## Usage

First, you need to create a Notion integration and invite it to the page
of the database you want to run the script on. You also need to identify
the ID of the database you're going to use. Follow the steps
[here](https://github.com/valeriangalliat/github-to-notion/#3-create-a-notion-integration)
for all of this.

After that, you should have your integration token exported in
a `NOTION_TOKEN` variable, and your Notion database ID on hand. You can
then run:

```sh
node property-to-content.js <database-id> <property>
```

Where `<database-id>` is the ID of the database you identified in the
previous step, and `<property>` is the name of the property that
contains the content.

It will go through all the entries where `<property>` is defined, and
append it to the page content.

Optionally, you can chose to remove the original property after it's
been added to the page content by running this instead:

```sh
node property-to-content <database-id> <property> --remove
```

With the `--remove` version, you can conveniently use the Notion "merge
with CSV" feature to import new rows, then run the script again. Because
the content property was emptied after being processed, only the new
rows will be processed!

Pages that already have content are skipped (a warning is printed) rather
than having content appended a second time; they're also listed in
`out/skipped-pages.txt`.

**Note:** I recommend testing the script on test page/database first to
make sure the way the content is processed works for you.

## Comparing two databases

If you have two databases that originated from the same import and want to
find out how they've diverged, use `compare-databases.js`:

```sh
node compare-databases.js <database-id-a> <database-id-b> [report-parent-page-id] [options]
```

Rows are matched by their title (the database's Title-type property,
whatever it's named). By default, for every title found in either database,
it compares:

- **Page content** — whether one side is empty while the other has content,
  or both have content but it differs.
- **Properties** — any property whose value differs between the two rows.
  Relations, rollups, formulas, and other computed/ID-based properties are
  skipped since they aren't meaningful to compare across two databases.
- Rows whose title only exists in one of the two databases are reported as
  "Missing in DB A/B".

Options:

- `--no-properties` — don't compare properties.
- `--no-content` — don't compare page content.
- `--one-way` — only check that database A's rows made it into B (and are
  the same). Rows that exist only in B are not reported. Use this when B is
  a merge target that's expected to contain rows beyond what came from A.

Differences are printed to the console and written to
`out/database-differences.tsv`. If you pass a `report-parent-page-id` (the
ID of a Notion page to create the report under) and differences were found,
it will ask for confirmation before creating a report page there containing
a table with, for each difference: the title, links to the row in both
databases, and the type(s) of difference found.

## Archiving pages to a backup Notion account

If you want to move content out of one Notion account's search entirely
(e.g. to a rarely-used backup account) without losing it, use
`archive-to-backup.js`:

```sh
node archive-to-backup.js <source-root-page-id> <destination-parent-page-id> [options]
```

Point `<source-root-page-id>` at a "root archive" page in your primary
account — every page (and database) that's a **direct child** of that page
is treated as one archive unit, whole subtree included. For each one, the
script:

1. Copies it, and everything nested under it (pages, databases and their
   rows, images/files, etc.), into `<destination-parent-page-id>` in the
   backup account.
2. Validates that the copy matches the source (title and content).
3. Blanks out the original: all of its content is trashed (which, since a
   page's sub-pages are just more of its content, removes the whole nested
   subtree from the source account in one step), its title is prefixed with
   `[archived] `, and one paragraph linking to the new copy is left behind.

You need two Notion integrations, one invited to the source page and one to
the destination page, with their tokens set as:

```sh
read NOTION_TOKEN
read NOTION_BACKUP_TOKEN
export NOTION_TOKEN         # source account
export NOTION_BACKUP_TOKEN  # destination (backup) account
```

Options:

- `--dry-run` — copy and validate, but don't touch the source. Useful to
  preview a run first.
- `--yes` — skip the "are you sure" confirmation prompt.
- `--mode=archive` — the default, and the only mode currently implemented.

Re-running the script on the same root page is safe: anything already
prefixed with `[archived] ` is detected and skipped, so an interrupted or
partial run can just be re-run to pick up where it left off.

Some content can't be faithfully copied across two different Notion
accounts (synced blocks, mentions of users/pages/databases, non-portable
database property types like relations or status). Those are skipped rather
than failing the whole page — every run writes a timestamped log to
`out/archive-log-<timestamp>.txt` with a summary and the full detail of
anything skipped or failed, so you can review it afterwards.

See `docs/plans/2026-07-23-notion-archive-to-backup-account.md` for the
design rationale, including what's explicitly out of scope for now (database
views/filters, full mention rewriting) and notes on extending this to
multiple source roots or a non-destructive "backup" (copy without removing
the original) mode in the future.
