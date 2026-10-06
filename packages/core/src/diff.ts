/**
 * Line-based unified diff used for approval previews and change artifacts.
 * Myers' algorithm on the trimmed middle section; if the edit distance is
 * too large it falls back to a (still correct) block replacement.
 */

export type DiffOperation = 'create' | 'modify' | 'delete'

export interface DiffLine {
  kind: 'context' | 'add' | 'del'
  text: string
  oldLine?: number
  newLine?: number
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  operation: DiffOperation
  additions: number
  deletions: number
  hunks: DiffHunk[]
  /** Unified diff text (possibly truncated, with a trailing note). */
  text: string
  truncated: boolean
  omittedLines: number
  identical: boolean
  binary: boolean
  tooLarge: boolean
  note?: string
}

export interface FileDiffInput {
  path: string
  /** `null` means the file does not exist yet. */
  before: string | null
  /** `null` means the file will be removed. */
  after: string | null
  context?: number
  /** Maximum hunk body lines kept in `hunks` and `text`. */
  maxLines?: number
  /** Inputs above this size are summarized instead of diffed line by line. */
  maxInputBytes?: number
  maxEditDistance?: number
}

export const DIFF_DEFAULTS = { context: 3, maxLines: 400, maxInputBytes: 2 * 1024 * 1024, maxEditDistance: 2_000 } as const

type Edit = { kind: 'equal' | 'add' | 'del'; oldIndex: number; newIndex: number }

export function splitLines(value: string): string[] {
  if (value === '') return []
  const lines = value.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function myers(a: string[], b: string[], maxD: number): Edit[] | undefined {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(max, maxD); d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1 }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, a.length, b.length)
    }
  }
  return undefined
}

