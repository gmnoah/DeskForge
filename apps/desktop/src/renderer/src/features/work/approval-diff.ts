import { t } from '../../i18n'
import type { ApprovalDiffHunkView, ApprovalDiffLineView, ApprovalDiffView } from '../../types'

export type SideBySideRow =
  | { kind: 'hunk'; header: string }
  | { kind: 'pair'; left?: ApprovalDiffLineView; right?: ApprovalDiffLineView }

export function hunkHeader(hunk: ApprovalDiffHunkView): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
}

/** Pairs removed and added runs so a modified line sits next to its replacement. */
export function sideBySideRows(hunks: readonly ApprovalDiffHunkView[]): SideBySideRow[] {
  const rows: SideBySideRow[] = []
  for (const hunk of hunks) {
    rows.push({ kind: 'hunk', header: hunkHeader(hunk) })
    let index = 0
    while (index < hunk.lines.length) {
      const line = hunk.lines[index]!
      if (line.kind === 'context') { rows.push({ kind: 'pair', left: line, right: line }); index += 1; continue }
      const removed: ApprovalDiffLineView[] = []
      const added: ApprovalDiffLineView[] = []
      while (index < hunk.lines.length && hunk.lines[index]!.kind === 'del') removed.push(hunk.lines[index++]!)
      while (index < hunk.lines.length && hunk.lines[index]!.kind === 'add') added.push(hunk.lines[index++]!)
      for (let offset = 0; offset < Math.max(removed.length, added.length); offset += 1) {
        const left = removed[offset]
        const right = added[offset]
        rows.push({ kind: 'pair', ...(left ? { left } : {}), ...(right ? { right } : {}) })
      }
    }
  }
  return rows
}

export function diffSummary(diff: ApprovalDiffView): string {
  const verb = diff.operation === 'create' ? t('新建文件') : diff.operation === 'delete' ? t('删除文件') : t('修改文件')
  return `${verb} · +${diff.additions} −${diff.deletions}`
}

export function parseUnifiedDiffText(text: string, path: string): ApprovalDiffView {
  const lines = text.split(/\r?\n/)
  const hunks: ApprovalDiffHunkView[] = []
  let currentHunk: ApprovalDiffHunkView | null = null
  let additions = 0
  let deletions = 0
  let oldLine = 1
  let newLine = 1
  let note: string | undefined

  for (const line of lines) {
    if (line.startsWith('...')) {
      note = line
      continue
    }
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk)
      oldLine = parseInt(hunkMatch[1] ?? '1', 10)
      const oldLines = parseInt(hunkMatch[2] ?? '1', 10)
      newLine = parseInt(hunkMatch[3] ?? '1', 10)
      const newLines = parseInt(hunkMatch[4] ?? '1', 10)
      currentHunk = { oldStart: oldLine, oldLines, newStart: newLine, newLines, lines: [] }
      continue
    }
    if (!currentHunk) {
      if (line.startsWith('+') || line.startsWith('-')) {
        currentHunk = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [] }
      } else {
        continue
      }
    }

    if (line.startsWith('+')) {
      additions++
      currentHunk.lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ })
    } else if (line.startsWith('-')) {
      deletions++
      currentHunk.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++ })
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  const operation = deletions === 0 && additions > 0 ? 'create' : additions === 0 && deletions > 0 ? 'delete' : 'modify'

  return {
    path,
    operation,
    additions,
    deletions,
    hunks,
    text,
    truncated: false,
    omittedLines: 0,
    binary: false,
    tooLarge: false,
    ...(note ? { note } : {}),
  }
}
