import type { ApprovalHistoryEntry, JsonValue, RunDetail, ToolReceipt } from '@deskforge/contracts'
import { redactForExport } from './secret-redaction'

export interface SessionMarkdownOptions {
  exportedAt: Date
  timeZone?: string
  workspaceName?: string
  /** Runtime-known secret values (model keys, MCP secrets, embeddings key). */
  knownSecrets?: readonly string[]
  appVersion?: string
}

const ROLE_LABEL = { user: '用户', assistant: 'DeskForge', system: '系统' } as const
const STATUS_LABEL: Record<string, string> = {
  understanding: '理解中', planning: '规划中', running: '执行中', verifying: '验证中', waiting_approval: '等待审批',
  waiting_user: '等待用户', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消',
}
const TOOL_STATUS: Record<ToolReceipt['status'], string> = {
  requested: '已请求', waiting_approval: '等待审批', running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消',
}
const RISK_LABEL: Record<ToolReceipt['riskLevel'], string> = {
  readonly: '只读', reversible_write: '可回退写入', external_side_effect: '外部影响', high_risk_irreversible: '高风险',
}
const APPROVAL_STATUS: Record<ApprovalHistoryEntry['status'], string> = {
  pending: '待处理', approved: '已批准', edited: '修改后批准', rejected: '已拒绝', expired: '已过期',
}
const SCOPE_LABEL = { once: '仅本次', run_tool: '本会话同类操作', session: '本会话规则' } as const

