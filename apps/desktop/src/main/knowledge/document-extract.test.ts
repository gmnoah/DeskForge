import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extractXlsxText } from './xlsx-text'
import { extractPdfText } from './pdf-text'
import { knowledgeFileKind } from './file-policy'

function makeZip(files: Array<{ name: string; content: string }>): Buffer {
  const parts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const raw = Buffer.from(file.content, 'utf8')
    const compressed = deflateRawSync(raw)
    const nameBuf = Buffer.from(file.name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)

    parts.push(local, nameBuf, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)

    centralParts.push(central, nameBuf)
    offset += local.length + nameBuf.length + compressed.length
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...parts, ...centralParts, end])
}

describe('Document extraction', () => {
  it('extracts structured tables from xlsx worksheets and sharedStrings', () => {
    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets>
    <sheet name="业务报表" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`

    const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>项目名称</t></si>
  <si><t>状态</t></si>
  <si><t>DeskForge v2</t></si>
</sst>`

    const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1"><v>预算</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="B2" t="inlineStr"><is><t>进行中</t></is></c>
      <c r="C2"><v>50000</v></c>
    </row>
  </sheetData>
</worksheet>`

    const xlsxBuf = makeZip([
      { name: 'xl/workbook.xml', content: workbookXml },
      { name: 'xl/sharedStrings.xml', content: sharedStringsXml },
      { name: 'xl/worksheets/sheet1.xml', content: sheet1Xml },
    ])

    const text = extractXlsxText(xlsxBuf)
    expect(text).toContain('### 工作表：业务报表')
    expect(text).toContain('| 项目名称 | 状态 | 预算 |')
    expect(text).toContain('| DeskForge v2 | 进行中 | 50000 |')
  })

  it('extracts text from PDF binary using unpdf', async () => {
    const minimalPdf = '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>/Contents 4 0 R>>endobj\n' +
      '4 0 obj<</Length 44>>stream\n' +
      'BT /F1 12 Tf 100 700 Td (Hello DeskForge PDF!) Tj ET\n' +
      'endstream\n' +
      'endobj\n' +
      'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000216 00000 n \n' +
      'trailer<</Size 5/Root 1 0 R>>\nstartxref\n310\n%%EOF'

    const text = await extractPdfText(Buffer.from(minimalPdf))
    expect(text).toContain('Hello DeskForge PDF!')
    expect(text).toContain('--- 第 1 页 ---')
  })

  it('classifies pdf and xlsx files under knowledgeFileKind policy', () => {
    expect(knowledgeFileKind('report.pdf')).toBe('pdf')
    expect(knowledgeFileKind('data.xlsx')).toBe('xlsx')
    expect(knowledgeFileKind('doc.docx')).toBe('docx')
    expect(knowledgeFileKind('script.py')).toBe('code')
    expect(knowledgeFileKind('readme.txt')).toBe('text')
  })
})
