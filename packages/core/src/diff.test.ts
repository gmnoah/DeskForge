import { describe, expect, it } from 'vitest'

import { createFileDiff, diffLines, splitLines } from './diff'

const apply = (a: string[], b: string[]): string[] => diffLines(a, b).filter((edit) => edit.kind !== 'del').map((edit) => (edit.kind === 'equal' ? a[edit.oldIndex]! : b[edit.newIndex]!))

describe('createFileDiff', () => {
  it('renders a new file as all additions', () => {
    const diff = createFileDiff({ path: 'notes/todo.md', before: null, after: '# 待办\n- 一\n- 二\n' })
    expect(diff).toMatchObject({ operation: 'create', additions: 3, deletions: 0, truncated: false })
    expect(diff.text).toBe('--- /dev/null\n+++ b/notes/todo.md\n@@ -0,0 +1,3 @@\n+# 待办\n+- 一\n+- 二\n')
    expect(diff.hunks[0]!.lines.every((line) => line.kind === 'add')).toBe(true)
  })

  it('renders deletion as all removals', () => {
    const diff = createFileDiff({ path: 'a.txt', before: 'x\ny\n', after: null })
    expect(diff).toMatchObject({ operation: 'delete', additions: 0, deletions: 2 })
    expect(diff.text).toBe('--- a/a.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n')
  })

  it('produces minimal hunks with context and line numbers', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    const afterLines = before.split('\n')
    afterLines[4] = 'line 5 changed'
    afterLines.splice(15, 0, 'inserted')
    const diff = createFileDiff({ path: 'src/a.ts', before, after: afterLines.join('\n') })
    expect(diff).toMatchObject({ operation: 'modify', additions: 2, deletions: 1 })
    expect(diff.hunks).toHaveLength(2)
    expect(diff.text).toContain('@@ -2,7 +2,7 @@\n line 2\n line 3\n line 4\n-line 5\n+line 5 changed\n line 6')
    expect(diff.text).toContain('@@ -13,6 +13,7 @@')
    const changed = diff.hunks[0]!.lines.find((line) => line.kind === 'add')!
    expect(changed).toMatchObject({ newLine: 5, text: 'line 5 changed' })
  })

  it('truncates large diffs with a note', () => {
    const after = Array.from({ length: 1_000 }, (_, index) => `row ${index}`).join('\n')
    const diff = createFileDiff({ path: 'big.csv', before: null, after, maxLines: 50 })
    expect(diff.truncated).toBe(true)
    expect(diff.omittedLines).toBe(950)
    expect(diff.hunks[0]!.lines).toHaveLength(50)
    expect(diff.text.trimEnd().endsWith('… 已截断 950 行（完整差异共 1000 行）')).toBe(true)
    expect(diff.additions).toBe(1_000)
  })

  it('summarizes binary, oversized and unchanged inputs', () => {
    expect(createFileDiff({ path: 'x.bin', before: 'a\u0000b', after: 'c' })).toMatchObject({ binary: true, hunks: [] })
    expect(createFileDiff({ path: 'x.txt', before: 'a'.repeat(20), after: 'b', maxInputBytes: 10 })).toMatchObject({ tooLarge: true, truncated: true })
    expect(createFileDiff({ path: 'x.txt', before: 'same\n', after: 'same\n' })).toMatchObject({ identical: true, note: '内容没有变化' })
    expect(createFileDiff({ path: 'x.txt', before: 'same', after: 'same\n' })).toMatchObject({ identical: false, note: '仅行尾换行符不同' })
  })

  it('handles CRLF input and falls back to block replacement when edit distance is huge', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    const a = Array.from({ length: 300 }, (_, index) => `a${index}`)
    const b = Array.from({ length: 300 }, (_, index) => `b${index}`)
    const edits = diffLines(a, b, 10)
    expect(edits.filter((edit) => edit.kind === 'del')).toHaveLength(300)
    expect(apply(a, b)).toEqual(b)
  })

  it('always yields an edit script that reproduces the target', () => {
    let seed = 7
    const random = (): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }
    for (let round = 0; round < 50; round += 1) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)))
      const b = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)))
      expect(apply(a, b)).toEqual(b)
      const edits = diffLines(a, b)
      expect(edits.filter((edit) => edit.kind !== 'add').map((edit) => a[edit.oldIndex])).toEqual(a)
    }
  })
})
