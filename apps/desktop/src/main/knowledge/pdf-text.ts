import { extractText } from 'unpdf'

/**
 * Lightweight, zero-native-compilation PDF text extraction.
 * Uses unpdf (bundled pdf.js engine) to extract page-by-page text cleanly.
 */

export interface ExtractPdfOptions {
  maxPages?: number
  maxChars?: number
}

export async function extractPdfText(
  buffer: Buffer,
  options: ExtractPdfOptions = {},
): Promise<string> {
  const { maxPages = 50, maxChars = 200_000 } = options
  const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  let result
  try {
    result = await extractText(uint8)
  } catch (err: any) {
    throw new Error(`PDF 解析失败: ${err?.message || String(err)}`)
  }

  const rawPages = Array.isArray(result.text) ? result.text : [result.text]
  const pages = rawPages.filter((p): p is string => typeof p === 'string')

  if (pages.length === 0 || (pages.length === 1 && !pages[0]?.trim())) {
    return '（PDF 文件无文字内容或为纯扫描图片）'
  }

  const sliced = pages.slice(0, maxPages)
  let text = sliced
    .map((pageText, idx) => `--- 第 ${idx + 1} 页 ---\n${(pageText || '').trim()}`)
    .join('\n\n')
    .trim()

  if (pages.length > maxPages) {
    text += `\n\n*（文档共 ${pages.length} 页，已截断展示前 ${maxPages} 页）*`
  }

  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n\n*（文档文字较长，已截断）*'
  }

  return text
}
