/** Line-preserving chunker for the workspace knowledge index. */

export interface TextChunk {
  ordinal: number
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  text: string
}

export interface ChunkOptions {
  maxChars?: number
  maxLines?: number
  /** Prefer breaking at a blank line or heading once a chunk has this many characters. */
  softChars?: number
}

const isBoundary = (line: string): boolean => line.trim() === '' || /^#{1,6}\s/.test(line)

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = options.maxChars ?? 1_200
  const maxLines = options.maxLines ?? 60
  const softChars = options.softChars ?? Math.floor(maxChars * 0.6)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const chunks: TextChunk[] = []
  let buffer: string[] = []
  let chars = 0
  let start = 1
  const flush = (endLine: number) => {
    const body = buffer.join('\n')
    if (body.trim()) chunks.push({ ordinal: chunks.length, startLine: start, endLine, text: body })
    buffer = []
    chars = 0
    start = endLine + 1
  }
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!
    const lineNumber = index + 1
    // Very long single lines (minified code, CSV rows) are cut so one chunk stays bounded.
    if (line.length > maxChars) line = `${line.slice(0, maxChars)}…`
    if (buffer.length && (chars + line.length + 1 > maxChars || buffer.length >= maxLines || (chars >= softChars && isBoundary(line)))) {
      flush(lineNumber - 1)
    }
    if (!buffer.length) start = lineNumber
    buffer.push(line)
    chars += line.length + 1
  }
  if (buffer.length) flush(lines.length)
  return chunks
}
