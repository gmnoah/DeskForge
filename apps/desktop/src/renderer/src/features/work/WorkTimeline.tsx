import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BrandMark, Icon } from '../../icons'
import type { DocumentPreviewTarget, RunDetailView } from '../../types'
import { buildWorkTurns, type ResultEvidence } from '../../work-turn'
import type { WorkTurnViewModel } from '../../work-turn.types'
import { ProcessDisclosure } from './ProcessDisclosure'
import { failureMessage, failureTechnicalDetail, readTokenUsage, tokenUsageSummary } from './run-insights'

const REMARK_PLUGINS = [remarkGfm]
const PRE_COMPONENT = ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>

interface WorkTimelineProps {
  detail: RunDetailView
  approvals?: ReactNode
  onOpenDetails: () => void
  onOpenChanges: () => void
  onOpenArtifact?: ((id: string) => void) | undefined
  onOpenPath?: ((path: string) => void) | undefined
  onPreviewDocument?: ((target: DocumentPreviewTarget) => void) | undefined
}

function formatTime(value?: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
}

function safeHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  let language = ''
  let rawCode = ''

  if (children && typeof children === 'object' && 'props' in children) {
    const props = (children as { props?: { className?: string; children?: unknown } }).props
    if (props) {
      const match = /language-([a-zA-Z0-9_-]+)/.exec(props.className || '')
      if (match?.[1]) {
        language = match[1]
      }
      if (typeof props.children === 'string') {
        rawCode = props.children
      } else if (Array.isArray(props.children)) {
        rawCode = props.children.map((c) => (typeof c === 'string' ? c : '')).join('')
      } else if (props.children) {
        rawCode = String(props.children)
      }
    }
  } else if (typeof children === 'string') {
    rawCode = children
  }

  const handleCopy = async () => {
    const textToCopy = rawCode.trimEnd()
    if (!textToCopy) return
    try {
      await navigator.clipboard.writeText(textToCopy)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // fallback if clipboard API unavailable
    }
  }

  const displayLang = language ? language.toUpperCase() : 'CODE'

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-language">{displayLang}</span>
        <button
          type="button"
          className={`code-block-copy-btn${copied ? ' is-copied' : ''}`}
          onClick={handleCopy}
          aria-label={copied ? '已复制' : '复制代码'}
          title={copied ? '已复制到剪贴板' : '复制代码'}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          <span>{copied ? '已复制' : '复制代码'}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

export const Markdown = memo(function Markdown({
  children,
  onOpenPath,
  onPreviewDocument,
}: {
  children: string
  onOpenPath?: ((path: string) => void) | undefined
  onPreviewDocument?: ((target: DocumentPreviewTarget) => void) | undefined
}) {
  const components = useMemo<Components>(() => ({
    pre: PRE_COMPONENT,
    a: ({ href, children: linkChildren, ...props }) => {
      if (href && (href.startsWith('file://') || href.startsWith('/') || /^[a-zA-Z0-9_\u4e00-\u9fa5\s/.-]+\.(docx|doc|pdf|xlsx|xls|csv|png|jpg|jpeg|md|html|htm|txt|json|zip)$/i.test(href))) {
        const cleanPath = href.startsWith('file://') ? decodeURIComponent(href.replace('file://', '')) : href
        const isHtml = cleanPath.toLowerCase().endsWith('.html') || cleanPath.toLowerCase().endsWith('.htm')
        const isPreviewable = /\.(html|htm|md|txt|json|css|js|ts|svg|png|jpg|jpeg)$/i.test(cleanPath)
        return (
          <button
            type="button"
            className="inline-file-link"
            title={isPreviewable ? `点击内置预览：${cleanPath}` : `点击使用默认程序打开：${cleanPath}`}
            onClick={(e) => {
              e.preventDefault()
              if (isPreviewable && onPreviewDocument) {
                onPreviewDocument({ title: cleanPath.split('/').at(-1) ?? cleanPath, path: cleanPath })
              } else if (onOpenPath) {
                onOpenPath(cleanPath)
              }
            }}
          >
            <Icon name={isHtml ? 'globe' : 'file'} size={12} />
            {linkChildren}
          </button>
        )
      }
      const target = safeHref(href)
      return target
        ? <a {...props} href={target} target="_blank" rel="noreferrer noopener">{linkChildren}</a>
        : <span>{linkChildren}</span>
    },
  }), [onOpenPath, onPreviewDocument])

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        skipHtml
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})

