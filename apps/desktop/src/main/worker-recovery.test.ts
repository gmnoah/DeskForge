import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from './database'
import { ArtifactStore } from './artifact-store'
import { RunCoordinator } from './run-coordinator'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  directory: string
  database: AppDatabase
  coordinator: RunCoordinator
  host: { startRun: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; cancelRun: ReturnType<typeof vi.fn> }
  runner: { cancel: ReturnType<typeof vi.fn>; cancelRun: ReturnType<typeof vi.fn> }
  broker: { rejectRunApprovals: ReturnType<typeof vi.fn>; finalizeTurn: ReturnType<typeof vi.fn> }
  broadcast: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'deskforge-recovery-'))
  directories.push(directory)
  const database = new AppDatabase(join(directory, 'state.sqlite3'))
  const host = { startRun: vi.fn(), cancelRun: vi.fn(), toolResult: vi.fn(), steer: vi.fn() }
  const runner = { cancel: vi.fn(), cancelRun: vi.fn() }
  const broker = { rejectRunApprovals: vi.fn(), finalizeTurn: vi.fn(() => ({ verificationRequired: false, outcome: null })) }
  const artifacts = new ArtifactStore(join(directory, 'artifacts'), database)
  const broadcast = vi.fn()
  const notify = vi.fn()
  const coordinator = new RunCoordinator(
    database,
    { decrypt: vi.fn(async () => 'test-api-key') } as any,
    host as any,
    runner as any,
    broker as any,
    artifacts,
    broadcast,
    notify,
  )
  return { directory, database, coordinator, host, runner, broker, broadcast, notify }
}

describe('Worker failure recovery and process cleanup (B1 & S6)', () => {
  it('transitions interrupted running tasks to paused and allows resumption after worker failure', async () => {
    const { directory, database, coordinator, broker, notify, host } = await fixture()
    const wsId = database.addWorkspace(directory, 'Test')
    const profileId = database.saveModelProfile({
      id: 'profile-1',
      name: 'Default',
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      capabilities: { contextWindow: 128_000, maxOutputTokens: 4096, reasoning: false, toolCalling: true },
      isDefault: true,
    }, Buffer.from('secret-key'))
    const run = database.createRun({
      prompt: 'Execute long build',
      workspaceId: wsId,
      modelProfileId: profileId,
      modelSnapshot: {
        profileId,
        provider: 'deepseek',
        modelId: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
        capabilities: { contextWindow: 128_000, maxOutputTokens: 4096, reasoning: false, toolCalling: true },
      },
    })
    database.transitionRun(run.id, 'running', { outcome: null, error: null, finishedAt: null })

    // Simulate worker crash event
    const recovery = coordinator.recoverAfterWorkerFailure('DeskForge tool-runner', 'crashed')

    expect(recovery.pausedRuns).toBe(1)
    expect(recovery.runIds).toContain(run.id)

    const updated = database.getRun(run.id)
    expect(updated?.status).toBe('paused')
    expect(broker.rejectRunApprovals).toHaveBeenCalledWith(run.id, expect.stringContaining('执行进程意外退出'))
    expect(notify).toHaveBeenCalledWith('任务已暂停', expect.stringContaining('DeskForge tool-runner 意外退出'))

    // Resume the run
    await coordinator.resume(run.id)
    const resumed = database.getRun(run.id)
    expect(resumed?.status).toBe('running')
    expect(host.startRun).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }))
  })

  it('terminates orphaned managed child processes by pid on recovery', async () => {
    const { database, coordinator } = await fixture()
    const run = database.createRun({ prompt: 'Start background daemon' })
    database.updateRun(run.id, { status: 'running' })

    // Spawn a real child sleep process to test real SIGTERM cleanup
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
    expect(child.pid).toBeDefined()

    database.createManagedProcess({
      id: 'proc-1',
      runId: run.id,
      commandSummary: 'sleep 60',
      cwd: '/tmp',
      pid: child.pid!,
    })

    // Trigger recovery
    coordinator.recoverAfterWorkerFailure('DeskForge tool-runner', 'killed')

    // Verify process status updated in database
    const proc = (database as any).db.prepare('SELECT status FROM managed_processes WHERE id=?').get('proc-1') as any
    expect(proc.status).toBe('interrupted')

    // Wait briefly and verify child was terminated
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true)

    try { child.kill('SIGKILL') } catch {}
  })
})
