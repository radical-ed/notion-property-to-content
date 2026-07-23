# Plan: migrate a Workflowy bullet (with images) into a Notion page

Date: 2026-07-23
Status: implemented (see `workflowy-to-notion.js`, `lib/workflowy.js`, `lib/notion-blocks.js`, `docs/workflowy-to-notion.md`)

## Context

The user has a Workflowy bullet ("Výpisky") with ~435 nested bullets, bold/italic text, and 102 embedded images. Workflowy's built-in export and browser "Save as" both drop the images, so there's no clean path to Notion. The user created a secret share link (`https://workflowy.com/s/vypisky/zGEW3SclSRG6oYob`) for the bullet.

During planning, Workflowy's internal (undocumented) API used by its own web client was reverse-engineered and confirmed end-to-end with live `curl` calls against the user's share link: the whole pipeline works **without any login or browser** — the anonymous session cookie issued when loading the share page is sufficient for everything, including downloading full-resolution original images.

1. `GET /s/vypisky/zGEW3SclSRG6oYob` → response HTML embeds `PROJECT_TREE_DATA_URL_PARAMS = {"share_id": "BQb8.b3s4oTJRAG"}` and sets a `sessionid` cookie.
2. `GET /get_tree_data/?share_id=<id>&include_main_tree=1` (with that cookie) → full flat JSON list of all 435 items: `{id, nm, prnt, pr, metadata}`. `nm` is the bullet text as light HTML (only `<b>` and `<i>` tags appear in this tree). Image/file attachments are their own child items with `nm: ""` and `metadata.s3File: {fileName, fileType, objectFolder}`.
3. `GET /get_initialization_data?share_id=<id>` → resolves the tree owner's numeric `ownerId` (329468 for this tree).
4. For each image item: `GET /file-proxy/signed-original/{ownerId}/{itemId}/?attempt=1` → `{url: <presigned S3 URL>}`, then a plain `GET` on that URL downloads the original image bytes (verified against the real tree: got back a real 1062×1863 PNG).

This means a browser/login isn't necessary — a script using only `fetch` can pull everything from the share link. The one real gap was on the Notion side: the installed `@notionhq/client@1.0.4` predates Notion's File Upload API, and `@tryfabric/martian` (used elsewhere in this repo) only ever emits `external`-URL image blocks — useless here since Workflowy's image URLs are short-lived presigned links. So image bytes are uploaded to Notion directly via Notion's File Upload API, called with raw `fetch` (Node 20 has built-in `fetch`/`FormData`/`Blob`, so no new dependency was needed).

Chosen representation (per user's choice): bullets with children become Notion **toggle** blocks; leaf bullets become `bulleted_list_item`; image items become `image` blocks.

Full reverse-engineered API reference lives in `docs/workflowy-to-notion.md`, kept separate from this plan so it survives even if this plan doc is never read again.

## Files added

- **`lib/workflowy.js`** — Workflowy-side fetching, isolated from Notion code:
  - `resolveShare(shareUrl)` — GET the share URL, capture `Set-Cookie` cookies manually (small manual cookie-header join; no cookie-jar library needed), regex out `PROJECT_TREE_DATA_URL_PARAMS`'s `share_id`. Returns `{ shareId, cookieHeader }`.
  - `fetchTree(shareId, cookieHeader)` — GET `/get_tree_data/?share_id=...&include_main_tree=1`, return `items[]`.
  - `fetchOwnerId(shareId, cookieHeader)` — GET `/get_initialization_data?share_id=...`, pull `ownerId` out of `projectTreeData.auxiliaryProjectTreeInfos[0]`.
  - `resolveImageUrl(ownerId, itemId, cookieHeader)` — GET `/file-proxy/signed-original/{ownerId}/{itemId}/?attempt=1`, return the presigned URL.
  - `downloadImage(url)` — plain GET, return `{ buffer, contentType }`.

- **`lib/notion-blocks.js`** — Notion block-building/upload helpers, kept separate from `lib/notion.js`'s existing read/diff helpers:
  - `htmlToRichText(html)` — small regex-based tokenizer over Workflowy's `nm` field (handles `<b>`/`<i>`/HTML entities; strips unrecognized tags defensively) producing a Notion `rich_text` array with `annotations.bold`/`italic`, chunked to Notion's 2000-char-per-text-object limit.
  - `uploadImageToNotion(token, buffer, filename, contentType)` — implements Notion's 3-step File Upload API directly via `fetch` (create `file_upload` object → `POST` multipart bytes to its `upload_url` → return the `file_upload` id to reference in an `image` block as `{ type: 'file_upload', file_upload: { id } }`).
  - `appendBlocksRecursive(notion, parentId, blockTree)` — appends an arbitrarily-deep block tree to a Notion page/block. Each node is `{ payload, children }` where `payload` is the Notion block object *without* a nested `children` key. Always appends the current level stripped of children (batched to 90 per `blocks.children.append` call), then recurses into each returned block id for its own children. This sidesteps Notion's "2 levels of nesting per call" limit uniformly. Includes retry-with-backoff on HTTP 429 (respecting `Retry-After`).

- **`workflowy-to-notion.js`** (repo root, `#!/usr/bin/env node`) — orchestration:
  1. CLI: `node workflowy-to-notion.js <workflowy-share-url> <notion-parent-page-id>`.
  2. `resolveShare` → `fetchTree` + `fetchOwnerId`.
  3. Build `id -> item` map and `parentId -> children[]` (sorted by `pr` ascending) from the flat item list; find the single root item (the one whose `prnt` isn't any other item's id) — this is the shared bullet itself and becomes the new Notion page's title.
  4. Walk the tree once to collect all image items (`metadata.s3File`), then download and upload each with a small concurrency cap and retry-on-429/5xx.
  5. Recursively convert the Workflowy tree into the `{ payload, children }` shape: text bullets → `toggle` (if they have children) or `bulleted_list_item` (leaf), rich text via `htmlToRichText`; image items → `image` blocks referencing the uploaded `file_upload` id.
  6. `notion.pages.create({ parent: { page_id: <arg> }, properties: { title: [...] }, children: [] })` using `createNotionClient` from `lib/notion.js`, then `appendBlocksRecursive` to populate it.
  7. Log progress and the new page URL at the end.

- **`docs/workflowy-to-notion.md`** — usage doc + the reverse-engineered Workflowy/Notion API reference.

## Verification

1. Run against the real share link and a scratch Notion page: `NOTION_TOKEN=... node workflowy-to-notion.js https://workflowy.com/s/vypisky/zGEW3SclSRG6oYob <parent-page-id>`.
2. Open the resulting Notion page and spot-check: nesting/toggle structure matches Workflowy's outline, bold/italic text rendered correctly, a sample of images (including at least one deeply-nested one) display correctly and at usable resolution.
3. Confirm bullet count roughly matches (435 items minus 102 image items ≈ 333 text bullets, plus 102 image blocks) — sanity check nothing silently got dropped due to rate-limit errors.
4. Confirm the script fails loudly (not silently) if `NOTION_TOKEN` is missing or the Notion parent page id is inaccessible to the integration.

## Related

See `docs/plans/2026-07-23-notion-scripts-cleanup-proposal.md` for a follow-up proposal (not part of this task) to consolidate the block-appending logic this script introduces with the older, similar logic already in `property-to-content.js` and `lib/report.js`.