function ResultSummary({
  result,
  onOpenDetails,
  onOpenChanges,
  onOpenArtifact,
  onOpenPath,
  onPreviewDocument,
}: {
  result: ResultEvidence
  onOpenDetails: () => void
  onOpenChanges: () => void
  onOpenArtifact?: ((id: string) => void) | undefined
  onOpenPath?: ((path: string) => void) | undefined
  onPreviewDocument?: ((target: DocumentPreviewTarget) => void) | undefined
}) {
  const changes = result.changes?.length ?? 0
  const outputs = useMemo(() => {
    const list = result.outputs ?? []
    const seen = new Set<string>()
    return list.filter((item) => {
      const kind = String(item.kind ?? '')
      if (kind === 'diff' || kind === 'checkpoint' || kind === 'file_snapshot' || kind === 'attachment') return false
      if (item.name.startsWith('context-checkpoint-') || item.name.endsWith('.before')) return false
      const key = item.path || item.name
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [result.outputs])
  const checks = result.checks?.length ?? 0
  const sources = result.sources?.length ?? 0
  if (!changes && !outputs.length && !checks && !sources) return null
  return (
    <div className="result-summary">
      <div className="result-summary-header">
        <div className="result-summary-items">
          {changes > 0 && <span><Icon name="edit" size={15} />修改了 {changes} 个文件</span>}
          {checks > 0 && <span><Icon name={result.status === 'partial' ? 'warning' : 'check'} size={15} />{result.status === 'partial' ? `还有内容未检查` : `${checks} 项检查通过`}</span>}
          {sources > 0 && <span><Icon name="globe" size={15} />{sources} 条来源</span>}
          {outputs.length > 0 && <span><Icon name="file" size={15} />{outputs.length} 个输出</span>}
        </div>
        <div className="result-summary-actions">
          {changes > 0 || outputs.length > 0 ? <button type="button" onClick={onOpenChanges}>查看变更</button> : null}
          {checks > 0 || sources > 0 ? <button type="button" onClick={onOpenDetails}>查看依据</button> : null}
        </div>
      </div>
      {outputs.length > 0 && (onOpenArtifact || onOpenPath || onPreviewDocument) && (
        <div className="result-summary-artifacts">
          {outputs.map((artifact) => {
            const isHtml = artifact.name.toLowerCase().endsWith('.html') || artifact.name.toLowerCase().endsWith('.htm')
            const handleAction = () => {
              if (onPreviewDocument) {
                onPreviewDocument({ title: artifact.name, artifactId: artifact.id, path: artifact.path })
              } else if (artifact.path && onOpenPath) {
                onOpenPath(artifact.path)
              } else if (onOpenArtifact) {
                onOpenArtifact(artifact.id)
              }
            }
            return (
              <button
                type="button"
                key={artifact.id}
                className="result-artifact-chip"
                title={`文件全称: ${artifact.name}${artifact.path ? `\n完整路径: ${artifact.path}` : ''}\n点击在 DeskForge 内置沙箱预览`}
                onClick={handleAction}
              >
                <Icon name={isHtml ? 'globe' : 'file'} size={13} />
                <span className="result-artifact-name" title={`文件全称: ${artifact.name}`}>{artifact.name}</span>
                <span className="result-artifact-action">{isHtml ? '网页预览' : '预览'}</span>
                <span className="result-artifact-tooltip" role="tooltip">
                  <span className="artifact-tooltip-label">文件全称</span>
                  <span className="artifact-tooltip-name">{artifact.name}</span>
                  {artifact.path ? (
                    <>
                      <span className="artifact-tooltip-label">完整路径</span>
                      <span className="artifact-tooltip-path">{artifact.path}</span>
                    </>
                  ) : null}
                  <span className="artifact-tooltip-hint">{isHtml ? '点击在 DeskForge 内置安全沙箱中预览网页' : '点击在 DeskForge 内置预览'}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface TurnRowProps {
  turn: WorkTurnViewModel
  isOptimistic: boolean
  approvals?: ReactNode
  processOpen: boolean
  onToggleProcess: (turnId: string) => void
  onOpenDetails: () => void
  onOpenChanges: () => void
  onOpenArtifact?: ((id: string) => void) | undefined
  onOpenPath?: ((path: string) => void) | undefined
  onPreviewDocument?: ((target: DocumentPreviewTarget) => void) | undefined
}

const TurnRow = memo(function TurnRow({
  turn,
  isOptimistic,
  approvals,
  processOpen,
  onToggleProcess,
  onOpenDetails,
  onOpenChanges,
  onOpenArtifact,
  onOpenPath,
  onPreviewDocument,
}: TurnRowProps) {
  return (
    <section className="work-turn">
      <article className={`message user-message${isOptimistic ? ' is-optimistic' : ''}`}>
        <div className="message-content">
          <div className="message-meta">
            <strong>你</strong>
            <span>{formatTime(turn.prompt.createdAt)}</span>
          </div>
          <Markdown onOpenPath={onOpenPath} onPreviewDocument={onPreviewDocument}>
            {turn.prompt.content}
          </Markdown>
        </div>
      </article>
      <article className="message agent-message agent-turn">
        <div className="message-avatar agent">
          <BrandMark size={17} />
        </div>
        <div className="message-content">
          <div className="message-meta">
            <strong>DeskForge</strong>
            <span>{formatTime(turn.response.updatedAt ?? turn.updatedAt)}</span>
          </div>
          <div className="agent-turn-entries">
            {turn.process && (
              <ProcessDisclosure
                timeline={turn.process}
                open={processOpen}
                onToggle={() => onToggleProcess(turn.id)}
              />
            )}
            {turn.response.content && (
              <div className="agent-turn-text">
                <Markdown onOpenPath={onOpenPath} onPreviewDocument={onPreviewDocument}>
                  {turn.response.content}
                </Markdown>
              </div>
            )}
            {turn.result && (
              <ResultSummary
                result={turn.result}
                onOpenDetails={onOpenDetails}
                onOpenChanges={onOpenChanges}
                onOpenArtifact={onOpenArtifact}
                onOpenPath={onOpenPath}
                onPreviewDocument={onPreviewDocument}
              />
            )}
          </div>
        </div>
      </article>
      {approvals}
    </section>
  )
})

export function WorkTimeline({ detail, approvals, onOpenDetails, onOpenChanges, onOpenArtifact, onOpenPath, onPreviewDocument }: WorkTimelineProps) {
  const tailRef = useRef<HTMLDivElement>(null)
  const followTailRef = useRef(true)
  const [openProcessTurnId, setOpenProcessTurnId] = useState<string>()
  const turns = useMemo(() => buildWorkTurns(detail), [detail])
  const tokenUsage = readTokenUsage(detail.tokenUsage)

  const onToggleProcess = useCallback((turnId: string) => {
    setOpenProcessTurnId((current) => current === turnId ? undefined : turnId)
  }, [])

  // Callers pass inline arrows; route them through a ref so memoized rows and
  // Markdown blocks are not re-parsed on every streamed delta.
  const handlersRef = useRef({ onOpenDetails, onOpenChanges, onOpenArtifact, onOpenPath, onPreviewDocument })
  useLayoutEffect(() => {
    handlersRef.current = { onOpenDetails, onOpenChanges, onOpenArtifact, onOpenPath, onPreviewDocument }
  })
  const hasArtifact = Boolean(onOpenArtifact)
  const hasPath = Boolean(onOpenPath)
  const hasPreview = Boolean(onPreviewDocument)
  const handlers = useMemo(() => ({
    onOpenDetails: () => handlersRef.current.onOpenDetails(),
    onOpenChanges: () => handlersRef.current.onOpenChanges(),
    onOpenArtifact: hasArtifact ? (id: string) => handlersRef.current.onOpenArtifact?.(id) : undefined,
    onOpenPath: hasPath ? (path: string) => handlersRef.current.onOpenPath?.(path) : undefined,
    onPreviewDocument: hasPreview ? (target: DocumentPreviewTarget) => handlersRef.current.onPreviewDocument?.(target) : undefined,
  }), [hasArtifact, hasPath, hasPreview])

  useEffect(() => {
    const scroller = tailRef.current?.closest('.run-scroll')
    if (!(scroller instanceof HTMLElement)) return undefined
    followTailRef.current = true
    const frame = requestAnimationFrame(() => tailRef.current?.scrollIntoView({ block: 'end' }))
    const update = () => { followTailRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 180 }
    scroller.addEventListener('scroll', update, { passive: true })
    return () => { cancelAnimationFrame(frame); scroller.removeEventListener('scroll', update) }
  }, [detail.id])

  useEffect(() => {
    if (!followTailRef.current) return undefined
    const frame = requestAnimationFrame(() => tailRef.current?.scrollIntoView({ block: 'end' }))
    return () => cancelAnimationFrame(frame)
  }, [detail.status, detail.toolCalls.length, detail.events.length, detail.approvals.length])

  return (
    <div className="timeline work-timeline">
      {turns.map((turn, index) => {
        const optimistic = turn.prompt.messageIds.some((id) => detail.events.some((event) => event.id === id && event.optimistic))
        return (
          <TurnRow
            key={turn.id}
            turn={turn}
            isOptimistic={optimistic}
            approvals={index === turns.length - 1 ? approvals : undefined}
            processOpen={openProcessTurnId === turn.id}
            onToggleProcess={onToggleProcess}
            {...handlers}
          />
        )
      })}
      {detail.status === 'failed' && <FailureNotice lastError={detail.lastError} />}
      {tokenUsage && <div className="run-token-usage" title="服务商返回的用量合计（含工具调用回合）">{tokenUsageSummary(tokenUsage)}</div>}
      <div ref={tailRef} className="timeline-tail" aria-hidden="true" />
    </div>
  )
}

function FailureNotice({ lastError }: { lastError: unknown }) {
  const technical = failureTechnicalDetail(lastError)
  return <div className="inline-notice error run-failure">
    <Icon name="warning" />
    <span>
      {failureMessage(lastError)}
      {technical && <details className="run-failure-detail"><summary>技术信息</summary><code>{technical}</code></details>}
    </span>
  </div>
}
