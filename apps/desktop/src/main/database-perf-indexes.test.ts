import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { presentRun } from './presenters'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('Database Stage 2 Optimizations', () => {
  it('uses indexes for artifacts, approvals, and task_steps queries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deskforge-indexes-'))
    directories.push(dir)
    const database = new AppDatabase(join(dir, 'test.sqlite3'))
    const rawDb = (database as any).db

    // 1. Verify artifacts_run_idx
    const planArtifacts = rawDb.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at DESC',
    ).all('run-1') as Array<{ detail: string }>
    expect(planArtifacts.some((p) => p.detail.includes('artifacts_run_idx'))).toBe(true)

    // 2. Verify approvals_run_idx
    const planApprovals = rawDb.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM approvals WHERE run_id=? AND status='pending' ORDER BY created_at",
    ).all('run-1') as Array<{ detail: string }>
    expect(planApprovals.some((p) => p.detail.includes('approvals_run_idx'))).toBe(true)

    // 3. Verify task_steps_run_idx
    const planSteps = rawDb.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM task_steps WHERE run_id=? ORDER BY ordinal',
    ).all('run-1') as Array<{ detail: string }>
    expect(planSteps.some((p) => p.detail.includes('task_steps_run_idx'))).toBe(true)

    database.close()
  })

  it('correctly backfills token usage from legacy audit_events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deskforge-backfill-'))
    directories.push(dir)
    const database = new AppDatabase(join(dir, 'test.sqlite3'))
    const rawDb = (database as any).db

    const workspaceId = database.addWorkspace('/tmp/workspace', 'Workspace')
    const run = database.createRun({ prompt: 'Initial prompt', workspaceId })

    // Simulate legacy audit events inserted directly without updating runs table
    rawDb.prepare(`
      INSERT INTO audit_events(category, action, run_id, summary, payload_json, created_at)
      VALUES('model', 'completion', ?, 'Turn 1', ?, ?)
    `).run(
      run.id,
      JSON.stringify({ usage: { input: 100, output: 50, cacheRead: 20, reasoning: 10, totalTokens: 170 } }),
      new Date().toISOString(),
    )
    rawDb.prepare(`
      INSERT INTO audit_events(category, action, run_id, summary, payload_json, created_at)
      VALUES('model', 'completion', ?, 'Turn 2', ?, ?)
    `).run(
      run.id,
      JSON.stringify({ usage: { input: 200, output: 80, cacheRead: 0, reasoning: 5, totalTokens: 280 } }),
      new Date().toISOString(),
    )

    // Reset runs token columns to 0
    rawDb.prepare('UPDATE runs SET model_calls=0, prompt_tokens=0, completion_tokens=0, total_tokens=0 WHERE id=?').run(run.id)

    // Trigger backfill
    database.backfillRunTokenUsage()

    const usage = database.getRunTokenUsage(run.id)
    expect(usage).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 20,
      reasoningTokens: 15,
      totalTokens: 450,
      modelCalls: 2,
    })

    database.close()
  })

  it('derives the same completion status from a summary row as from the hydrated run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deskforge-summary-verification-'))
    directories.push(dir)
    const database = new AppDatabase(join(dir, 'test.sqlite3'))
    const rawDb = (database as any).db
    const profile = { id: 'p', name: 'p', provider: 'custom', modelId: 'm', baseUrl: 'https://example.com/v1', capabilities: { contextWindow: 1000, maxOutputTokens: 100, reasoning: false, toolCalling: true } } as any

    const run = database.createRun({ prompt: 'Verify me' })
    const insertEvent = rawDb.prepare('INSERT INTO run_events(run_id,type,level,summary,payload_json,created_at) VALUES(?,?,?,?,?,?)')
    insertEvent.run(run.id, 'run.turn_started', 'info', 'turn', '{}', '2026-01-01T00:00:01.000Z')
    rawDb.prepare(`INSERT INTO tool_calls(id,provider_call_id,run_id,tool_id,state,risk,arguments_json,created_at,updated_at)
      VALUES('call-1','p-1',?,'file_write','succeeded','reversible_write','{}',?,?)`).run(run.id, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z')
    insertEvent.run(run.id, 'verification.completed', 'info', 'verified', JSON.stringify({ verification: { status: 'verified', checks: [] } }), '2026-01-01T00:00:03.000Z')
    database.updateRun(run.id, { status: 'completed', outcome: 'verified' })

    const fromDetail = presentRun(database.getRun(run.id), profile)
    const fromSummary = presentRun(database.getRunSummaryRow(run.id), profile)
    const fromList = presentRun(database.listRunSummaries({})[0], profile)
    expect(fromDetail.completionStatus).toBe('verified')
    expect(fromSummary.completionStatus).toBe('verified')
    expect(fromList.completionStatus).toBe('verified')

    database.close()
  })

  it('filters run summaries by workspaceId and status via SQL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deskforge-filter-'))
    directories.push(dir)
    const database = new AppDatabase(join(dir, 'test.sqlite3'))

    const ws1 = database.addWorkspace('/tmp/ws1', 'WS 1')
    const ws2 = database.addWorkspace('/tmp/ws2', 'WS 2')

    const r1 = database.createRun({ prompt: 'Task 1 in WS1', workspaceId: ws1 })
    database.updateRun(r1.id, { status: 'completed' })
    const r2 = database.createRun({ prompt: 'Task 2 in WS1', workspaceId: ws1 })
    database.updateRun(r2.id, { status: 'running' })
    const r3 = database.createRun({ prompt: 'Task 3 in WS2', workspaceId: ws2 })
    database.updateRun(r3.id, { status: 'completed' })

    const ws1Completed = database.listRunSummaries({ workspaceId: ws1, status: 'completed' })
    expect(ws1Completed).toHaveLength(1)
    expect(ws1Completed[0].id).toBe(r1.id)

    const ws1All = database.listRunSummaries({ workspaceId: ws1 })
    expect(ws1All).toHaveLength(2)

    const allCompleted = database.listRunSummaries({ status: 'completed' })
    expect(allCompleted).toHaveLength(2)

    database.close()
  })
})
