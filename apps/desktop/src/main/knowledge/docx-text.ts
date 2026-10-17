import { inflateRawSync } from 'node:zlib'

/**
 * Minimal .docx text extraction: locate `word/document.xml` through the ZIP
 * central directory, inflate it with a size cap and flatten paragraphs.
 * Avoids a heavyweight dependency for the knowledge index.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

export function readZipEntries(
  buffer: Buffer,
  predicate: (name: string) => boolean,
  maxBytesPerEntry = 30 * 1024 * 1024,
): Map<string, Buffer> {
  const searchStart = Math.max(0, buffer.length - 65_557)
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/DOCX 文件')
  const entries = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const results = new Map<string, Buffer>()
  for (let index = 0; index < entries && cursor + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const entryName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength
    if (!predicate(entryName)) continue
    if (uncompressedSize > maxBytesPerEntry) throw new Error(`文件条目 ${entryName} 过大`)
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`文件条目 ${entryName} 本地文件头无效`)
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    const data = buffer.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) {
      results.set(entryName, Buffer.from(data))
    } else if (method === 8) {
      results.set(entryName, inflateRawSync(data, { maxOutputLength: maxBytesPerEntry }))
    } else {
      throw new Error(`不支持的 ZIP 压缩方式：${method}`)
    }
  }
  return results
}

export function readZipEntry(buffer: Buffer, name: string, maxBytes: number): Buffer | undefined {
  const entries = readZipEntries(buffer, (entryName) => entryName === name, maxBytes)
  return entries.get(name)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return ENTITIES[entity] ?? match
  })
}

export function docxXmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:(?:br|cr)\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractDocxText(buffer: Buffer, maxXmlBytes = 30 * 1024 * 1024): string {
  const xml = readZipEntry(buffer, 'word/document.xml', maxXmlBytes)
  if (!xml) throw new Error('DOCX 中缺少 word/document.xml')
  return docxXmlToText(xml.toString('utf8'))
}
