import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { it, describe, expect } from 'vitest'
import { AppDatabase } from './database'
import { presentRun, presentRunDetail, presentRunSummary } from './presenters'

describe('Performance Baseline', () => {
  it('measures runs:list, runs:get and emitRun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deskforge-perf-'))
    const dbPath = join(directory, 'perf.sqlite3')
    const database = new AppDatabase(dbPath)

    try {
      console.log('\n[Baseline Setup] Generating 200 runs with 300 messages each...')
      const genStart = performance.now()
      const rawDb = (database as any).db

      const insertRun = rawDb.prepare(`
        INSERT INTO runs (id, title, prompt, status, workspace_id, model_profile_id, limits_json, model_snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, 'completed', NULL, NULL, '{}', '{}', ?, ?)
      `)

      const insertMsg = rawDb.prepare(`
        INSERT INTO messages (id, run_id, role, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, '{}', ?)
      `)

      const insertAudit = rawDb.prepare(`
        INSERT INTO audit_events (category, action, run_id, summary, payload_json, prev_hash, entry_hash, created_at)
        VALUES ('model', 'completion', ?, 'Model completion', ?, '0', '0', ?)
      `)

      const runIds: string[] = []
      const now = new Date()

      rawDb.transaction(() => {
        for (let r = 0; r < 200; r++) {
          const runId = randomUUID()
          runIds.push(runId)
          const runTime = new Date(now.getTime() - r * 60000).toISOString()
          insertRun.run(runId, `Run #${r + 1}`, `Prompt for run #${r + 1}`, runTime, runTime)

          const auditPayload = JSON.stringify({
            usage: { input: 120, output: 80, totalTokens: 200 }
          })
          insertAudit.run(runId, auditPayload, runTime)

          for (let m = 0; m < 300; m++) {
            const msgTime = new Date(now.getTime() - r * 60000 + m * 100).toISOString()
            const role = m % 2 === 0 ? 'user' : 'assistant'
            insertMsg.run(randomUUID(), runId, role, `Message ${m + 1} content in run ${r + 1}`, msgTime)
          }
        }
      })()

      console.log(`[Baseline Setup] Finished in ${(performance.now() - genStart).toFixed(2)} ms`)

      const dummyProfile = {
        id: 'profile-1',
        name: 'Default',
        provider: 'openai',
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        capabilities: {},
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any

      // 1. Benchmark runs:list (100 runs out of 200)
      const listStart = performance.now()
      const runs = database.listRunSummaries({ limit: 100 })
      const summaries = runs.map((row: any) => presentRunSummary(row, dummyProfile))
      expect(summaries.length).toBeGreaterThan(0)
      const listDuration = performance.now() - listStart
      console.log(`[Optimized] runs:list (100 runs out of 200): ${listDuration.toFixed(2)} ms`)

      // 2. Benchmark runs:get (1 run with 300 messages)
      const targetRunId = runIds[0]!
      const getStart = performance.now()
      const targetRun = database.getRun(targetRunId)
      const targetDetail = presentRunDetail(targetRun, dummyProfile)
      const getDuration = performance.now() - getStart
      console.log(`[Baseline] runs:get (1 run, 300 msgs): ${getDuration.toFixed(2)} ms (messages: ${targetDetail.messages.length})`)

      // 3. Create a 2000-message run and benchmark opening time
      const bigRunId = randomUUID()
      insertRun.run(bigRunId, 'Big Run 2000 msgs', 'Prompt for big run', new Date().toISOString(), new Date().toISOString())
      rawDb.transaction(() => {
        for (let m = 0; m < 2000; m++) {
          const role = m % 2 === 0 ? 'user' : 'assistant'
          insertMsg.run(randomUUID(), bigRunId, role, `Message ${m + 1} content in big run`, new Date().toISOString())
        }
      })()
      const bigGetStart = performance.now()
      const bigRun = database.getRun(bigRunId)
      const bigDetail = presentRunDetail(bigRun, dummyProfile)
      const bigGetDuration = performance.now() - bigGetStart
      console.log(`[Baseline] 2000 msgs run getDetail: ${bigGetDuration.toFixed(2)} ms (messages: ${bigDetail.messages.length})`)

      // 4. Benchmark emitRun simulation (getRun + presentRun + JSON serialization)
      const emitStart = performance.now()
      const emittedRun = database.getRun(targetRunId)
      const payload = JSON.stringify({
        id: randomUUID(),
        runId: targetRunId,
        sequence: 1,
        at: new Date().toISOString(),
        kind: 'run.updated',
        run: presentRun(emittedRun, dummyProfile),
      })
      const emitDuration = performance.now() - emitStart
      const payloadBytes = Buffer.byteLength(payload, 'utf8')
      console.log(`[Baseline] emitRun: ${emitDuration.toFixed(2)} ms (payload size: ${(payloadBytes / 1024).toFixed(2)} KB)`)

      console.log('\n--- BASELINE METRICS ---')
      console.log(`runs:list (100 runs): ${listDuration.toFixed(2)} ms`)
      console.log(`runs:get (300 msgs): ${getDuration.toFixed(2)} ms`)
      console.log(`runs:get (2000 msgs): ${bigGetDuration.toFixed(2)} ms`)
      console.log(`emitRun (300 msgs): ${emitDuration.toFixed(2)} ms`)
      console.log(`run.updated payload: ${(payloadBytes / 1024).toFixed(2)} KB`)
      console.log('-------------------------\n')

    } finally {
      database.close()
      await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }, 60000)
})
