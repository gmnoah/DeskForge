import { t, useLocale, getLocale } from '../../i18n'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { bridge } from '../../bridge'
import { Icon, type IconName } from '../../icons'
import type { DocumentPreviewTarget, GitStatusResult, JsonRecord, RunDetailView, SourceItem, TraceSpanItem, WorkbenchSnapshot } from '../../types'
import { EmptyState, Modal, Tabs } from '../../ui'
import { PanelResizer, usePersistentPanelWidth } from '../shell/panel-resizer'
import { readTokenUsage, tokenUsageLines } from './run-insights'
import { SessionRulesList } from './SessionRules'
import { ApprovalDiff } from './ApprovalDiff'
import { parseUnifiedDiffText } from './approval-diff'

export type WorkInspectorTab = 'details' | 'changes' | 'activity'

interface WorkInspectorProps {
  detail: RunDetailView
  snapshot: WorkbenchSnapshot
  requestedTab: WorkInspectorTab
  onBindChrome: () => void
  onOpenSettings: () => void
  onRevealArtifact: (id: string) => void
  onOpenArtifact?: ((id: string) => void) | undefined
  onOpenPath?: ((path: string) => void) | undefined
  onUndoChange: (id: string) => void
  onPreviewDocument?: ((target: DocumentPreviewTarget) => void) | undefined
}

