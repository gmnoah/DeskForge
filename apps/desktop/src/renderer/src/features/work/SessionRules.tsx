import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { bridge, errorMessage } from '../../bridge'
import { Icon } from '../../icons'
import type { SessionRuleItem } from '../../types'

function formatTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

/**
 * Active 「本会话总是允许此类操作」 rules. Rules expire when DeskForge restarts;
 * every auto-approval is still written to the audit log.
 */
export function SessionRulesList({ runId, refreshKey, showRun = false, hideWhenEmpty = false, wrap = (children) => children }: { runId?: string; refreshKey?: unknown; showRun?: boolean; hideWhenEmpty?: boolean; wrap?: (children: ReactNode) => ReactNode }) {
  const [rules, setRules] = useState<SessionRuleItem[]>([])
  const [error, setError] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const load = useCallback(async () => {
    try { setRules(await bridge.listSessionRules(runId)); setError(undefined) } catch (cause) { setError(errorMessage(cause)) } finally { setLoaded(true) }
  }, [runId])
  useEffect(() => { void load() }, [load, refreshKey])
  if (hideWhenEmpty && loaded && !rules.length && !error) return null
  return wrap(
    <div className="session-rules">
      {error && <div className="inline-notice error"><Icon name="warning" /><span>{error}</span></div>}
      {loaded && !rules.length && !error && <p className="session-rules-empty">当前没有生效的会话规则。在审批卡中选择「本会话总是允许此类操作」后会显示在这里。</p>}
      {rules.map((rule) => <div className="session-rule" key={rule.id}>
        <span className="session-rule-icon"><Icon name={rule.kind === 'shell_prefix' ? 'terminal' : 'edit'} size={14} /></span>
        <span className="session-rule-main">
          <strong>{rule.label}</strong>
          <small>{rule.kind === 'shell_prefix' ? '命令前缀' : '同类工具'} · 已自动允许 {rule.useCount} 次{showRun && rule.runTitle ? ` · ${rule.runTitle}` : ''}{rule.createdAt ? ` · ${formatTime(rule.createdAt)} 起` : ''}</small>
        </span>
        <button type="button" className="button secondary small" onClick={async () => { try { await bridge.revokeSessionRule(rule.id); await load() } catch (cause) { setError(errorMessage(cause)) } }}>撤销</button>
      </div>)}
      {rules.length > 0 && <p className="session-rules-footnote"><Icon name="info" size={12} />规则仅在本次运行 DeskForge 期间有效；高风险、外部发送和删除类操作始终逐次确认。</p>}
    </div>
  )
}
