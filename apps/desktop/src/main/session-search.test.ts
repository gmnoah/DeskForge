import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { AppDatabase } from './database'
import { collectKnownSecrets, exportSessionMarkdown } from './session-export'
import { presentRunDetail } from './presenters'

const directories: string[] = []
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'deskforge-m4-sessions-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Reversible stand-in for safeStorage so tests can store "encrypted" secrets. */
const fakeCipher = {
  encrypt: async (value: string) => Buffer.from(`enc:${value}`),
  decrypt: async (value: Buffer) => value.toString().replace(/^enc:/, ''),
  available: async () => true,
}

describe('session search (FTS5 trigram + LIKE fallback)', () => {
  it('finds sessions by Chinese and English title and message content', async () => {
    const database = new AppDatabase(join(await temporaryDirectory(), 'state.sqlite3'))
    const weekly = database.createRun({ title: '整理季度周报', prompt: '请把 docs 目录下的周报汇总成一页' })
    database.addMessage(weekly.id, 'assistant', '已经生成摘要，包含部署风险和回滚计划。')
    const deploy = database.createRun({ title: 'Fix deploy script', prompt: 'The Deployment pipeline fails on staging' })
    database.addMessage(deploy.id, 'system', '内部系统提示：周报 不应被搜索到')
    const other = database.createRun({ title: '无关任务', prompt: 'hello world' })

    // 2-char Chinese term → LIKE fallback; matches title.
    expect(database.searchRuns('周报').map((hit) => hit.runId)).toEqual([weekly.id])
    // 3+ char Chinese term → trigram MATCH inside message content.
    const rollback = database.searchRuns('回滚计划')
    expect(rollback).toEqual([expect.objectContaining({ runId: weekly.id, matchedIn: 'message' })])
    expect(rollback[0]!.snippet).toContain('回滚计划')
    // English, case-insensitive, substring inside a word.
    expect(database.searchRuns('deployment').map((hit) => hit.runId)).toEqual([deploy.id])
    expect(database.searchRuns('DEPLOY').map((hit) => hit.runId)).toEqual([deploy.id])
    // Mixed terms are ANDed within a row; title hits rank above message hits.
    expect(database.searchRuns('部署 风险').map((hit) => hit.runId)).toEqual([weekly.id])
    expect(database.searchRuns('季度周报')[0]).toMatchObject({ runId: weekly.id, matchedIn: 'title' })
    // System messages and FTS syntax are not searchable / not injectable.
    expect(database.searchRuns('内部系统提示')).toEqual([])
    expect(() => database.searchRuns('"unbalanced NEAR( * OR')).not.toThrow()
    expect(database.searchRuns('   ')).toEqual([])
    expect(database.searchRuns('hello', { workspaceId: 'missing' })).toEqual([])
    expect(database.searchRuns('hello').map((hit) => hit.runId)).toEqual([other.id])
    database.close()
  })

  it('keeps the index in sync on rename and delete, and backfills an existing database', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'state.sqlite3')
    const database = new AppDatabase(path)
    const run = database.createRun({ title: '旧标题', prompt: 'alpha content' })
    database.renameRun(run.id, '新的会话名称')
    expect(database.getRun(run.id).title).toBe('新的会话名称')
    expect(database.searchRuns('旧标题')).toEqual([])
    expect(database.searchRuns('会话名称').map((hit) => hit.runId)).toEqual([run.id])
    expect(() => database.renameRun('missing', 'x')).toThrow('会话不存在')
    const child = database.createRun({ title: '子任务 alpha', prompt: 'alpha child', parentRunId: run.id })
    expect(database.searchRuns('alpha').map((hit) => hit.runId)).toEqual([run.id])
    expect(child.id).toBeTruthy()
    database.deleteRun(run.id)
    expect(database.searchRuns('alpha')).toEqual([])
    const kept = database.createRun({ title: 'Backfill 测试', prompt: '历史消息内容' })
    database.close()

    // Simulate a pre-M4 database: drop the index and triggers, then reopen.
    const raw = new Database(path)
    raw.exec('DROP TABLE run_search')
    for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'run_search_%'").all() as Array<{ name: string }>) raw.exec(`DROP TRIGGER ${row.name}`)
    raw.close()
    const reopened = new AppDatabase(path)
    expect(reopened.searchRuns('历史消息').map((hit) => hit.runId)).toEqual([kept.id])
    expect(reopened.searchRuns('backfill').map((hit) => hit.runId)).toEqual([kept.id])
    reopened.close()
  })
})

describe('session Markdown export', () => {
  it('writes a redacted export via the save-dialog target and audits it', async () => {
    const directory = await temporaryDirectory()
    const database = new AppDatabase(join(directory, 'state.sqlite3'))
    const modelKey = 'mk-' + 'z'.repeat(24)
    const mcpToken = 'mcp-token-' + 'q'.repeat(16)
    const embeddingsKey = 'emb-key-' + 'w'.repeat(16)
    const profileId = database.saveModelProfile({ name: 'DeepSeek', provider: 'deepseek', modelId: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', isDefault: true, capabilities: {} })
    database.setModelEncryptedKey(profileId, await fakeCipher.encrypt(modelKey))
    database.setAppSecret('knowledge.embeddings.apiKey', await fakeCipher.encrypt(embeddingsKey))
    database.db.prepare(`INSERT INTO mcp_servers(id,name,transport,config_json,enabled,encrypted_secret,created_at,updated_at) VALUES('mcp-1','demo','stdio','{}',1,?,?,?)`)
      .run(await fakeCipher.encrypt(JSON.stringify({ env: { API_TOKEN: mcpToken } })), new Date().toISOString(), new Date().toISOString())
    expect(await collectKnownSecrets(database, fakeCipher)).toEqual(expect.arrayContaining([modelKey, mcpToken, embeddingsKey]))

    const run = database.createRun({ title: '导出测试', prompt: `用这个 key：${modelKey}` })
    database.addMessage(run.id, 'assistant', `收到。MCP 令牌 ${mcpToken} 与向量 key ${embeddingsKey} 不会出现在导出里。`)
    const detail = presentRunDetail(database.getRun(run.id), database.listModelProfiles()[0])
    const target = join(directory, 'export.md')
    let suggested = ''
    const result = await exportSessionMarkdown(detail, { database, secrets: fakeCipher, timeZone: 'Asia/Shanghai', chooseTarget: async (name) => { suggested = name; return target } })
    expect(result).toMatchObject({ path: target, redacted: true })
    expect(suggested).toMatch(/^导出测试 \d{4}-\d{2}-\d{2}\.md$/)
    const markdown = await readFile(target, 'utf8')
    expect(markdown).toContain('# 导出测试')
    expect(markdown).toContain('## 对话')
    for (const secret of [modelKey, mcpToken, embeddingsKey]) expect(markdown).not.toContain(secret)
    expect(markdown.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3)
    expect(database.listAudit().some((entry: any) => entry.action === 'export_markdown')).toBe(true)

    expect(await exportSessionMarkdown(detail, { database, secrets: fakeCipher, chooseTarget: async () => undefined })).toBeNull()
    database.close()
  })
})