function backtrack(trace: Int32Array[], n: number, m: number): Edit[] {
  const edits: Edit[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const slice = trace[d]!
    // slice covers k in [-d-1, d+1]; index = k + d + 1
    const at = (k: number): number => slice[k + d + 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { x -= 1; y -= 1; edits.push({ kind: 'equal', oldIndex: x, newIndex: y }) }
    if (d > 0) {
      if (x === prevX) { y -= 1; edits.push({ kind: 'add', oldIndex: x, newIndex: y }) } else { x -= 1; edits.push({ kind: 'del', oldIndex: x, newIndex: y }) }
    }
  }
  return edits.reverse()
}

export function diffLines(a: string[], b: string[], maxEditDistance: number = DIFF_DEFAULTS.maxEditDistance): Edit[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const edits: Edit[] = []
  for (let index = 0; index < prefix; index += 1) edits.push({ kind: 'equal', oldIndex: index, newIndex: index })
  const middle = myers(midA, midB, maxEditDistance) ?? [
    ...midA.map((_, index) => ({ kind: 'del' as const, oldIndex: index, newIndex: 0 })),
    ...midB.map((_, index) => ({ kind: 'add' as const, oldIndex: midA.length, newIndex: index })),
  ]
  for (const edit of middle) edits.push({ kind: edit.kind, oldIndex: edit.oldIndex + prefix, newIndex: edit.newIndex + prefix })
  for (let index = 0; index < suffix; index += 1) edits.push({ kind: 'equal', oldIndex: a.length - suffix + index, newIndex: b.length - suffix + index })
  return edits
}

function buildHunks(edits: Edit[], a: string[], b: string[], context: number): DiffHunk[] {
  const hunks: DiffHunk[] = []
  const changeIndexes = edits.map((edit, index) => (edit.kind === 'equal' ? -1 : index)).filter((index) => index >= 0)
  if (!changeIndexes.length) return hunks
  let groupStart = changeIndexes[0]!
  let groupEnd = groupStart
  const groups: Array<[number, number]> = []
  for (const index of changeIndexes.slice(1)) {
    if (index - groupEnd > context * 2) { groups.push([groupStart, groupEnd]); groupStart = index }
    groupEnd = index
  }
  groups.push([groupStart, groupEnd])
  for (const [start, end] of groups) {
    const from = Math.max(0, start - context)
    const to = Math.min(edits.length - 1, end + context)
    const lines: DiffLine[] = []
    let oldLines = 0
    let newLines = 0
    for (let index = from; index <= to; index += 1) {
      const edit = edits[index]!
      if (edit.kind === 'equal') { lines.push({ kind: 'context', text: a[edit.oldIndex]!, oldLine: edit.oldIndex + 1, newLine: edit.newIndex + 1 }); oldLines += 1; newLines += 1 } else if (edit.kind === 'del') { lines.push({ kind: 'del', text: a[edit.oldIndex]!, oldLine: edit.oldIndex + 1 }); oldLines += 1 } else { lines.push({ kind: 'add', text: b[edit.newIndex]!, newLine: edit.newIndex + 1 }); newLines += 1 }
    }
    const first = edits[from]!
    hunks.push({ oldStart: oldLines ? first.oldIndex + 1 : first.oldIndex, oldLines, newStart: newLines ? first.newIndex + 1 : first.newIndex, newLines, lines })
  }
  return hunks
}

const PREFIX: Record<DiffLine['kind'], string> = { context: ' ', add: '+', del: '-' }

export function createFileDiff(input: FileDiffInput): FileDiff {
  const context = Math.max(0, input.context ?? DIFF_DEFAULTS.context)
  const maxLines = Math.max(1, input.maxLines ?? DIFF_DEFAULTS.maxLines)
  const maxInputBytes = input.maxInputBytes ?? DIFF_DEFAULTS.maxInputBytes
  const operation: DiffOperation = input.before === null ? 'create' : input.after === null ? 'delete' : 'modify'
  const before = input.before ?? ''
  const after = input.after ?? ''
  const header = `--- ${operation === 'create' ? '/dev/null' : `a/${input.path}`}\n+++ ${operation === 'delete' ? '/dev/null' : `b/${input.path}`}\n`
  const base = { path: input.path, operation, hunks: [] as DiffHunk[], truncated: false, omittedLines: 0, identical: false, binary: false, tooLarge: false }

  if (before.includes('\u0000') || after.includes('\u0000')) {
    const note = '二进制文件，无法显示逐行对比'
    return { ...base, additions: 0, deletions: 0, binary: true, identical: before === after, note, text: `${header}${note}\n` }
  }
  if (before.length > maxInputBytes || after.length > maxInputBytes) {
    const note = `文件超过 ${Math.round(maxInputBytes / 1024)} KB，未生成逐行对比`
    return { ...base, additions: splitLines(after).length, deletions: splitLines(before).length, tooLarge: true, truncated: true, note, text: `${header}${note}\n` }
  }

  const a = splitLines(before)
  const b = splitLines(after)
  const edits = diffLines(a, b, input.maxEditDistance)
  const additions = edits.filter((edit) => edit.kind === 'add').length
  const deletions = edits.filter((edit) => edit.kind === 'del').length
  if (!additions && !deletions) {
    const note = before === after ? (operation === 'create' ? '新建空文件' : '内容没有变化') : '仅行尾换行符不同'
    return { ...base, additions, deletions, identical: before === after, note, text: `${header}${note}\n` }
  }

  const allHunks = buildHunks(edits, a, b, context)
  const hunks: DiffHunk[] = []
  let kept = 0
  let total = 0
  for (const hunk of allHunks) {
    total += hunk.lines.length
    if (kept >= maxLines) continue
    const room = maxLines - kept
    if (hunk.lines.length <= room) { hunks.push(hunk); kept += hunk.lines.length } else { hunks.push({ ...hunk, lines: hunk.lines.slice(0, room) }); kept += room }
  }
  const omittedLines = total - kept
  const body = hunks.map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.map((line) => `${PREFIX[line.kind]}${line.text}`).join('\n')}\n`).join('')
  const note = omittedLines > 0 ? `… 已截断 ${omittedLines} 行（完整差异共 ${total} 行）` : undefined
  return {
    ...base,
    additions,
    deletions,
    hunks,
    truncated: omittedLines > 0,
    omittedLines,
    ...(note ? { note } : {}),
    text: `${header}${body}${note ? `${note}\n` : ''}`,
  }
}
