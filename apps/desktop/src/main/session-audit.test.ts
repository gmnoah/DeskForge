import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { auditExportFileName, auditToCsv, auditToJson, auditToMarkdown, csvCell, presentAuditRecord, renderAuditExport } from './audit-export'
import { AppDatabase } from './database'
import { presentSessionRule } from './presenters'

const directories: string[] = []

async function temporaryDatabase(): Promise<{ path: string; database: AppDatabase }> {
  const directory = await mkdtemp(join(tmpdir(), 'deskforge-m2-'))
  directories.push(directory)
  const path = join(directory, 'state.sqlite3')
  return { path, database: new AppDatabase(path) }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('session approval rules persistence', () => {
  it('stores run-scoped rules, dedupes them, supports revoke and expires them on app restart', async () => {
    const { path, database } = await temporaryDatabase()
    const run = database.createRun({ title: '整理周报', prompt: 'x' })
    const rule = database.addSessionRule({ runId: run.id, kind: 'shell_prefix', toolId: 'shell_run', riskLevel: 'reversible_write', commandPrefix: 'npm test', label: '以「npm test」开头的命令' })
    expect(database.addSessionRule({ runId: run.id, kind: 'shell_prefix', toolId: 'shell_run', riskLevel: 'reversible_write', commandPrefix: 'npm test', label: 'dup' }).id).toBe(rule.id)
    database.touchSessionRule(rule.id)
    const listed = database.listSessionRules(run.id).map(presentSessionRule)
    expect(listed).toEqual([expect.objectContaining({ id: rule.id, runTitle: '整理周报', kind: 'shell_prefix', commandPrefix: 'npm test', useCount: 1 })])
    const other = database.addSessionRule({ runId: run.id, kind: 'tool', toolId: 'file_write', riskLevel: 'reversible_write', label: '写入' })
    expect(database.revokeSessionRule(other.id)).toBe(true)
    expect(database.revokeSessionRule(other.id)).toBe(false)
    expect(database.listSessionRules().map((row) => row.id)).toEqual([rule.id])
    database.close()

    const reopened = new AppDatabase(path)
    expect(reopened.listSessionRules()).toEqual([])
    expect(reopened.getSessionRule(rule.id)).toMatchObject({ revoke_reason: 'app_restart' })
    expect(reopened.queryAudit({ category: 'approval' }).rows.some((row) => row.action === 'session_rules_expired')).toBe(true)
    reopened.close()
  })
})

describe('audit query and chain report', () => {
  it('filters by run, category, outcome, time and text', async () => {
    const { database } = await temporaryDatabase()
    const a = database.createRun({ title: 'A', prompt: 'a' })
    const b = database.createRun({ title: 'B', prompt: 'b' })
    database.audit('tool', 'file_write', 'Agent 请求 写入文件', { actor: 'agent', outcome: 'require_approval' }, a.id)
    database.audit('approval', 'file_write', '会话规则自动批准 写入文件', { actor: 'system', outcome: 'auto_approved', sessionRule: { id: 'rule-1', label: '写入' } }, a.id)
    database.audit('tool', 'shell_run', '运行命令完成 100%_done', { actor: 'tool', outcome: 'succeeded' }, b.id)
    expect(database.queryAudit({ runId: a.id }).total).toBe(2)
    expect(database.queryAudit({ category: 'approval' }).rows.map((row) => row.action)).toEqual(['file_write'])
    expect(database.queryAudit({ outcome: 'auto_approved' }).rows).toHaveLength(1)
    expect(database.queryAudit({ text: '100%_' }).rows).toHaveLength(1)
    expect(database.queryAudit({ text: '%' }).rows).toHaveLength(1)
    expect(database.queryAudit({ from: '2999-01-01T00:00:00.000Z' }).rows).toHaveLength(0)
    expect(database.queryAudit({ limit: 1 })).toMatchObject({ total: 3, rows: [expect.objectContaining({ action: 'shell_run' })] })
    expect(database.auditRuns().map((run) => run.title)).toEqual(['B', 'A'])
    expect(database.auditCategories()).toEqual(['approval', 'tool'])
  })

  it('detects modified entries and broken links', async () => {
    const { database } = await temporaryDatabase()
    for (let index = 0; index < 5; index += 1) database.audit('tool', `action-${index}`, `entry ${index}`, { outcome: 'succeeded' })
    expect(database.auditChainReport().summary).toMatchObject({ valid: true, hashedEntries: 5, brokenIds: [], linkBreakIds: [] })
    const ids = (database.db.prepare('SELECT id FROM audit_events ORDER BY id').all() as Array<{ id: number }>).map((row) => row.id)
    database.db.prepare('UPDATE audit_events SET summary=? WHERE id=?').run('tampered', ids[1])
    database.db.prepare('DELETE FROM audit_events WHERE id=?').run(ids[3])
    const report = database.auditChainReport()
    expect(report.summary.valid).toBe(false)
    expect(report.summary.brokenIds).toEqual([String(ids[1])])
    expect(report.summary.linkBreakIds).toEqual([String(ids[4])])
    expect(report.status.get(ids[0]!)).toBe('ok')
    expect(report.status.get(ids[4]!)).toBe('unlinked')
  })
})

describe('audit export', () => {
  const chain = { valid: true, checkedEntries: 2, hashedEntries: 2, legacyEntries: 0, brokenIds: [], linkBreakIds: [], checkedAt: '2026-10-06T09:00:00.000Z' }
  const records = [
    presentAuditRecord({ id: 2, run_id: 'run-1', category: 'approval', action: 'shell_run', summary: '会话规则自动批准 运行命令, "npm test"\n第二行', payload: { actor: 'system', outcome: 'auto_approved', riskLevel: 'reversible_write', target: 'npm test', sessionRule: { id: 'rule-1', label: '以「npm test」开头的命令' } }, prev_hash: 'a'.repeat(64), entry_hash: 'b'.repeat(64), created_at: '2026-10-06T09:01:00.000Z' }, 'ok'),
    presentAuditRecord({ id: 1, category: 'tool', action: 'file_write', summary: '=HYPERLINK("evil") | pipe', payload: { outcome: 'allow', token: 'sk-abcdefghijklmnop' }, created_at: '2026-10-06T09:00:00.000Z' }, 'legacy'),
  ]
  const meta = { exportedAt: '2026-10-06T09:05:00.000Z', filters: { runId: 'run-1' }, chain, total: 2 }

  it('presents records with outcome aliases and the matched session rule', () => {
    expect(records[0]).toMatchObject({ outcome: 'auto_approved', ruleId: 'rule-1', ruleLabel: '以「npm test」开头的命令', chain: 'ok', entryHash: 'b'.repeat(64) })
    expect(records[1]).toMatchObject({ outcome: 'allowed', chain: 'legacy' })
    expect(records[1]!.runId).toBeUndefined()
  })

  it('exports CSV with quoting, BOM and formula-injection guard', () => {
    const csv = auditToCsv(records)
    expect(csv.startsWith('\uFEFFid,createdAt,runId,category,action,outcome')).toBe(true)
    expect(csv).toContain('"会话规则自动批准 运行命令, ""npm test""\n第二行"')
    expect(csv).toContain(`'=HYPERLINK(""evil"") | pipe`)
    expect(csv).toContain('rule-1,以「npm test」开头的命令')
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3)
    expect(csvCell('-1')).toBe("'-1")
    expect(csvCell(undefined)).toBe('')
  })

  it('exports JSON with chain status and Markdown with escaped tables', () => {
    const parsed = JSON.parse(auditToJson(records, meta))
    expect(parsed).toMatchObject({ format: 'deskforge-audit-v1', total: 2, exported: 2, chain: { valid: true }, filters: { runId: 'run-1' } })
    expect(parsed.entries[0]).toMatchObject({ id: '2', prevHash: 'a'.repeat(64), entryHash: 'b'.repeat(64) })
    const markdown = auditToMarkdown(records, meta)
    expect(markdown).toContain('# DeskForge 审计日志导出')
    expect(markdown).toContain('✅ 哈希链校验通过')
    expect(markdown).toContain('会话规则自动批准')
    expect(markdown).toContain('=HYPERLINK("evil") \\| pipe')
    expect(markdown).not.toContain('\n第二行')
    expect(auditToMarkdown(records, { ...meta, chain: { ...chain, valid: false, brokenIds: ['7'] } })).toContain('❌ 哈希链校验失败：1 条记录被修改（ID 7）')
  })

  it('redacts key-shaped secrets in every format and names files by format', () => {
    for (const format of ['json', 'csv', 'markdown'] as const) expect(renderAuditExport(format, records, meta)).not.toContain('sk-abcdefghijklmnop')
    expect(auditExportFileName('markdown', new Date('2026-10-06T09:05:07.000Z'))).toBe('deskforge-audit-2026-10-06-09-05-07.md')
    expect(auditExportFileName('csv', new Date('2026-10-06T09:05:07.000Z'))).toBe('deskforge-audit-2026-10-06-09-05-07.csv')
  })
})
