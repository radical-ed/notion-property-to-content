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

**Note:** I recommend testing the script on test page/database first to
make sure the way the content is processed works for you.

## Comparing two databases

If you have two databases that originated from the same import and want to
find out how they've diverged, use `compare-databases.js`:

```sh
node compare-databases.js <database-id-a> <database-id-b> [report-parent-page-id]
```

Rows are matched by their title (the database's Title-type property,
whatever it's named). For every title found in either database, it
compares:

- **Page content** — whether one side is empty while the other has content,
  or both have content but it differs.
- **Properties** — any property whose value differs between the two rows.
  Relations, rollups, formulas, and other computed/ID-based properties are
  skipped since they aren't meaningful to compare across two databases.
- Rows whose title only exists in one of the two databases are reported as
  "Missing in DB A/B".

Differences are printed to the console and written to
`database-differences.tsv`. If you pass a `report-parent-page-id` (the ID of
a Notion page to create the report under) and differences were found, it
will ask for confirmation before creating a report page there containing
a table with, for each difference: the title, links to the row in both
databases, and the type(s) of difference found.
