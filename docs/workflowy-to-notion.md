# workflowy-to-notion.js

Migrates a Workflowy outline (bullet, with all its nested bullets, bold/italic
text, and embedded images) into a new Notion page. Written because Workflowy's
built-in export and browser "Save as" both drop images, and there's no
supported way to get an image-preserving export.

## Usage

```
NOTION_TOKEN=... node workflowy-to-notion.js <workflowy-share-url> <notion-parent-page-id>
```

- `<workflowy-share-url>` — a Workflowy **share link** for the bullet you want
  to migrate (right-click the bullet → Share → create a link). The link does
  not need to be public/discoverable ("secret" share links work fine) — the
  script only needs to be able to load it once to establish an anonymous
  session.
- `<notion-parent-page-id>` — the Notion page the new page will be created
  under. The integration behind `NOTION_TOKEN` must already have access to
  it (share the page with the integration in Notion first), same as the
  other scripts in this repo.

The script creates **one new Notion page**, titled after the shared bullet's
own text, containing the whole nested outline:

- Bullets with children become Notion **toggle** blocks (collapsible),
  matching Workflowy's own collapsible-outline feel — useful since a large
  outline would otherwise render as one very long wall of text.
- Leaf bullets become `bulleted_list_item` blocks.
- Images become `image` blocks, uploaded directly into Notion (not linked
  externally — Workflowy's image URLs are short-lived presigned links, so
  they can't be used as Notion `external` image blocks).
- Bold/italic formatting is preserved.

No Workflowy login is required — see below for why.

## Why no login/browser is needed: Workflowy's internal API

Workflowy is a JS single-page app; a share link's initial HTML is nearly
empty, and the outline is fetched client-side from an **internal,
undocumented** API. This was reverse-engineered by inspecting Workflowy's own
JS bundle and confirmed with live requests. It's worth keeping this note even
if the script itself is never touched again, so it doesn't need to be
re-derived.

**1. Load the share page to get a `share_id` and a session cookie.**

```
GET https://workflowy.com/s/<slug>/<share-token>
```

The response HTML embeds:

```html
<script>
  var PROJECT_TREE_DATA_URL_PARAMS = {"share_id": "BQb8.b3s4oTJRAG"};
</script>
```

Note the `share_id` is **not** the token in the URL — it must be parsed out
of the page. The response also sets a `sessionid` cookie (anonymous, no
account needed). All subsequent requests need that cookie.

**2. Fetch the outline tree.**

```
GET /get_tree_data/?share_id=<share_id>&include_main_tree=1
Cookie: sessionid=...
```

Returns `{ items: [...], shared_projects, most_recent_operation_transaction_id, server_expanded_projects_list }`.
`items` is a **flat list** (not nested) of every item in the shared subtree:

```json
{
  "id": "080d5493-1cd1-dc0c-5717-7e8bff42dcf8",
  "nm": "Str 93 Strategy layer",
  "prnt": "2506213e-c7a7-f15c-f778-da45aec36adf",
  "pr": 700,
  "metadata": {}
}
```

- `nm` — the bullet's text, as light HTML. In the tree this was built
  against, only `<b>` and `<i>` tags appeared, but treat this as
  best-effort/unbounded (Workflowy's own editor supports more).
- `prnt` — parent item id. The single item whose `prnt` isn't any other
  item's id is the root (the shared bullet itself).
- `pr` — sibling sort order (ascending).
- `metadata.s3File` — present when an image/file is attached to this item:
  `{ isFile: true, fileName, fileType, objectFolder }`. Two shapes occur:
  - A dedicated bullet with `nm: ""` that *is* the image (pasted as its own
    bullet).
  - A bullet with real text that also has an image attached directly to it
    (shown as a thumbnail under that bullet's own row in Workflowy's UI).

**3. Resolve the tree owner's numeric id (needed for image URLs).**

```
GET /get_initialization_data?share_id=<share_id>&include_main_tree=1&no_root_children=1&client_version=21&client_version_v2=28
Cookie: sessionid=...
```

Returns `projectTreeData.auxiliaryProjectTreeInfos[0].ownerId`. `client_version`/
`client_version_v2` are required — omitting them returns `503 {"error":
"server_error"}` rather than a helpful 400, which is easy to lose time to.
The values above mirror what the share page's own JS bundle sends
(`CLIENT_VERSION = 21`, `client_version_v2 = "28"` at the time this was
written) — if Workflowy bumps them, requests may start failing again and the
current values need re-checking in the page's embedded `<script>` source.

**4. Resolve and download each image's original bytes.**

```
GET /file-proxy/signed-original/<ownerId>/<itemId>/?attempt=1
Cookie: sessionid=...
```

Returns `{ "url": "<presigned S3 URL>" }`. A plain, unauthenticated `GET` on
that URL downloads the original file bytes. The presigned URL is short-lived
— resolve and download it promptly rather than caching it.

None of these endpoints are documented by Workflowy and could change without
notice; if this script starts failing, re-derive the current shape by loading
a share link in a browser with devtools open and watching the network tab for
`get_tree_data`/`get_initialization_data`/`file-proxy` requests, or by
downloading Workflowy's current JS bundle and grepping for those strings.

## Notion's File Upload API

The repo's installed `@notionhq/client` version (`1.0.4`) predates Notion's
File Upload API, and `@tryfabric/martian` (used by `property-to-content.js`)
only ever emits `external`-URL image blocks — no use here since Workflowy's
image URLs expire. So `lib/notion-blocks.js` calls Notion's File Upload API
directly via `fetch` (Node's built-in `fetch`/`FormData`/`Blob`, no new
dependency needed). Verified against the live API with `Notion-Version:
2022-06-28`:

1. **Create the upload object:**
   ```
   POST https://api.notion.com/v1/file_uploads
   { "filename": "...", "content_type": "..." }
   ```
   Returns `{ id, upload_url, status: "pending", expiry_time, ... }`. If
   unattached, this expires (observed: 1 hour after creation) — upload and
   attach promptly, don't batch-create these far ahead of use.

2. **Send the bytes:**
   ```
   POST <upload_url>   (multipart/form-data, field name "file")
   ```
   Returns the same object with `status: "uploaded"`.

3. **Reference it in a block**, instead of `external`:
   ```json
   { "type": "image", "image": { "type": "file_upload", "file_upload": { "id": "<id>" } } }
   ```

## Related

- `docs/plans/2026-07-23-workflowy-to-notion.md` — the implementation plan.
- `docs/plans/2026-07-23-notion-scripts-cleanup-proposal.md` — a follow-up
  proposal (not yet scheduled) to consolidate the block-appending logic this
  script introduces (`appendBlocksRecursive` in `lib/notion-blocks.js`) with
  the older, similar-but-messier logic already in `property-to-content.js`
  and `lib/report.js`.
