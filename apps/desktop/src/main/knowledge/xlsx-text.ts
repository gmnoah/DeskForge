import { decodeXmlEntities, readZipEntries } from './docx-text'

/**
 * Minimal zero-dependency .xlsx text and tabular extractor.
 * Reads sharedStrings, workbook metadata, and worksheet XMLs directly from the ZIP.
 * Formats spreadsheet data into structured Markdown tables for LLM comprehension and FTS indexing.
 */

export interface ExtractXlsxOptions {
  maxRowsPerSheet?: number
  maxChars?: number
  maxSheets?: number
}

function colNameToIndex(colName: string): number {
  let index = 0
  for (let i = 0; i < colName.length; i++) {
    const code = colName.charCodeAt(i)
    if (code >= 65 && code <= 90) {
      index = index * 26 + (code - 64)
    } else if (code >= 97 && code <= 122) {
      index = index * 26 + (code - 96)
    }
  }
  return Math.max(0, index - 1)
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = []
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/gi
  let match: RegExpExecArray | null
  while ((match = siRegex.exec(xml)) !== null) {
    const siContent = match[1] ?? ''
    const tMatches = siContent.match(/<t\b[^>]*>([\s\S]*?)<\/t>/gi) ?? []
    const combined = tMatches.map((tTag) => tTag.replace(/<[^>]+>/g, '')).join('')
    strings.push(decodeXmlEntities(combined))
  }
  return strings
}

interface SheetInfo {
  name: string
  sheetPath: string
}

function parseWorkbookSheets(workbookXml: string, availablePaths: string[]): SheetInfo[] {
  const sheets: SheetInfo[] = []
  const sheetTagRegex = /<sheet\b([^>]*)\/>/gi
  let match: RegExpExecArray | null
  let index = 1
  while ((match = sheetTagRegex.exec(workbookXml)) !== null) {
    const attrs = match[1] ?? ''
    const nameMatch = attrs.match(/name="([^"]+)"/)
    const name = nameMatch ? decodeXmlEntities(nameMatch[1] ?? '') : `Sheet${index}`
    // Try matching xl/worksheets/sheet{index}.xml
    const expectedPath = `xl/worksheets/sheet${index}.xml`
    if (availablePaths.includes(expectedPath)) {
      sheets.push({ name, sheetPath: expectedPath })
    } else {
      const fallback = availablePaths.find((p) => p.startsWith('xl/worksheets/sheet') && p.endsWith('.xml'))
      if (fallback) sheets.push({ name, sheetPath: fallback })
    }
    index++
  }
  if (sheets.length === 0) {
    const sheetFiles = availablePaths.filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort()
    for (let i = 0; i < sheetFiles.length; i++) {
      const p = sheetFiles[i]
      if (p) sheets.push({ name: `Sheet${i + 1}`, sheetPath: p })
    }
  }
  return sheets
}

