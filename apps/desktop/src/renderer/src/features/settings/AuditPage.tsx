import { useCallback, useEffect, useState } from 'react'
import { bridge, errorMessage } from '../../bridge'
import { Icon, type IconName } from '../../icons'
import type { AuditExportFormat, AuditQueryView, JsonRecord, WorkbenchSnapshot } from '../../types'
import { EmptyState, PageHeader, Spinner } from '../../ui'
import { SessionRulesList } from '../work/SessionRules'
import { AUDIT_OUTCOME_OPTIONS, auditCategoryLabel, auditOutcomeLabel, chainStatus, EMPTY_AUDIT_FILTERS, toAuditFilters, type AuditFilterForm } from './audit-view'

type Perform = <T>(
  action: () => Promise<T>,
  successTitle?: string,
  options?: { refresh?: boolean; refreshRun?: boolean },
) => Promise<T | undefined>

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

const OUTCOME_TONE: Record<string, string> = { allow: 'allowed', allowed: 'allowed', approved: 'approved', auto_approved: 'auto', succeeded: 'succeeded', deny: 'blocked', blocked: 'blocked', rejected: 'rejected', failed: 'failed', require_approval: 'pending' }
const CHAIN_LABELS: Record<string, string> = { ok: '已签名', broken: '内容不符', unlinked: '不连续', legacy: '旧格式' }
const EXPORT_FORMATS: Array<{ format: AuditExportFormat; label: string }> = [{ format: 'json', label: 'JSON' }, { format: 'csv', label: 'CSV' }, { format: 'markdown', label: 'Markdown' }]

