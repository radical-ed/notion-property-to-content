// Notion caps a single blocks.children.append call at 100 blocks (including
// the ones being appended in that call), so table rows are appended in chunks.
const ROW_CHUNK_SIZE = 90

function textCell (text) {
  return [{ type: 'text', text: { content: String(text ?? '').slice(0, 2000) } }]
}

function linkCell (text, url) {
  if (!url) {
    return textCell(text)
  }
  return [{ type: 'text', text: { content: String(text ?? '').slice(0, 2000), link: { url } } }]
}

function toTableRow (cells) {
  return { type: 'table_row', table_row: { cells } }
}

function differenceToRow (diff) {
  return toTableRow([
    textCell(diff.title),
    linkCell(diff.pageA ? 'Open →' : '—', diff.pageA?.url),
    linkCell(diff.pageB ? 'Open →' : '—', diff.pageB?.url),
    textCell(diff.types.join('; '))
  ])
}

// Creates a Notion page under `parentPageId` with a table listing all
// `differences` (as produced by compare-databases.js): title, links to the
// row in each database, and the type(s) of difference found.
export async function createComparisonReportPage (notion, parentPageId, { title, summary, databaseIdA, databaseIdB, differences }) {
  const headerRow = toTableRow([
    textCell('Title'),
    textCell('Row in A'),
    textCell('Row in B'),
    textCell('Difference')
  ])

  const firstChunk = differences.slice(0, ROW_CHUNK_SIZE).map(differenceToRow)
  const remainingChunks = []
  for (let i = ROW_CHUNK_SIZE; i < differences.length; i += ROW_CHUNK_SIZE) {
    remainingChunks.push(differences.slice(i, i + ROW_CHUNK_SIZE).map(differenceToRow))
  }

  const page = await notion.pages.create({
    parent: { page_id: parentPageId },
    properties: {
      title: { title: [{ type: 'text', text: { content: title } }] }
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: summary ?? `Comparing ${databaseIdA} and ${databaseIdB}.` } }]
        }
      },
      {
        object: 'block',
        type: 'table',
        table: {
          table_width: 4,
          has_column_header: true,
          has_row_header: false,
          children: [headerRow, ...firstChunk]
        }
      }
    ]
  })

  if (remainingChunks.length > 0) {
    const pageBlocks = await notion.blocks.children.list({ block_id: page.id })
    const tableBlock = pageBlocks.results.find(b => b.type === 'table')

    for (const chunk of remainingChunks) {
      await notion.blocks.children.append({
        block_id: tableBlock.id,
        children: chunk
      })
    }
  }

  return page
}