function parseWorksheetRows(xml: string, sharedStrings: string[], maxRows: number): { rows: string[][]; totalRows: number } {
  const rows: string[][] = []
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/gi
  let rowMatch: RegExpExecArray | null
  let totalRows = 0

  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    totalRows++
    if (rows.length >= maxRows) continue

    const rowContent = rowMatch[1] ?? ''
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi
    let cellMatch: RegExpExecArray | null
    const rowCells: Record<number, string> = {}
    let maxCol = -1

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const attrs = cellMatch[1] || cellMatch[3] || ''
      const body = cellMatch[2] || ''

      const rMatch = attrs.match(/r="([A-Za-z]+)\d+"/)
      const tMatch = attrs.match(/t="([^"]+)"/)
      const type = tMatch ? tMatch[1] : undefined

      const colIdx = rMatch && rMatch[1] ? colNameToIndex(rMatch[1]) : (maxCol + 1)
      if (colIdx > maxCol) maxCol = colIdx

      let val = ''
      if (type === 's') {
        const vMatch = body.match(/<v>([^<]+)<\/v>/)
        if (vMatch && vMatch[1]) {
          const sIdx = parseInt(vMatch[1], 10)
          val = sharedStrings[sIdx] ?? ''
        }
      } else if (type === 'inlineStr') {
        const tMatchInline = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)
        if (tMatchInline && tMatchInline[1]) {
          val = decodeXmlEntities(tMatchInline[1].replace(/<[^>]+>/g, ''))
        }
      } else if (type === 'b') {
        const vMatch = body.match(/<v>([^<]+)<\/v>/)
        val = vMatch && vMatch[1] === '1' ? 'TRUE' : 'FALSE'
      } else {
        const vMatch = body.match(/<v>([^<]+)<\/v>/)
        if (vMatch && vMatch[1]) {
          val = decodeXmlEntities(vMatch[1].trim())
        }
      }

      rowCells[colIdx] = val.replace(/[\r\n\t]+/g, ' ').trim()
    }

    if (maxCol >= 0) {
      const cells: string[] = []
      for (let c = 0; c <= maxCol; c++) {
        cells.push(rowCells[c] ?? '')
      }
      // Only keep row if not entirely empty
      if (cells.some((c) => c.length > 0)) {
        rows.push(cells)
      }
    }
  }

  return { rows, totalRows }
}

function formatMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  // Determine max columns
  const colCount = Math.max(...rows.map((r) => r.length))
  if (colCount === 0) return ''

  const lines: string[] = []
  const header = rows[0] ?? []
  const paddedHeader = Array.from({ length: colCount }, (_, i) => (header[i] || `列${i + 1}`).replace(/\|/g, '\\|'))
  lines.push(`| ${paddedHeader.join(' | ')} |`)
  lines.push(`| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`)

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? []
    const paddedRow = Array.from({ length: colCount }, (_, c) => (row[c] || '').replace(/\|/g, '\\|'))
    lines.push(`| ${paddedRow.join(' | ')} |`)
  }

  return lines.join('\n')
}

export function extractXlsxText(
  buffer: Buffer,
  options: ExtractXlsxOptions = {},
): string {
  const { maxRowsPerSheet = 200, maxChars = 100_000, maxSheets = 10 } = options

  const entries = readZipEntries(buffer, (name) => (
    name === 'xl/workbook.xml' ||
    name === 'xl/sharedStrings.xml' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  ))

  if (entries.size === 0) throw new Error('不是有效的 XLSX 文件或缺少工作表')

  const sharedStringsXml = entries.get('xl/sharedStrings.xml')?.toString('utf8')
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : []

  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8')
  const availablePaths = [...entries.keys()]
  const sheets = workbookXml ? parseWorkbookSheets(workbookXml, availablePaths) : availablePaths.filter((p) => p.startsWith('xl/worksheets/')).map((p, idx) => ({ name: `Sheet${idx + 1}`, sheetPath: p }))

  const sections: string[] = []
  const targetSheets = sheets.slice(0, maxSheets)

  for (const sheet of targetSheets) {
    const sheetBuf = entries.get(sheet.sheetPath)
    if (!sheetBuf) continue

    const { rows, totalRows } = parseWorksheetRows(sheetBuf.toString('utf8'), sharedStrings, maxRowsPerSheet)
    if (rows.length === 0) continue

    const table = formatMarkdownTable(rows)
    let section = `### 工作表：${sheet.name}\n\n${table}`
    if (totalRows > maxRowsPerSheet) {
      section += `\n\n*（该工作表共 ${totalRows} 行，已截断显示前 ${maxRowsPerSheet} 行）*`
    }
    sections.push(section)
  }

  if (sections.length === 0) {
    return '（XLSX 工作簿中无有效表格数据）'
  }

  let fullText = sections.join('\n\n---\n\n')
  if (fullText.length > maxChars) {
    fullText = fullText.slice(0, maxChars) + '\n\n*（表格内容过长，已截断）*'
  }
  return fullText
}