export function AuditPage({ snapshot, perform }: { snapshot: WorkbenchSnapshot; perform: Perform }) {
  const [form, setForm] = useState<AuditFilterForm>(EMPTY_AUDIT_FILTERS)
  const [result, setResult] = useState<AuditQueryView>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [reloadKey, setReloadKey] = useState(0)
  const update = (patch: Partial<AuditFilterForm>) => setForm((current) => ({ ...current, ...patch }))
  const load = useCallback(async () => {
    setLoading(true)
    try { setResult(await bridge.queryAudit(toAuditFilters(form))); setLoadError(undefined) } catch (cause) { setLoadError(errorMessage(cause)) } finally { setLoading(false) }
  }, [form])
  useEffect(() => { const timer = setTimeout(() => void load(), 200); return () => clearTimeout(timer) }, [load, reloadKey])
  const successful = snapshot.runs.filter((run) => run.status === 'completed').length
  const waiting = snapshot.runs.filter((run) => run.status === 'waiting_approval').length
  const failures = snapshot.runs.filter((run) => run.status === 'failed').length
  const status = result ? chainStatus(result.chain) : undefined
  const runTitle = (id?: string) => (id ? result?.runs.find((run) => run.id === id)?.title ?? snapshot.runs.find((run) => run.id === id)?.title ?? id.slice(0, 8) : '—')
  const exportAs = (format: AuditExportFormat) => void perform(async () => {
    const exported = await bridge.exportAuditLog(format, toAuditFilters(form, 5_000))
    return exported === null ? 'cancelled' : exported
  }, `审计日志已导出为 ${format === 'markdown' ? 'Markdown' : format.toUpperCase()}`, { refresh: false }).then(() => setReloadKey((key) => key + 1))
  return (
    <main className="management-page">
      <PageHeader title="隐私与记录" description="查看本机保存的操作、确认、错误和检查记录；不会保存隐藏思维链或原始密钥。" action={<button className="button secondary" type="button" onClick={() => void perform(async () => { const exported = await bridge.exportAudit(); if (exported === null) return 'cancelled'; return exported }, undefined, { refresh: false })}><Icon name="download" />导出诊断包</button>} />
      <div className="audit-metrics"><Metric icon="tasks" label="本地工作" value={snapshot.runs.length} tone="blue" /><Metric icon="check" label="已有结果" value={successful} tone="green" /><Metric icon="shield" label="需要确认" value={waiting} tone="amber" /><Metric icon="warning" label="未完成" value={failures} tone="red" /></div>
      {status && <div className={`audit-chain-banner tone-${status.tone}`} role="status"><Icon name={status.tone === 'ok' ? 'lock' : 'warning'} /><div><strong>{status.title}</strong><p>{status.detail}</p></div><button type="button" className="button ghost small" onClick={() => setReloadKey((key) => key + 1)}><Icon name="refresh" size={14} />重新校验</button></div>}
      <section className="audit-table-card session-rules-card">
        <div className="table-heading"><div><h2>生效中的会话规则</h2><span>「本会话总是允许此类操作」创建的规则；撤销后立即恢复逐次确认</span></div></div>
        <div className="session-rules-card-body"><SessionRulesList showRun refreshKey={reloadKey} /></div>
      </section>
      <section className="audit-table-card">
        <div className="table-heading"><div><h2>审计事件</h2><span>{result ? `显示 ${result.items.length} / ${result.total} 条${result.truncated ? '（已达上限，请缩小筛选范围）' : ''}` : '读取中'}</span></div><span className="audit-export-actions">{EXPORT_FORMATS.map(({ format, label }) => <button key={format} type="button" className="button secondary small" onClick={() => exportAs(format)}><Icon name="download" size={14} />{label}</button>)}</span></div>
        <div className="audit-filters" role="search">
          <label><span>工作</span><select value={form.runId} onChange={(event) => update({ runId: event.target.value })}><option value="">全部工作</option>{result?.runs.map((run) => <option key={run.id} value={run.id}>{run.title}</option>)}</select></label>
          <label><span>类别</span><select value={form.category} onChange={(event) => update({ category: event.target.value })}><option value="">全部类别</option>{result?.categories.map((category) => <option key={category} value={category}>{auditCategoryLabel(category)}</option>)}</select></label>
          <label><span>结果</span><select value={form.outcome} onChange={(event) => update({ outcome: event.target.value })}><option value="">全部结果</option>{AUDIT_OUTCOME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label><span>开始</span><input type="datetime-local" value={form.from} onChange={(event) => update({ from: event.target.value })} /></label>
          <label><span>结束</span><input type="datetime-local" value={form.to} onChange={(event) => update({ to: event.target.value })} /></label>
          <label className="audit-filter-text"><span>关键字</span><input type="search" placeholder="摘要或操作" value={form.text} onChange={(event) => update({ text: event.target.value })} /></label>
          <button type="button" className="button ghost small" onClick={() => setForm(EMPTY_AUDIT_FILTERS)}>重置</button>
        </div>
        {loading && !result ? <div className="table-loading"><Spinner />读取审计日志…</div> : loadError ? <div className="inline-notice error"><Icon name="warning" /><span>{loadError}</span></div> : result?.items.length ? (
          <div className="audit-table audit-table-v2" role="table">
            <div className="audit-table-row table-header" role="row"><span>时间</span><span>工作</span><span>类别</span><span>操作</span><span>结果</span><span>摘要</span><span>链</span></div>
            {result.items.map((entry) => {
              const tone = OUTCOME_TONE[entry.outcome ?? ''] ?? 'started'
              return <details className="audit-row" key={entry.id}>
                <summary className="audit-table-row" role="row">
                  <span>{formatDate(entry.createdAt)}</span>
                  <span title={entry.runId}>{runTitle(entry.runId)}</span>
                  <span>{auditCategoryLabel(entry.category)}</span>
                  <span className="mono">{entry.action}</span>
                  <span><em className={`outcome outcome-${tone}`}>{auditOutcomeLabel(entry.outcome)}</em></span>
                  <span title={entry.summary}>{entry.summary || '—'}{entry.ruleLabel ? <small className="audit-rule">规则：{entry.ruleLabel}</small> : null}</span>
                  <span><em className={`chain-badge chain-${entry.chain}`}>{CHAIN_LABELS[entry.chain]}</em></span>
                </summary>
                <div className="audit-row-detail"><pre>{JSON.stringify({ id: entry.id, runId: entry.runId, target: entry.target, riskLevel: entry.riskLevel, sessionRule: entry.ruleId ? { id: entry.ruleId, label: entry.ruleLabel } : undefined, payload: entry.payload as JsonRecord, prevHash: entry.prevHash, entryHash: entry.entryHash }, null, 2)}</pre></div>
              </details>
            })}
          </div>
        ) : <EmptyState compact icon="activity" title="没有符合条件的记录" description="调整筛选条件，或在执行操作后再查看。" />}
      </section>
      <div className="audit-footnote"><Icon name="info" size={14} />每条记录都带有前一条记录的哈希；导出的 JSON/CSV 包含 prevHash 与 entryHash，便于离线复核。</div>
    </main>
  )
}

function Metric({ icon, label, value, tone }: { icon: IconName; label: string; value: number; tone: string }) {
  return <div className={`metric-card tone-${tone}`}><span><Icon name={icon} /></span><div><strong>{value}</strong><small>{label}</small></div></div>
}