const TOOL_LABELS: Record<string, string> = {
  get web_search() { return t('搜索网页') }, get web_fetch() { return t('读取网页') }, get file_list() { return t('浏览文件') }, get file_read() { return t('读取文件') }, get file_search() { return t('搜索工作区') }, get file_find() { return t('查找文件') }, get knowledge_search() { return t('检索知识库') }, get attachment_open() { return t('打开附件') }, get output_register() { return t('登记产物') },
  get file_write() { return t('写入文件') }, get file_replace() { return t('修改文件') }, get file_delete() { return t('移入废纸篓') }, get shell_run() { return t('运行命令') }, get process_start() { return t('启动后台进程') }, get process_poll() { return t('读取后台进程') }, get process_stop() { return t('停止后台进程') }, get document_render() { return t('导出 PDF') }, get task_plan() { return t('整理计划') },
  get task_step_update() { return t('更新步骤') }, get task_complete() { return t('完成检查') }, get skill_read() { return t('读取技能') }, get memory_propose() { return t('提出记忆') }, get agent_delegate() { return t('并行处理') },
  get chrome_snapshot() { return t('读取网页') }, get chrome_screenshot() { return t('网页截图') }, get chrome_navigate() { return t('打开网页') }, get chrome_click() { return t('点击网页') }, get chrome_type() { return t('网页输入') },
  get mcp_list_tools() { return t('发现连接能力') }, get mcp_call_tool() { return t('使用连接') },
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

function formatTime(value?: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatBytes(value?: number): string {
  if (value === undefined) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(value?: number): string {
  if (value === undefined) return ''
  if (value < 1_000) return `${Math.max(0, Math.round(value))} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
}

function sourceHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return t('网页来源') }
}

export function redactDiagnosticText(value: unknown): string {
  let serialized = ''
  try { serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2) } catch { return '' }
  return serialized
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[已隐藏密钥]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[已隐藏]')
    .replace(/("?(?:authorization|cookie|x-api-key|api[_-]?key)"?\s*:\s*")[^"]+/gi, '$1[已隐藏]')
    .replace(/\/Users\/[^/\s"']+\//g, '…/')
    .replace(/\/home\/[^/\s"']+\//g, '…/')
}

function sourcesFor(detail: RunDetailView): SourceItem[] {
  const items = new Map<string, SourceItem>()
  const add = (source: SourceItem) => { if (source.url) items.set(source.url, items.get(source.url) ?? source) }
  detail.sources.forEach(add)
  detail.toolCalls.forEach((tool) => tool.sources.forEach(add))
  return [...items.values()]
}

import { isHtmlArtifact, isUserVisibleArtifact } from './artifact-utils'
export { isUserVisibleArtifact }

function visibleOutputs(detail: RunDetailView) {
  return detail.artifacts.filter(isUserVisibleArtifact)
}

function artifactKindLabel(kind?: string): string {
  if (kind === 'final_output') return t('最终产物')
  if (kind === 'tool_result') return t('生成内容')
  return t('文件')
}

function Section({ title, icon, children }: { title: string; icon: IconName; children: ReactNode }) {
  useLocale()
  return <section className="inspector-section"><h3><Icon name={icon} size={15} />{title}</h3>{children}</section>
}

function DetailsPanel({ detail, snapshot, onBindChrome, onOpenSettings }: Pick<WorkInspectorProps, 'detail' | 'snapshot' | 'onBindChrome' | 'onOpenSettings'>) {
  useLocale()
  const workspace = snapshot.workspaces.find((item) => item.id === detail.workspaceId)
  const model = snapshot.models.find((item) => item.id === detail.modelProfileId)
  const sources = sourcesFor(detail)
  const verification = detail.verification
  const tokenUsage = readTokenUsage(detail.tokenUsage)
  const browserRelevant = snapshot.chrome.grants.some((grant) => grant.runId === detail.id)
    || detail.toolCalls.some((tool) => tool.toolName.startsWith('chrome_'))

  return <>
    {verification?.status && <Section title={t('检查')} icon={verification.status === 'partial' ? 'warning' : 'check'}>
      <div className={`verification-card verification-${verification.status}`}>
        <span><Icon name={verification.status === 'partial' ? 'warning' : 'check'} /></span>
        <div><strong>{verification.status === 'partial' ? t('还有内容未检查') : t('检查通过')}</strong><p>{verification.summary || (verification.status === 'partial' ? t('现有结果仍缺少部分依据。') : t('现有检查支持本次结果。'))}</p></div>
      </div>
      {verification.checks.length > 0 && <div className="verification-checks">{verification.checks.map((check, index) => <div key={`${check.name}-${index}`} className={`check-${check.status}`}><Icon name={check.status === 'passed' ? 'check' : check.status === 'failed' ? 'warning' : 'clock'} size={14} /><span><strong>{check.name}</strong>{check.detail && <small>{check.detail}</small>}</span></div>)}</div>}
    </Section>}

    {sources.length > 0 && <Section title={t('来源')} icon="globe"><div className="source-list">{sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer noopener" key={source.url}><span>{index + 1}</span><span><strong>{source.title || sourceHost(source.url)}</strong><small>{source.publisher || sourceHost(source.url)} · {source.status === 'verified' ? t('已核验') : source.status === 'fetched' ? t('已读取') : source.status === 'failed' ? t('读取失败') : t('搜索发现')}</small></span><Icon name="external" size={14} /></a>)}</div></Section>}

    <Section title={t('当前目标')} icon="tasks"><p className="inspector-goal">{detail.goal ?? detail.prompt ?? detail.title}</p></Section>

    <SessionRulesList runId={detail.id} refreshKey={`${detail.updatedAt ?? ''}:${detail.approvalHistory.length}:${detail.events.length}`} hideWhenEmpty wrap={(children) => <Section title={t('本会话自动允许')} icon="shield">{children}</Section>} />

    {tokenUsage && <Section title={t('Token 用量')} icon="layers"><div className="token-usage-list">{tokenUsageLines(tokenUsage).map((line) => <div key={line.label}><span>{line.label}</span><strong>{line.value}</strong></div>)}</div><p className="token-usage-note">{t('数据来自模型服务返回的 usage，仅统计本次工作。')}</p></Section>}

    {browserRelevant && <Section title={t('浏览器连接')} icon="globe"><div className="chrome-card"><div className="connection-line"><span className={`connection-dot ${snapshot.chrome.connected ? 'online' : ''}`} /><strong>{snapshot.chrome.connected ? t('已连接') : t('需要重新连接')}</strong></div><p>{snapshot.chrome.connected ? t('{0} 个标签页已授权；只能访问你主动绑定的标签页。', { 0: snapshot.chrome.grants.length }) : t('这项工作使用了浏览器能力，继续前需要恢复连接。')}</p>{snapshot.chrome.connected ? <button type="button" className="button secondary small" onClick={onBindChrome}>{t('绑定当前标签页')}</button> : <button type="button" className="button secondary small" onClick={onOpenSettings}>{t('查看连接设置')}</button>}</div></Section>}

    <details className="technical-disclosure">
      <summary><Icon name="layers" size={15} /><span>{t('本次使用')}</span><Icon name="chevronDown" size={14} /></summary>
      <div className="context-list">
        {workspace && <div><span className="context-icon"><Icon name="folder" size={14} /></span><span><strong>{workspace.name}</strong><small>{shortPath(workspace.path)}</small></span></div>}
        {model && <div><span className="context-icon"><Icon name="layers" size={14} /></span><span><strong>{model.name}</strong><small>{model.modelId}</small></span></div>}
        <div><span className="context-icon trusted"><Icon name="shield" size={14} /></span><span><strong>{t('执行权限')}</strong><small>{t('工作区内操作按需批准，不会授权 /')}</small></span></div>
        <div><span className="context-icon trusted"><Icon name="file" size={14} /></span><span><strong>{t('工程规范')}</strong><small>{t('遵循 AGENTS.md 规范与工作区规则')}</small></span></div>
      </div>
    </details>
  </>
}

const TRACE_KIND_LABELS: Record<TraceSpanItem['kind'], string> = {
  get run_turn() { return t('任务轮次') }, get context_stage() { return t('准备上下文') }, get model_turn() { return t('模型生成') }, get tool_call() { return t('执行工具') }, get approval_wait() { return t('等待确认') }, get checkpoint() { return t('压缩上下文') }, get verification() { return t('验证结果') }, get managed_process() { return t('后台进程') },
}

const TRACE_STATUS_LABELS: Record<TraceSpanItem['status'], string> = {
  get running() { return t('进行中') }, get waiting() { return t('等待中') }, get succeeded() { return t('已完成') }, get failed() { return t('失败') }, get cancelled() { return t('已取消') }, get interrupted() { return t('已中断') },
}

export function latestTraceSpans(detail: Pick<RunDetailView, 'traces' | 'traceSpans'>): TraceSpanItem[] {
  const latest = [...detail.traces].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
  if (!latest) return []
  return detail.traceSpans.filter((span) => span.traceId === latest.id)
}

export function traceDiagnosticHeadline(spans: TraceSpanItem[]): string {
  const active = [...spans].reverse().find((span) => span.status === 'waiting' || span.status === 'running')
  if (active) return `${TRACE_KIND_LABELS[active.kind]} · ${active.name}`
  const failed = [...spans].reverse().find((span) => span.status === 'failed' || span.status === 'interrupted')
  if (failed) return t('{0}{1} · {2}', { 0: TRACE_KIND_LABELS[failed.kind], 1: failed.status === 'interrupted' ? t('中断') : t('失败'), 2: failed.name })
  const totalDuration = spans.find((span) => span.kind === 'run_turn')?.durationMs
  return t('{0} 个阶段{1}', { 0: spans.length, 1: totalDuration !== undefined ? ` · ${formatDuration(totalDuration)}` : '' })
}

function traceDetails(span: TraceSpanItem): string {
  const payload = {
    ...(Object.keys(span.attributes).length ? { attributes: span.attributes } : {}),
    ...(span.usage && Object.keys(span.usage).length ? { usage: span.usage } : {}),
    ...(span.error && Object.keys(span.error).length ? { error: span.error } : {}),
    ...(span.artifactIds.length ? { artifactIds: span.artifactIds } : {}),
  }
  return Object.keys(payload).length ? redactDiagnosticText(payload) : ''
}

function TraceDiagnostics({ detail }: { detail: RunDetailView }) {
  useLocale()
  const spans = latestTraceSpans(detail)
  if (!spans.length) return null
  return <Section title={t('阶段诊断')} icon="activity">
    <details className="trace-diagnostics">
      <summary><span className="trace-status-dot" data-status={spans.some((span) => span.status === 'running' || span.status === 'waiting') ? 'running' : spans.some((span) => span.status === 'failed' || span.status === 'interrupted') ? 'failed' : 'succeeded'} /><span><strong>{traceDiagnosticHeadline(spans)}</strong><small>{t('展开查看耗时、token 和错误回执；不包含隐藏思维链')}</small></span><Icon name="chevronDown" size={14} /></summary>
      <div className="trace-span-list">{spans.map((span) => {
        const technical = traceDetails(span)
        return <div key={span.id} className={`trace-span trace-${span.status}`}>
          <span className="trace-status-dot" data-status={span.status} />
          <span><strong>{TRACE_KIND_LABELS[span.kind]}</strong><small>{span.name}</small>{technical && <details className="diagnostic-details"><summary>{t('技术详情')}</summary><pre>{technical}</pre></details>}</span>
          <span><em>{TRACE_STATUS_LABELS[span.status]}</em><time>{formatDuration(span.durationMs) || formatTime(span.startedAt)}</time></span>
        </div>
      })}</div>
    </details>
  </Section>
}

function DiagnosticsPanel({ detail }: { detail: RunDetailView }) {
  useLocale()
  if (!detail.toolCalls.length && !detail.approvalHistory.length && !detail.traceSpans.length) {
    return <EmptyState compact icon="activity" title={t('还没有诊断记录')} description={t('工具参数、确认历史、错误回执和完整 Trace 会显示在这里。')} />
  }
  return <>
    {detail.toolCalls.length > 0 && <Section title={t('工具诊断')} icon="terminal"><div className="inspector-activity-list">{detail.toolCalls.map((tool) => {
      const technical = redactDiagnosticText({ toolCallId: tool.id, toolName: tool.toolName, arguments: tool.argumentsSummary ?? tool.arguments, sources: tool.sources, ...(tool.error ? { error: tool.error } : {}) })
      return <div key={tool.id} className={`tool-status-${tool.status}`}><span className="tool-status-dot" /><span><strong>{tool.title ?? TOOL_LABELS[tool.toolName] ?? tool.toolName.replaceAll('_', ' ')}</strong><small>{tool.error ?? tool.summary ?? (tool.status === 'succeeded' ? t('已完成') : tool.status === 'failed' ? t('没有完成') : t('正在处理'))}</small>{technical && <details className="diagnostic-details"><summary>{t('技术详情')}</summary><pre>{technical}</pre></details>}</span><time>{formatTime(tool.updatedAt ?? tool.createdAt)}</time></div>
    })}</div></Section>}
    {detail.approvalHistory.length > 0 && <Section title={t('确认记录')} icon="shield"><div className="inspector-activity-list">{detail.approvalHistory.map((approval) => <div key={approval.id} className={`approval-${approval.status}`}><Icon name={approval.status === 'approved' || approval.status === 'edited' ? 'check' : approval.status === 'rejected' ? 'warning' : 'clock'} size={14} /><span><strong>{approval.title}</strong><small>{approval.status === 'approved' ? t('已允许') : approval.status === 'edited' ? t('修改后允许') : approval.status === 'rejected' ? t('已拒绝') : t('需要确认')}</small></span><time>{formatTime(approval.resolvedAt ?? approval.createdAt)}</time></div>)}</div></Section>}
    <TraceDiagnostics detail={detail} />
  </>
}

function ChangesPanel({ detail, onRevealArtifact, onOpenArtifact, onOpenPath, onUndoChange, onPreview, onPreviewDocument }: Pick<WorkInspectorProps, 'detail' | 'onRevealArtifact' | 'onOpenArtifact' | 'onOpenPath' | 'onUndoChange' | 'onPreviewDocument'> & { onPreview: (value: { name: string; text: string; truncated: boolean; diffId?: string; path?: string }) => void }) {
  useLocale()
  const outputs = visibleOutputs(detail)
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null)
  const [gitLoading, setGitLoading] = useState(false)

  const loadGitStatus = async () => {
    if (!detail.workspaceId) return
    setGitLoading(true)
    try {
      const res = await bridge.getGitStatus(detail.workspaceId)
      setGitStatus(res)
    } catch {
      setGitStatus(null)
    } finally {
      setGitLoading(false)
    }
  }

  useEffect(() => {
    void loadGitStatus()
  }, [detail.workspaceId])

  return <>
    {gitStatus?.isGitRepo && (
      <Section title={t('Git 仓库状态')} icon="gitBranch">
        <div className="git-status-card">
          <div className="git-status-header">
            <div className="git-status-branch">
              <Icon name="gitBranch" size={13} />
              <strong>{gitStatus.branch || 'HEAD'}</strong>
              {(gitStatus.ahead ?? 0) > 0 && <span className="git-ahead-badge">↑{gitStatus.ahead}</span>}
              {(gitStatus.behind ?? 0) > 0 && <span className="git-behind-badge">↓{gitStatus.behind}</span>}
            </div>
            <button type="button" className="text-button git-refresh-btn" onClick={loadGitStatus} disabled={gitLoading}>
              <Icon name="refresh" size={12} />
              {t('刷新')}
            </button>
          </div>
          {gitStatus.clean ? (
            <p className="git-clean-hint">{t('工作区干净，无未提交修改')}</p>
          ) : (
            <div className="git-file-list">
              {gitStatus.files.map((file, idx) => (
                <div key={idx} className="git-file-row">
                  <span className={`git-status-tag ${file.staged ? 'is-staged' : 'is-unstaged'}`}>
                    {file.staged ? t('暂存') : t('工作区')}
                  </span>
                  <span className={`git-status-op git-op-${file.status}`}>
                    {file.status === 'modified' ? 'M' : file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : '?'}
                  </span>
                  <span className="git-file-path" title={file.path}>{file.path}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>
    )}
    {detail.diffs.length > 0 && <Section title={t('文件变更')} icon="edit"><div className="file-change-list">{detail.diffs.map((diff) => <div key={diff.id}><Icon name="file" /><span><strong title={t('完整路径: {0}', { 0: diff.path })}>{diff.path.split('/').at(-1)}</strong><small>{shortPath(diff.path)}</small></span><em className="additions">+{diff.additions ?? 0}</em><em className="deletions">−{diff.deletions ?? 0}</em><button type="button" className="text-button" title={t('用默认程序打开文件')} onClick={() => onOpenPath?.(diff.path)}>{t('打开')}</button><button type="button" className="text-button" onClick={async () => {
      const result = await bridge.getArtifactText(diff.id)
      const value = result && typeof result === 'object' ? result as JsonRecord : {}
      onPreview({ name: diff.path.split('/').at(-1) ?? 'Diff', text: String(value.text ?? ''), truncated: value.truncated === true, diffId: diff.id, path: diff.path })
    }}>{t('对比')}</button><button type="button" className="text-button" onClick={() => onUndoChange(diff.id)}>{t('撤销')}</button></div>)}</div></Section>}
    {outputs.length > 0 && <Section title={t('输出')} icon="file"><div className="artifact-list">{outputs.map((artifact) => {
      const isHtml = artifact.name.toLowerCase().endsWith('.html') || artifact.name.toLowerCase().endsWith('.htm')
      const handlePreview = () => {
        if (onPreviewDocument) {
          onPreviewDocument({ title: artifact.name, artifactId: artifact.id, path: artifact.path })
        } else if (onOpenArtifact) {
          onOpenArtifact(artifact.id)
        } else {
          onRevealArtifact(artifact.id)
        }
      }
      return (
        <div key={artifact.id} className="artifact-row">
          <button type="button" className="artifact-main-action" title={t('文件全称: {0}\n点击内置预览', { 0: artifact.name })} onClick={handlePreview}>
            <span className="artifact-icon"><Icon name={isHtml ? 'globe' : 'file'} /></span>
            <span><strong title={t('文件全称: {0}', { 0: artifact.name })}>{artifact.name}</strong><small>{artifactKindLabel(artifact.kind)} {formatBytes(artifact.size)}</small></span>
            <span className="artifact-open-tag"><Icon name={isHtml ? 'globe' : 'file'} size={13} />{isHtml ? t('网页预览') : t('预览')}</span>
          </button>
          {onOpenArtifact && <button type="button" className="artifact-reveal-button" title={t('用默认外部程序打开')} aria-label={t('外部打开')} onClick={() => onOpenArtifact(artifact.id)}><Icon name="external" size={13} /></button>}
          <button type="button" className="artifact-reveal-button" title={t('在访达 / 文件夹中定位')} aria-label={t('在文件夹中定位')} onClick={() => onRevealArtifact(artifact.id)}><Icon name="folder" size={14} /></button>
        </div>
      )
    })}</div></Section>}
    {!detail.diffs.length && !outputs.length && !gitStatus?.isGitRepo && <EmptyState compact icon="edit" title={t('没有文件或输出')} description={t('有实际变更或生成文件后会显示在这里。')} />}
  </>
}

function ArtifactShelf({ detail, onRevealArtifact, onOpenArtifact, onOpenChanges, onPreviewDocument }: Pick<WorkInspectorProps, 'detail' | 'onRevealArtifact' | 'onOpenArtifact' | 'onPreviewDocument'> & { onOpenChanges: () => void }) {
  useLocale()
  const outputs = visibleOutputs(detail)
  const total = outputs.length + detail.diffs.length
  return (
    <section className="inspector-artifact-shelf" aria-label={t('产物')}>
      <header><span><Icon name="file" size={15} /><strong>{t('产物')}</strong></span>{total > 0 && <em>{total}</em>}</header>
      {total === 0 ? (
        <p>{t('Agent 生成的文件、报告、截图和变更会集中在这里。')}</p>
      ) : (
        <div className="artifact-shelf-list">
          {outputs.slice(0, 3).map((artifact) => {
            const displayName = artifact.fileName || artifact.name
            const displayLabel = artifact.label && artifact.label !== displayName ? artifact.label : undefined
            const displayPath = artifact.sourcePath || artifact.path
            const isHtml = isHtmlArtifact({ ...artifact, name: displayName, path: displayPath })
            const handlePreview = () => {
              if (onPreviewDocument) {
                onPreviewDocument({ title: displayName, artifactId: artifact.id, path: displayPath, sourcePath: artifact.sourcePath })
              } else if (onOpenArtifact) {
                onOpenArtifact(artifact.id)
              } else {
                onRevealArtifact(artifact.id)
              }
            }
            return (
              <div key={artifact.id} className="artifact-shelf-row">
                <button
                  type="button"
                  className="artifact-shelf-main"
                  title={t('目标文件: {0}{1}{2}\n点击内置预览', { 0: displayName, 1: displayLabel ? `\n说明: ${displayLabel}` : '', 2: displayPath ? `\n存放路径: ${displayPath}` : '' })}
                  onClick={handlePreview}
                >
                  <span className="artifact-shelf-icon"><Icon name={isHtml ? 'globe' : 'file'} size={14} /></span>
                  <span>
                    <strong title={t('目标文件: {0}{1}', { 0: displayName, 1: displayLabel ? ` (${displayLabel})` : '' })}>{displayName}</strong>
                    <small>{displayLabel ? `${displayLabel} · ` : ''}{artifactKindLabel(artifact.kind)} {formatBytes(artifact.size)}</small>
                  </span>
                  <span className="artifact-open-badge"><Icon name={isHtml ? 'globe' : 'file'} size={11} />{isHtml ? t('网页预览') : t('预览')}</span>
                </button>
                <button
                  type="button"
                  className="artifact-shelf-reveal-btn"
                  title={t('在访达 / 文件夹中定位')}
                  aria-label={t('在文件夹中定位')}
                  onClick={() => onRevealArtifact(artifact.id)}
                >
                  <Icon name="folder" size={13} />
                </button>
              </div>
            )
          })}
          {detail.diffs.length > 0 && <button type="button" onClick={onOpenChanges}><span className="artifact-shelf-icon change"><Icon name="edit" size={14} /></span><span><strong>{t('文件变更')}</strong><small>{detail.diffs.length}{t('项可查看或撤销')}</small></span><Icon name="arrowRight" size={13} /></button>}
          {outputs.length > 3 && <button type="button" className="artifact-shelf-more" onClick={onOpenChanges}>{t('查看另外')}{outputs.length - 3}{t('项产物')}</button>}
        </div>
      )}
    </section>
  )
}

export function WorkInspector(props: WorkInspectorProps) {
  useLocale()
  const { detail, requestedTab } = props
  const [tab, setTab] = useState<WorkInspectorTab>(requestedTab)
  const [diffPreview, setDiffPreview] = useState<{ name: string; text: string; truncated: boolean; diffId?: string; path?: string }>()
  const [width, setWidth] = usePersistentPanelWidth('deskforge.inspector-width')
  const outputs = useMemo(() => visibleOutputs(detail), [getLocale(), detail])
  const parsedDiff = useMemo(() => {
    if (!diffPreview?.text) return null
    return parseUnifiedDiffText(diffPreview.text, diffPreview.path || diffPreview.name)
  }, [diffPreview])
  const available = useMemo(() => ({
    details: true,
    changes: Boolean(detail.workspaceId) || detail.diffs.length > 0 || outputs.length > 0,
    activity: detail.toolCalls.length > 0 || detail.approvalHistory.length > 0 || detail.traceSpans.length > 0,
  }), [getLocale(), detail, outputs.length])

  useEffect(() => { setTab(available[requestedTab] ? requestedTab : 'details') }, [available, requestedTab])

  const items = [
    { id: 'details' as const, label: t('详细'), panel: <DetailsPanel {...props} /> },
    ...(available.changes ? [{ id: 'changes' as const, label: t('变更 {0}', { 0: detail.diffs.length || '' }).trim(), panel: <ChangesPanel {...props} onPreview={setDiffPreview} /> }] : []),
    ...(available.activity ? [{ id: 'activity' as const, label: t('诊断'), panel: <DiagnosticsPanel detail={detail} /> }] : []),
  ]

  return (
    <aside className="inspector" style={{ width }}>
      <PanelResizer width={width} onWidthChange={setWidth} />
      <ArtifactShelf detail={detail} onRevealArtifact={props.onRevealArtifact} onOpenArtifact={props.onOpenArtifact} onOpenChanges={() => setTab('changes')} onPreviewDocument={props.onPreviewDocument} />
      <Tabs className="inspector-tab-shell" ariaLabel={t('工作详情')} value={tab} onValueChange={setTab} tabListClassName="inspector-tabs" tabPanelClassName="inspector-content" items={items} />
      <Modal open={Boolean(diffPreview)} onClose={() => setDiffPreview(undefined)} title={diffPreview?.name ?? t('文件变更')} description={diffPreview?.truncated ? t('这里只显示部分内容，可在 Finder 中打开完整文件。') : t('DeskForge 保存的本地文件变更。')} wide>
        {parsedDiff ? (
          <div className="diff-modal-container">
            <ApprovalDiff diff={parsedDiff} />
            {diffPreview?.diffId && (
              <div className="diff-modal-actions">
                <button
                  type="button"
                  className="button secondary danger-text"
                  onClick={() => {
                    const id = diffPreview.diffId!
                    setDiffPreview(undefined)
                    props.onUndoChange(id)
                  }}
                >
                  <Icon name="trash" size={13} />
                  {t('一键撤销并回滚此变更')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <pre className="diff-preview">{diffPreview?.text}</pre>
        )}
      </Modal>
    </aside>
  )
}
