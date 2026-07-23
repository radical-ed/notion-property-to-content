const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// Workflowy's shared-outline share pages are a JS SPA whose client fetches
// the outline from an internal, undocumented API using a share_id embedded
// in the page's HTML. The anonymous session cookie issued when loading that
// page is enough to call the same endpoints the web client uses - no login
// required. See docs/workflowy-to-notion.md for the full reverse-engineered
// API reference.
export async function resolveShare (shareUrl) {
  const response = await fetch(shareUrl, {
    headers: { 'User-Agent': USER_AGENT }
  })
  if (!response.ok) {
    throw new Error(`Failed to load Workflowy share page (${response.status}): ${shareUrl}`)
  }
  const html = await response.text()
  const cookieHeader = extractCookieHeader(response)

  const match = html.match(/PROJECT_TREE_DATA_URL_PARAMS\s*=\s*(\{[^}]*\})/)
  if (!match) {
    throw new Error('Could not find PROJECT_TREE_DATA_URL_PARAMS in Workflowy share page - the page structure may have changed')
  }
  const { share_id: shareId } = JSON.parse(match[1])
  if (!shareId) {
    throw new Error('Workflowy share page did not contain a share_id')
  }

  return { shareId, cookieHeader }
}

function extractCookieHeader (response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)

  return setCookies
    .map(cookie => cookie.split(';')[0])
    .join('; ')
}

async function workflowyFetch (path, cookieHeader) {
  const response = await fetch(`https://workflowy.com${path}`, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookieHeader
    }
  })
  if (!response.ok) {
    throw new Error(`Workflowy request failed (${response.status}): ${path}`)
  }
  return response.json()
}

// Returns the flat list of all items in the shared tree: { id, nm, prnt, pr, metadata }.
export async function fetchTree (shareId, cookieHeader) {
  const data = await workflowyFetch(`/get_tree_data/?share_id=${encodeURIComponent(shareId)}&include_main_tree=1`, cookieHeader)
  return data.items
}

// Resolves the numeric owner id of the shared tree, needed to build file-proxy URLs.
export async function fetchOwnerId (shareId, cookieHeader) {
  // client_version/client_version_v2 are required - omitting them makes the
  // endpoint 503 ("server_error") rather than 400, which cost a while to
  // track down. Values mirror what the share page's own JS sends.
  const data = await workflowyFetch(`/get_initialization_data?share_id=${encodeURIComponent(shareId)}&include_main_tree=1&no_root_children=1&client_version=21&client_version_v2=28`, cookieHeader)
  const info = data.projectTreeData?.auxiliaryProjectTreeInfos?.[0]
  if (!info?.ownerId) {
    throw new Error('Could not resolve Workflowy tree owner id from initialization data')
  }
  return info.ownerId
}

// Resolves a short-lived presigned S3 URL for an image/file item's original bytes.
export async function resolveImageUrl (ownerId, itemId, cookieHeader) {
  const data = await workflowyFetch(`/file-proxy/signed-original/${ownerId}/${itemId}/?attempt=1`, cookieHeader)
  if (!data.url) {
    throw new Error(`Workflowy did not return a signed URL for item ${itemId}`)
  }
  return data.url
}

export async function downloadImage (url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download Workflowy image (${response.status}): ${url}`)
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType }
}
