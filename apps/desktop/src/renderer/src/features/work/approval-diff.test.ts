import { describe, expect, it } from 'vitest'
import { normalizeApprovalDiff } from '../../bridge'
import { diffSummary, sideBySideRows } from './approval-diff'

describe('approval diff view', () => {
  const diff = normalizeApprovalDiff({
    kind: 'file_diff', path: 'src/a.ts', operation: 'modify', additions: 3, deletions: 1, text: '', truncated: false, omittedLines: 0, binary: false, tooLarge: false,
    hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, lines: [
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'b', oldLine: 2 },
      { kind: 'add', text: 'B', newLine: 2 },
      { kind: 'add', text: 'B2', newLine: 3 },
      { kind: 'context', text: 'c', oldLine: 3, newLine: 4 },
      { kind: 'add', text: 'd', newLine: 5 },
    ] }],
  })!

  it('normalizes untrusted preview payloads', () => {
    expect(diff.hunks[0]!.lines).toHaveLength(6)
    expect(normalizeApprovalDiff({ path: 'x', operation: 'rename' })).toBeUndefined()
    expect(normalizeApprovalDiff(null)).toBeUndefined()
    expect(diffSummary(diff)).toBe('修改文件 · +3 −1')
  })

  it('pairs removals with additions for the side-by-side view', () => {
    const rows = sideBySideRows(diff.hunks)
    expect(rows[0]).toEqual({ kind: 'hunk', header: '@@ -1,3 +1,5 @@' })
    expect(rows.slice(1).map((row) => row.kind === 'pair' ? [row.left?.text ?? null, row.right?.text ?? null] : null)).toEqual([
      ['a', 'a'], ['b', 'B'], [null, 'B2'], ['c', 'c'], [null, 'd'],
    ])
  })
})
