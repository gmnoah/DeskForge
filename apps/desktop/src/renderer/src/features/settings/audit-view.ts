import type { AuditChainView, AuditFilters } from '../../types'

export const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  tool: '工具', approval: '审批', security: '安全', lifecycle: '生命周期', run: '工作', model: '模型', memory: '记忆', chrome: '浏览器', audit: '审计', settings: '设置', mcp: '连接',
}

export const AUDIT_OUTCOME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'allow', label: '已允许' },
  { value: 'require_approval', label: '待确认' },
  { value: 'approved', label: '已批准' },
  { value: 'auto_approved', label: '会话规则自动批准' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'deny', label: '已阻止' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
]

const OUTCOME_LABELS: Record<string, string> = {
  started: '已开始', allowed: '已允许', allow: '已允许', blocked: '已阻止', deny: '已阻止', require_approval: '待确认', approved: '已批准', auto_approved: '自动批准',
  rejected: '已拒绝', succeeded: '成功', failed: '失败',
}

export function auditOutcomeLabel(value?: string): string {
  return value ? OUTCOME_LABELS[value] ?? value : '—'
}

export function auditCategoryLabel(value: string): string {
  return AUDIT_CATEGORY_LABELS[value] ?? value
}

export interface AuditFilterForm {
  runId: string
  category: string
  outcome: string
  from: string
  to: string
  text: string
}

export const EMPTY_AUDIT_FILTERS: AuditFilterForm = { runId: '', category: '', outcome: '', from: '', to: '', text: '' }

/** Converts the filter form (datetime-local strings) to the IPC filter shape. */
export function toAuditFilters(form: AuditFilterForm, limit = 500): AuditFilters {
  const iso = (value: string): string | undefined => {
    if (!value) return undefined
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  const from = iso(form.from)
  const to = iso(form.to)
  const text = form.text.trim()
  return {
    limit,
    ...(form.runId ? { runId: form.runId } : {}),
    ...(form.category ? { category: form.category } : {}),
    ...(form.outcome ? { outcome: form.outcome } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(text ? { text: text.slice(0, 200) } : {}),
  }
}

export function chainStatus(chain: AuditChainView): { tone: 'ok' | 'warning' | 'danger'; title: string; detail: string } {
  if (!chain.valid) return { tone: 'danger', title: `哈希链校验失败：${chain.brokenIds.length} 条记录内容与签名不符`, detail: `可能被修改的记录 ID：${chain.brokenIds.slice(0, 10).join('、')}${chain.brokenIds.length > 10 ? ' 等' : ''}` }
  const legacy = chain.legacyEntries ? `，另有 ${chain.legacyEntries} 条旧格式记录未签名` : ''
  if (chain.linkBreakIds.length) return { tone: 'warning', title: `哈希链内容完整，但有 ${chain.linkBreakIds.length} 处不连续`, detail: `通常由保留期清理导致；若未清理过记录，请导出并检查 ID ${chain.linkBreakIds.slice(0, 10).join('、')}${legacy}` }
  return { tone: 'ok', title: '哈希链校验通过', detail: `已校验最近 ${chain.checkedEntries} 条记录，其中 ${chain.hashedEntries} 条已签名${legacy}` }
}
