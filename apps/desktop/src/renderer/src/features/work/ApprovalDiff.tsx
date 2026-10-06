import { useMemo, useState } from 'react'
import { Icon } from '../../icons'
import type { ApprovalDiffView } from '../../types'
import { diffSummary, sideBySideRows } from './approval-diff'

const MARK = { add: '+', del: '−', context: ' ' } as const

/** Readable diff of the pending file change, shown before the user approves. */
export function ApprovalDiff({ diff }: { diff: ApprovalDiffView }) {
  const [mode, setMode] = useState<'unified' | 'split'>('unified')
  const rows = useMemo(() => (mode === 'split' ? sideBySideRows(diff.hunks) : []), [diff.hunks, mode])
  const hasLines = diff.hunks.length > 0
  return (
    <section className="approval-diff" aria-label="变更预览">
      <header>
        <span className="approval-diff-path"><Icon name="file" size={14} /><strong title={diff.path}>{diff.path}</strong></span>
        <span className="approval-diff-stats"><em className={`diff-op diff-op-${diff.operation}`}>{diffSummary(diff)}</em></span>
        {hasLines && <span className="approval-diff-toggle" role="group" aria-label="对比方式">
          <button type="button" aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>统一</button>
          <button type="button" aria-pressed={mode === 'split'} onClick={() => setMode('split')}>并排</button>
        </span>}
      </header>
      {hasLines && mode === 'unified' && <div className="approval-diff-body mono" role="table">
        {diff.hunks.map((hunk, hunkIndex) => <div key={hunkIndex} role="rowgroup">
          <div className="diff-hunk-header" role="row">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
          {hunk.lines.map((line, lineIndex) => <div key={lineIndex} className={`diff-line diff-${line.kind}`} role="row">
            <span className="diff-gutter">{line.oldLine ?? ''}</span>
            <span className="diff-gutter">{line.newLine ?? ''}</span>
            <span className="diff-mark">{MARK[line.kind]}</span>
            <span className="diff-text">{line.text || ' '}</span>
          </div>)}
        </div>)}
      </div>}
      {hasLines && mode === 'split' && <div className="approval-diff-body split mono" role="table">
        {rows.map((row, index) => row.kind === 'hunk'
          ? <div key={index} className="diff-hunk-header" role="row">{row.header}</div>
          : <div key={index} className="diff-split-row" role="row">
            <span className={`diff-gutter ${row.left ? `diff-${row.left.kind}` : 'diff-empty'}`}>{row.left?.oldLine ?? ''}</span>
            <span className={`diff-text ${row.left ? `diff-${row.left.kind}` : 'diff-empty'}`}>{row.left ? row.left.text || ' ' : ''}</span>
            <span className={`diff-gutter ${row.right ? `diff-${row.right.kind}` : 'diff-empty'}`}>{row.right?.newLine ?? ''}</span>
            <span className={`diff-text ${row.right ? `diff-${row.right.kind}` : 'diff-empty'}`}>{row.right ? row.right.text || ' ' : ''}</span>
          </div>)}
      </div>}
      {(diff.note || diff.truncated) && <p className="approval-diff-note"><Icon name="info" size={13} />{diff.note ?? `… 已截断 ${diff.omittedLines} 行`}</p>}
    </section>
  )
}
