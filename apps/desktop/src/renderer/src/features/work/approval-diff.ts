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
  const verb = diff.operation === 'create' ? '新建文件' : diff.operation === 'delete' ? '删除文件' : '修改文件'
  return `${verb} · +${diff.additions} −${diff.deletions}`
}
