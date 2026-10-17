import { t } from '../../i18n'
import type { AuditChainView, AuditFilters } from '../../types'

export const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  get tool() { return t('工具') }, get approval() { return t('审批') }, get security() { return t('安全') }, get lifecycle() { return t('生命周期') }, get run() { return t('工作') }, get model() { return t('模型') }, get memory() { return t('记忆') }, get chrome() { return t('浏览器') }, get audit() { return t('审计') }, get settings() { return t('设置') }, get mcp() { return t('连接') },
}

export const AUDIT_OUTCOME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'allow', get label() { return t('已允许') } },
  { value: 'require_approval', get label() { return t('待确认') } },
  { value: 'approved', get label() { return t('已批准') } },
  { value: 'auto_approved', get label() { return t('会话规则自动批准') } },
  { value: 'rejected', get label() { return t('已拒绝') } },
  { value: 'deny', get label() { return t('已阻止') } },
  { value: 'succeeded', get label() { return t('成功') } },
  { value: 'failed', get label() { return t('失败') } },
]

const OUTCOME_LABELS: Record<string, string> = {
  get started() { return t('已开始') }, get allowed() { return t('已允许') }, get allow() { return t('已允许') }, get blocked() { return t('已阻止') }, get deny() { return t('已阻止') }, get require_approval() { return t('待确认') }, get approved() { return t('已批准') }, get auto_approved() { return t('自动批准') },
  get rejected() { return t('已拒绝') }, get succeeded() { return t('成功') }, get failed() { return t('失败') },
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
  if (!chain.valid) return { tone: 'danger', title: t('哈希链校验失败：{0} 条记录内容与签名不符', { 0: chain.brokenIds.length }), detail: t('可能被修改的记录 ID：{0}{1}', { 0: chain.brokenIds.slice(0, 10).join('、'), 1: chain.brokenIds.length > 10 ? t(' 等') : '' }) }
  const legacy = chain.legacyEntries ? t('，另有 {0} 条旧格式记录未签名', { 0: chain.legacyEntries }) : ''
  if (chain.linkBreakIds.length) return { tone: 'warning', title: t('哈希链内容完整，但有 {0} 处不连续', { 0: chain.linkBreakIds.length }), detail: t('通常由保留期清理导致；若未清理过记录，请导出并检查 ID {0}{1}', { 0: chain.linkBreakIds.slice(0, 10).join('、'), 1: legacy }) }
  return { tone: 'ok', title: t('哈希链校验通过'), detail: t('已校验最近 {0} 条记录，其中 {1} 条已签名{2}', { 0: chain.checkedEntries, 1: chain.hashedEntries, 2: legacy }) }
}
