import type { AuditChainStatus, AuditExportFormat, AuditFilterInput, AuditRecord } from '@deskforge/contracts'
import { redactSecrets } from '@deskforge/core'

const OUTCOME_ALIASES: Record<string, string> = { allow: 'allowed', deny: 'blocked', approve: 'approved', reject: 'rejected', success: 'succeeded', error: 'failed' }

export const AUDIT_OUTCOME_LABELS: Record<string, string> = {
  started: '已开始', allowed: '已允许', blocked: '已阻止', require_approval: '待确认', approved: '已批准', auto_approved: '会话规则自动批准',
  rejected: '已拒绝', succeeded: '成功', failed: '失败',
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

export function presentAuditRecord(row: any, chain: AuditRecord['chain'] = 'legacy'): AuditRecord {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload as Record<string, any> : {}
  const outcome = text(payload.outcome)
  const rule = payload.sessionRule && typeof payload.sessionRule === 'object' ? payload.sessionRule as Record<string, unknown> : undefined
  const record: AuditRecord = {
    id: String(row.id),
    category: String(row.category),
    action: String(row.action),
    summary: String(row.summary ?? ''),
    payload: row.payload ?? {},
    chain,
    createdAt: String(row.created_at ?? row.createdAt),
  }
  const runId = text(row.run_id ?? row.runId)
  if (runId) record.runId = runId
  if (text(payload.actor)) record.actor = payload.actor
  if (outcome) record.outcome = OUTCOME_ALIASES[outcome] ?? outcome
  if (text(payload.riskLevel)) record.riskLevel = payload.riskLevel
  if (text(payload.target)) record.target = payload.target
  if (rule && text(rule.id)) record.ruleId = String(rule.id)
  if (rule && text(rule.label)) record.ruleLabel = String(rule.label)
  if (text(row.prev_hash)) record.prevHash = row.prev_hash
  if (text(row.entry_hash)) record.entryHash = row.entry_hash
  return record
}

export interface AuditExportMeta {
  exportedAt: string
  filters: AuditFilterInput
  chain: AuditChainStatus
  total: number
}

const CSV_COLUMNS: Array<[string, (record: AuditRecord) => unknown]> = [
  ['id', (record) => record.id],
  ['createdAt', (record) => record.createdAt],
  ['runId', (record) => record.runId],
  ['category', (record) => record.category],
  ['action', (record) => record.action],
  ['outcome', (record) => record.outcome],
  ['actor', (record) => record.actor],
  ['riskLevel', (record) => record.riskLevel],
  ['target', (record) => record.target],
  ['sessionRuleId', (record) => record.ruleId],
  ['sessionRuleLabel', (record) => record.ruleLabel],
  ['summary', (record) => record.summary],
  ['chain', (record) => record.chain],
  ['prevHash', (record) => record.prevHash],
  ['entryHash', (record) => record.entryHash],
  ['payload', (record) => JSON.stringify(record.payload)],
]

/** RFC 4180 quoting plus a guard against spreadsheet formula injection. */
export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return ''
  let cell = String(value)
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
}

export function auditToCsv(records: readonly AuditRecord[]): string {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')]
  for (const record of records) lines.push(CSV_COLUMNS.map(([, pick]) => csvCell(pick(record))).join(','))
  // BOM so spreadsheet apps read the Chinese summaries as UTF-8.
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

export function auditToJson(records: readonly AuditRecord[], meta: AuditExportMeta): string {
  return `${JSON.stringify({ format: 'deskforge-audit-v1', exportedAt: meta.exportedAt, filters: meta.filters, total: meta.total, exported: records.length, chain: meta.chain, entries: records }, null, 2)}\n`
}

const mdCell = (value: unknown): string => (value === undefined || value === null || value === '' ? '—' : String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '))

export function auditToMarkdown(records: readonly AuditRecord[], meta: AuditExportMeta): string {
  const filters = Object.entries(meta.filters).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${key}=${String(value)}`).join('，') || '无'
  const chain = meta.chain.valid
    ? `✅ 哈希链校验通过（${meta.chain.hashedEntries} 条已签名${meta.chain.linkBreakIds.length ? `，${meta.chain.linkBreakIds.length} 处不连续` : ''}）`
    : `❌ 哈希链校验失败：${meta.chain.brokenIds.length} 条记录被修改（ID ${meta.chain.brokenIds.slice(0, 20).join(', ')}）`
  const lines = [
    '# DeskForge 审计日志导出',
    '',
    `- 导出时间：${meta.exportedAt}`,
    `- 筛选条件：${filters}`,
    `- 记录数：${records.length} / ${meta.total}`,
    `- ${chain}`,
    '',
    '| ID | 时间 | 工作 | 类别 | 操作 | 结果 | 会话规则 | 摘要 | 链 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...records.map((record) => `| ${[record.id, record.createdAt, record.runId, record.category, record.action, record.outcome ? AUDIT_OUTCOME_LABELS[record.outcome] ?? record.outcome : undefined, record.ruleLabel, record.summary, record.chain].map(mdCell).join(' | ')} |`),
    '',
  ]
  return lines.join('\n')
}

export function renderAuditExport(format: AuditExportFormat, records: readonly AuditRecord[], meta: AuditExportMeta): string {
  const body = format === 'csv' ? auditToCsv(records) : format === 'markdown' ? auditToMarkdown(records, meta) : auditToJson(records, meta)
  return redactSecrets(body)
}

export function auditExportFileName(format: AuditExportFormat, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `deskforge-audit-${stamp}.${format === 'markdown' ? 'md' : format}`
}