function formatTime(iso: string | undefined, timeZone: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const parts = new Intl.DateTimeFormat('zh-CN', {
    ...(timeZone ? { timeZone } : {}), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

const cell = (value: string) => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '—'
const clip = (value: string, max: number) => ([...value].length > max ? `${[...value].slice(0, max).join('')}…` : value)

function summarizeArguments(value: JsonValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return value.map((item) => summarizeArguments(item)).join(', ')
  const preferred = ['path', 'query', 'pattern', 'command', 'url', 'name', 'skillId', 'target']
  const entries = Object.entries(value)
  entries.sort(([left], [right]) => {
    const a = preferred.indexOf(left)
    const b = preferred.indexOf(right)
    return (a < 0 ? 99 : a) - (b < 0 ? 99 : b)
  })
  return entries
    .slice(0, 4)
    .map(([key, item]) => `${key}=${typeof item === 'string' ? item : JSON.stringify(item)}`)
    .join(' · ')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Render a run as a self-contained, redacted Markdown document. */
export function renderSessionMarkdown(detail: RunDetail, options: SessionMarkdownOptions): string {
  const secrets = options.knownSecrets ?? []
  const tz = options.timeZone
  const safe = (value: string) => redactForExport(value, secrets)
  const { run } = detail
  const lines: string[] = []
  lines.push(`# ${safe(run.title).replace(/\r?\n/g, ' ')}`, '')
  lines.push(`> 由 DeskForge${options.appVersion ? ` ${options.appVersion}` : ''} 导出于 ${formatTime(options.exportedAt.toISOString(), tz)}。密钥、令牌等敏感内容已替换为 [REDACTED]；工具调用仅保留摘要，不含完整输出。`, '')
  lines.push('| 项目 | 内容 |', '| --- | --- |')
  lines.push(`| 状态 | ${STATUS_LABEL[run.status] ?? run.status}${run.completionStatus === 'verified' ? '（已验证）' : run.completionStatus === 'partial' ? '（部分完成）' : ''} |`)
  if (options.workspaceName) lines.push(`| 工作区 | ${cell(safe(options.workspaceName))} |`)
  lines.push(`| 模型 | ${cell(`${run.model.provider} / ${run.model.modelId}`)} |`)
  lines.push(`| 创建时间 | ${formatTime(run.createdAt, tz)} |`)
  lines.push(`| 最后更新 | ${formatTime(run.updatedAt, tz)} |`)
  if (run.tokenUsage) lines.push(`| Token 用量 | 输入 ${run.tokenUsage.inputTokens} · 输出 ${run.tokenUsage.outputTokens} · 合计 ${run.tokenUsage.totalTokens} |`)
  lines.push('')

  if (run.objective && run.objective.trim() !== run.title.trim()) {
    lines.push('## 目标', '', safe(run.objective), '')
  }

  if (detail.steps.length) {
    lines.push('## 计划步骤', '')
    for (const step of [...detail.steps].sort((a, b) => a.ordinal - b.ordinal)) {
      const mark = step.status === 'completed' ? 'x' : ' '
      const extra = step.status !== 'completed' && step.status !== 'pending' ? `（${step.status}）` : ''
      lines.push(`- [${mark}] ${safe(step.title)}${extra}`)
    }
    lines.push('')
  }

  const messages = detail.messages.filter((message) => message.role !== 'system' && message.content.trim())
  lines.push('## 对话', '')
  if (!messages.length) lines.push('_（无消息）_', '')
  for (const message of messages) {
    lines.push(`### ${ROLE_LABEL[message.role]} · ${formatTime(message.createdAt, tz)}`, '', safe(message.content).trim(), '')
  }

  lines.push(`## 工具调用（${detail.toolCalls.length}）`, '')
  if (!detail.toolCalls.length) {
    lines.push('_（本会话没有工具调用）_', '')
  } else {
    lines.push('| 时间 | 工具 | 风险 | 状态 | 参数摘要 | 结果 |', '| --- | --- | --- | --- | --- | --- |')
    for (const call of detail.toolCalls) {
      const result = call.error ? `错误：${call.error.message}` : call.resultSummary ?? ''
      lines.push(`| ${formatTime(call.createdAt, tz)} | \`${cell(call.toolName)}\` | ${RISK_LABEL[call.riskLevel]} | ${TOOL_STATUS[call.status]} | ${cell(clip(safe(summarizeArguments(call.argumentsSummary)), 160))} | ${cell(clip(safe(result), 160))} |`)
    }
    lines.push('')
  }

  const approvals = [...detail.approvalHistory]
  for (const pending of detail.pendingApprovals) if (!approvals.some((item) => item.id === pending.id)) approvals.push(pending)
  lines.push(`## 审批记录（${approvals.length}）`, '')
  if (!approvals.length) lines.push('_（本会话没有需要审批的操作）_', '')
  for (const approval of approvals) {
    const scope = 'scope' in approval && approval.scope ? `，范围：${SCOPE_LABEL[approval.scope as keyof typeof SCOPE_LABEL] ?? approval.scope}` : ''
    const resolved = 'resolvedAt' in approval && approval.resolvedAt ? `，处理于 ${formatTime(approval.resolvedAt as string, tz)}` : ''
    const sends = approval.sendsData.length ? `；外发数据：${safe(approval.sendsData.join('、'))}` : ''
    lines.push(`- **${safe(approval.title)}** — ${APPROVAL_STATUS[approval.status]}${scope}${resolved}`)
    lines.push(`  - 风险：${RISK_LABEL[approval.riskLevel]}；目标：\`${cell(clip(safe(approval.target), 200))}\`${sends}`)
  }
  if (approvals.length) lines.push('')

  const sources = detail.toolCalls.flatMap((call) => call.sources)
  if (sources.length) {
    lines.push('## 引用来源', '')
    const seen = new Set<string>()
    for (const source of sources) {
      if (seen.has(source.url)) continue
      seen.add(source.url)
      lines.push(`- [${safe(source.title).replace(/[[\]]/g, '')}](${safe(source.url)})`)
    }
    lines.push('')
  }

  if (detail.artifacts.length) {
    lines.push(`## 产物（${detail.artifacts.length}）`, '')
    for (const artifact of detail.artifacts) {
      lines.push(`- ${safe(artifact.displayName)} · ${artifact.mediaType} · ${formatBytes(artifact.byteLength)} · sha256 ${artifact.sha256.slice(0, 12)}`)
    }
    lines.push('')
  }

  if (detail.verification) {
    lines.push('## 验证', '', safe(detail.verification.summary), '')
    for (const check of detail.verification.checks) lines.push(`- ${check.status === 'passed' ? '✅' : check.status === 'failed' ? '❌' : '⏭️'} ${safe(check.name)}${check.detail ? `：${safe(check.detail)}` : ''}`)
    if (detail.verification.checks.length) lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** File-system friendly default name for an exported session. */
export function sessionExportFileName(title: string, createdAt: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'DeskForge 会话'
  return `${base} ${createdAt.slice(0, 10)}.md`
}
