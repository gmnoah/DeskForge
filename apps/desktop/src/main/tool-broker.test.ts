import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolBroker, type McpBrokerBridge } from './tool-broker'

const now = '2026-07-11T00:00:00.000Z'

class FakeDatabase {
  settings: Record<string, unknown> = { appSettings: { memoryEnabled: true, permissionMode: 'cautious' } }
  run: any = { id: 'run-1', workspaceId: 'workspace-1', accessMode: 'approval', steps: [], status: 'running', readOnly: false }
  toolRows: any[] = []
  artifactRows: any[] = []
  savedMemory: any
  granted = true
  approvals: any[] = []
  skills = new Map<string, any>()
  events: any[] = []
  workspaceRoot = '/workspace'
  private nextToolReceipt = 0
  currentTurnStartedAt: string | undefined

  db = {
    prepare: (sql: string) => {
      if (sql.includes('FROM tool_calls')) {
        return { all: (runId: string) => this.toolRows.filter((row) => row.run_id === runId && row.tool_id !== 'task_complete') }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }

  getRun = (id: string) => id === this.run.id ? this.run : undefined
  getWorkspace = () => ({ root_path: this.workspaceRoot })
  getMcpServer = (id: string) => ({ id, name: id })
  getArtifact = (id: string) => this.artifactRows.find((artifact) => artifact.id === id)
  getSetting = <T>(key: string, fallback: T): T => (this.settings[key] ?? fallback) as T
  hasRunGrant = () => this.granted
  audit = (category: string, action: string, summary: string, payload: any = {}, runId?: string) => { this.auditEntries.push({ category, action, summary, payload, runId }) }
  appendRunEvent = (runId: string, type: string, summary: string, payload: unknown) => this.events.push({ runId, type, summary, payload })
  listArtifacts = () => this.artifactRows
  updateRun = (_id: string, patch: Record<string, unknown>) => Object.assign(this.run, patch)
  transitionRun = (_id: string, status: string, patch: Record<string, unknown> = {}) => Object.assign(this.run, patch, { status })
  getCurrentRunTurnStartedAt = () => this.currentTurnStartedAt
  hasPendingApprovals = () => this.approvals.some((approval) => approval.status === undefined || approval.status === 'pending')
  saveMemory = (input: any) => { this.savedMemory = input; return 'memory-1' }
  getSkill = (id: string) => this.skills.get(id)
  createApproval = (input: any) => { this.approvals.push({ ...input, status: 'pending' }); return input }
  resolveApproval = (id: string, decision: any) => { const approval = this.approvals.find((candidate) => candidate.id === id); if (approval) approval.status = decision.decision === 'reject' ? 'denied' : 'approved'; return { id, decision } }
  addGrant = () => undefined
  createManagedProcess = () => undefined
  sessionRules: any[] = []
  auditEntries: any[] = []
  listSessionRules = (runId?: string) => this.sessionRules.filter((rule) => !rule.revoked_at && (!runId || rule.run_id === runId))
  addSessionRule = (input: any) => { const row = { id: `rule-${this.sessionRules.length + 1}`, run_id: input.runId, kind: input.kind, tool_id: input.toolId, risk_level: input.riskLevel, command_prefix: input.commandPrefix ?? null, label: input.label, use_count: 0, created_at: now, revoked_at: null }; this.sessionRules.push(row); return row }
  touchSessionRule = (id: string) => { const rule = this.sessionRules.find((candidate) => candidate.id === id); if (rule) rule.use_count += 1 }
  getSessionRule = (id: string) => this.sessionRules.find((candidate) => candidate.id === id)
  revokeSessionRule = (id: string) => { const rule = this.getSessionRule(id); if (rule) rule.revoked_at = now; return Boolean(rule) }
  updateTaskStep = (runId: string, stepId: string, patch: { status: string; evidence?: string }) => {
    const step = this.run.steps.find((candidate: any) => candidate.id === stepId && candidate.runId === runId)
    if (!step) throw new Error('step not found')
    if (patch.status === 'completed' && !patch.evidence && !step.verification) throw new Error('evidence required')
    Object.assign(step, { status: patch.status, updatedAt: now }, patch.evidence ? { verification: patch.evidence, evidence: [patch.evidence] } : {})
    return step
  }
  createToolCall = (input: any) => {
    const id = input.id ?? `receipt-${++this.nextToolReceipt}`
    this.toolRows.push({ id, provider_call_id: input.providerCallId ?? id, run_id: input.runId, tool_id: input.toolId, state: 'requested', arguments_json: JSON.stringify(input.arguments), result_json: null, error: null, created_at: now, updated_at: now })
    return id
  }
  updateToolCall = (id: string, state: string, result?: unknown, error?: string) => {
    const row = this.toolRows.find((candidate) => candidate.id === id)
    if (row) Object.assign(row, { state, result_json: result === undefined ? null : JSON.stringify(result), error: error ?? null, updated_at: now })
  }
}

function brokerFixture(database = new FakeDatabase(), execute?: (input: any, onProgress?: (progress: any) => void) => Promise<any>, mcp?: McpBrokerBridge) {
  const stored: any[] = []
  const events: any[] = []
  const runner = { execute: execute ?? (async () => ({})) }
  const artifacts = {
    putText: async (input: any) => {
      const artifact = { id: `artifact-${stored.length + 1}`, ...input }
      stored.push(artifact)
      database.artifactRows.push({ ...artifact, name: input.name })
      return artifact
    },
    putBuffer: async (input: any) => {
      const artifact = { id: `artifact-${stored.length + 1}`, ...input, name: input.name, size: input.data.length, sha256: 'a'.repeat(64), mime: input.mime ?? 'application/octet-stream' }
      stored.push(artifact)
      database.artifactRows.push({ ...artifact, run_id: input.runId, metadata_json: JSON.stringify(input.metadata ?? {}) })
      return artifact
    },
    read: async (path: string) => readFile(path),
  }
  const broker = new ToolBroker(database as any, runner as any, artifacts as any, {} as any, {} as any, (event) => events.push(event), async () => ({}), undefined, undefined, mcp)
  return { broker, database, stored, events }
}

describe('ToolBroker completion gate', () => {
  it('automatically gates operational turns that end without task_complete', () => {
    const fixture = brokerFixture()
    fixture.database.run.steps = [{ id: 'step-1', runId: 'run-1', title: 'write report', ordinal: 0, status: 'pending', createdAt: now, updatedAt: now }]
    fixture.database.toolRows.push({ id: 'write-1', run_id: 'run-1', tool_id: 'file_write', state: 'failed', arguments_json: JSON.stringify({ path: 'report.md', content: 'draft' }), result_json: null, error: 'stale write', created_at: now, updated_at: now })

    const result = fixture.broker.finalizeTurn('run-1', 'Report complete')

    expect(result.outcome).toBe('partial')
    expect(fixture.database.run).toMatchObject({ status: 'verifying', outcome: 'partial' })
    expect(result.verification?.summary).toContain('incomplete step')
    expect(result.verification?.summary).toContain('必要工具操作仍失败')
  })

  it('treats task_complete alone as ordinary conversation instead of inventing a partial verdict', async () => {
    const { broker, database, events } = brokerFixture()
    const result = await broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: ['tests passed'], unverified: [] } }) as any
    expect(result).toMatchObject({ verificationRequired: false, outcome: null })
    expect(database.run.outcome).toBeNull()
    expect(events.some((event) => event.kind === 'verification.completed')).toBe(false)
  })

  it('does not treat one successful read or one durable Diff as a correctness check', async () => {
    const readFixture = brokerFixture()
    readFixture.database.toolRows.push({ id: 'read-1', run_id: 'run-1', tool_id: 'file_read', state: 'succeeded', arguments_json: JSON.stringify({ path: 'README.md' }), result_json: JSON.stringify({ sha256: 'x' }), error: null, created_at: now, updated_at: now })
    const readResult = await readFixture.broker.handle({ runId: 'run-1', requestId: 'request-read', toolCallId: 'complete-read', toolId: 'task_complete', args: { summary: 'read', evidence: [], unverified: [] } }) as any
    expect(readResult.outcome).toBe('partial')
    expect(readResult.verificationRequired).toBe(true)
    expect(readResult.evidence).toContain('读取回执：1 个可观察来源读取成功，0 个失败')

    const diffFixture = brokerFixture()
    diffFixture.database.artifactRows.push({ id: 'diff-1', run_id: 'run-1', kind: 'diff', name: 'change.diff' })
    const diffResult = await diffFixture.broker.handle({ runId: 'run-1', requestId: 'request-diff', toolCallId: 'complete-diff', toolId: 'task_complete', args: { summary: 'diff', evidence: [], unverified: [] } }) as any
    expect(diffResult.outcome).toBe('partial')
    expect(diffResult.evidence).toContain('文件 Diff：1 个持久化 Diff')
  })

  it('never bulk-completes pending steps during final verification', async () => {
    const fixture = brokerFixture()
    fixture.database.run.steps = [{ id: 'step-1', runId: 'run-1', title: 'implement', ordinal: 0, status: 'pending', createdAt: now, updatedAt: now }]
    fixture.database.toolRows.push({ id: 'shell-1', run_id: 'run-1', tool_id: 'shell_run', state: 'succeeded', arguments_json: JSON.stringify({ command: 'pnpm test' }), result_json: JSON.stringify({ code: 0 }), error: null, created_at: now, updated_at: now })
    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: [], unverified: [] } }) as any
    expect(result.outcome).toBe('partial')
    expect(fixture.database.run.steps[0].status).toBe('pending')
  })

  it('accepts explicitly completed steps with step evidence and successful validation', async () => {
    const fixture = brokerFixture()
    fixture.database.run.steps = [{ id: 'step-1', runId: 'run-1', title: 'implement', ordinal: 0, status: 'pending', createdAt: now, updatedAt: now }]
    await fixture.broker.handle({ runId: 'run-1', requestId: 'step-start', toolCallId: 'step-tool-1', toolId: 'task_step_update', args: { stepId: 'step-1', status: 'in_progress' } })
    await fixture.broker.handle({ runId: 'run-1', requestId: 'step-done', toolCallId: 'step-tool-2', toolId: 'task_step_update', args: { stepId: 'step-1', status: 'completed', evidence: '实现已保存并准备验证' } })
    fixture.database.toolRows.push({ id: 'shell-1', run_id: 'run-1', tool_id: 'shell_run', state: 'succeeded', arguments_json: JSON.stringify({ command: 'pnpm test' }), result_json: JSON.stringify({ code: 0 }), error: null, created_at: now, updated_at: now })
    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: [], unverified: [] } }) as any
    expect(result.outcome).toBe('verified')
    expect(fixture.database.run.steps[0]).toMatchObject({ status: 'completed', verification: '实现已保存并准备验证' })
    expect(fixture.events.some((event) => event.kind === 'step.updated' && event.step.verification)).toBe(true)
  })

  it('keeps file mutations partial without a successful post-mutation validation command', async () => {
    const fixture = brokerFixture()
    fixture.database.toolRows.push({ id: 'write-1', run_id: 'run-1', tool_id: 'file_write', state: 'succeeded', arguments_json: JSON.stringify({ path: 'x.ts', content: 'x' }), result_json: JSON.stringify({ sha256: 'x' }), error: null, created_at: now, updated_at: now })
    fixture.database.artifactRows.push({ id: 'diff-1', run_id: 'run-1', kind: 'diff', name: 'x.diff' })
    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'complete', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: [], unverified: [] } }) as any
    expect(result.outcome).toBe('partial')
    expect(result.verification.checks).toContainEqual(expect.objectContaining({ name: '文件修改验证', status: 'not_run' }))
  })

  it('verifies a file mutation after a successful validation command', async () => {
    const fixture = brokerFixture()
    fixture.database.toolRows.push(
      { id: 'write-1', run_id: 'run-1', tool_id: 'file_write', state: 'succeeded', arguments_json: JSON.stringify({ path: 'x.ts', content: 'x' }), result_json: JSON.stringify({ sha256: 'x' }), error: null, created_at: now, updated_at: now },
      { id: 'shell-1', run_id: 'run-1', tool_id: 'shell_run', state: 'succeeded', arguments_json: JSON.stringify({ command: 'pnpm test' }), result_json: JSON.stringify({ code: 0 }), error: null, created_at: now, updated_at: now },
    )
    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'complete', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: [], unverified: [] } }) as any
    expect(result.outcome).toBe('verified')
    expect(result.evidence).toContain('验证命令：pnpm test')
  })
})

describe('ToolBroker file leases and artifacts', () => {
  it('persists runner progress at most once per 2.5 seconds for one tool request', async () => {
    const database = new FakeDatabase()
    const fixture = brokerFixture(database, async (_input, onProgress) => {
      onProgress?.({ channel: 'stdout', text: 'one' })
      onProgress?.({ channel: 'stdout', text: 'two' })
      onProgress?.({ channel: 'stdout', text: 'three' })
      return { entries: [] }
    })

    await fixture.broker.handle({ runId: 'run-1', requestId: 'list-progress', toolCallId: 'list-progress', toolId: 'file_list', args: { path: '.' } })

    expect(database.events.filter((event) => event.type === 'tool.progress')).toHaveLength(1)
  })

  it('opens only attachments belonging to the current run without scanning by filename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deskforge-attachment-'))
    const path = join(directory, 'dataset.csv')
    await writeFile(path, 'value\n42\n')
    const database = new FakeDatabase()
    database.artifactRows.push({ id: 'attachment-1', run_id: 'run-1', kind: 'attachment', name: 'dataset.csv', path, mime: 'text/csv', size: 9, sha256: 'b'.repeat(64) })
    const fixture = brokerFixture(database)

    const opened = await fixture.broker.handle({ runId: 'run-1', requestId: 'open-1', toolCallId: 'open-1', toolId: 'attachment_open', args: { artifactId: 'attachment-1' } }) as any
    expect(opened).toMatchObject({ artifactId: 'attachment-1', path, mime: 'text/csv' })
    expect(opened.preview).toContain('42')
    await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'open-2', toolCallId: 'open-2', toolId: 'attachment_open', args: { artifactId: 'missing' } })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_AVAILABLE' })
    await rm(directory, { recursive: true, force: true })
  })

  it('registers safe generated files as final outputs and rejects credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deskforge-output-'))
    await writeFile(join(directory, 'report.md'), '# Result\n')
    await writeFile(join(directory, '.env'), 'TOKEN=secret\n')
    const database = new FakeDatabase()
    database.workspaceRoot = directory
    const fixture = brokerFixture(database)

    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'output-1', toolCallId: 'output-1', toolId: 'output_register', args: { outputs: [{ path: 'report.md', label: '分析报告.md' }] } }) as any
    expect(result).toMatchObject({ registered: 1 })
    expect(fixture.stored).toContainEqual(expect.objectContaining({ kind: 'final_output', name: '分析报告.md' }))
    await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'output-2', toolCallId: 'output-2', toolId: 'output_register', args: { outputs: [{ path: '.env' }] } })).rejects.toMatchObject({ code: 'SENSITIVE_OUTPUT' })
    await rm(directory, { recursive: true, force: true })
  })

  it('offloads long web bodies and generic tool results before returning them to the model', async () => {
    const fixture = brokerFixture()
    const web = await (fixture.broker as any).captureArtifacts('run-1', { id: 'web_fetch' }, { url: 'https://example.test', status: 200, contentType: 'text/plain', text: 'x'.repeat(20_000), total: 20_000 })
    expect(web.text).toHaveLength(12_000)
    expect(web.artifact.id).toBeDefined()
    const generic = await (fixture.broker as any).captureArtifacts('run-1', { id: 'mcp_call_tool' }, { content: 'y'.repeat(40_000) })
    expect(generic.preview).toHaveLength(8_000)
    expect(fixture.stored.filter((artifact) => artifact.kind === 'tool_result')).toHaveLength(2)
  })

  it('stages long output in bounded chunks and commits it as one atomic file mutation', async () => {
    const executed: any[] = []
    const fixture = brokerFixture(new FakeDatabase(), async (input) => {
      executed.push(input)
      if (input.toolId === 'file.read') throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      if (input.toolId === 'file.write') return { path: '/workspace/report.md', before: null, after: input.args.content, beforeSha256: null, sha256: 'draft-hash', created: true }
      return {}
    })

    const started = await fixture.broker.handle({ runId: 'run-1', requestId: 'draft-start', toolCallId: 'draft-start', toolId: 'file_draft_start', args: { path: 'report.md', content: 'first\n' } }) as any
    await fixture.broker.handle({ runId: 'run-1', requestId: 'draft-append', toolCallId: 'draft-append', toolId: 'file_draft_append', args: { draftId: started.draftId, content: 'second\n' } })
    const committed = await fixture.broker.handle({ runId: 'run-1', requestId: 'draft-commit', toolCallId: 'draft-commit', toolId: 'file_draft_commit', args: { draftId: started.draftId, path: 'report.md' } }) as any

    expect(executed.find((input) => input.toolId === 'file.write')?.args.content).toBe('first\nsecond\n')
    expect(committed).toMatchObject({ committed: true, totalChars: 13, sha256: 'draft-hash' })
    expect(fixture.stored.some((artifact) => artifact.kind === 'diff')).toBe(true)
  })

  it('serializes the same normalized path and records new-file snapshot/diff metadata', async () => {
    let active = 0
    let maxActive = 0
    const fixture = brokerFixture(new FakeDatabase(), async (input) => {
      if (input.toolId === 'file.read') {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      }
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return { path: '/workspace/new.txt', before: null, after: 'hello', beforeSha256: null, sha256: 'after-hash', created: true }
    })
    await Promise.all([
      fixture.broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'write-1', toolId: 'file_write', args: { path: './new.txt', content: 'hello' } }),
      fixture.broker.handle({ runId: 'run-1', requestId: 'request-2', toolCallId: 'write-2', toolId: 'file_write', args: { path: 'folder/../new.txt', content: 'hello' } }),
    ])
    expect(maxActive).toBe(1)
    const diff = fixture.stored.find((artifact) => artifact.kind === 'diff')
    expect(diff.metadata).toMatchObject({ path: '/workspace/new.txt', afterSha256: 'after-hash', createdFile: true, accessModeAtMutation: 'approval' })
    expect(diff.metadata.snapshotArtifactId).toMatch(/^artifact-/)
  })
})

describe('ToolBroker research budget', () => {
  it('reuses an identical successful search without another outbound request', async () => {
    const execute = vi.fn(async () => ({ engine: 'bing-html', query: 'GraphRAG', resultCount: 1, results: [{ title: 'Official', url: 'https://example.test' }] }))
    const database = new FakeDatabase()
    database.toolRows.push({
      id: 'search-0', run_id: 'run-1', tool_id: 'web_search', state: 'succeeded',
      arguments_json: JSON.stringify({ query: 'GraphRAG' }),
      result_json: JSON.stringify({ engine: 'bing-html', query: 'GraphRAG', resultCount: 1, results: [{ title: 'Official', url: 'https://example.test' }] }),
      error: null, created_at: now, updated_at: now,
    })
    const fixture = brokerFixture(database, execute)

    const repeated = await fixture.broker.handle({ runId: 'run-1', requestId: 'search-2', toolCallId: 'search-2', toolId: 'web_search', args: { query: '  graphrag  ', maxResults: 8 } }) as any

    expect(execute).not.toHaveBeenCalled()
    expect(repeated).toMatchObject({ resultCount: 1 })
  })

  it('stops the eleventh unique search and tells the model to converge', async () => {
    const database = new FakeDatabase()
    for (let index = 0; index < 10; index += 1) {
      database.toolRows.push({ id: `search-${index}`, run_id: 'run-1', tool_id: 'web_search', state: 'succeeded', arguments_json: JSON.stringify({ query: `query ${index}` }), result_json: JSON.stringify({ resultCount: 1, results: [] }), error: null, created_at: now, updated_at: now })
    }
    const execute = vi.fn(async () => ({ resultCount: 1, results: [] }))
    const fixture = brokerFixture(database, execute)

    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'search-11', toolCallId: 'search-11', toolId: 'web_search', args: { query: 'query 10' } }) as any

    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({ budgetExhausted: true, uniqueSearches: 10 })
    expect(result.message).toContain('基于已有来源收敛')
  })
})

describe('ToolBroker capability enforcement', () => {
  it('executes the original file content after an unchanged approval while keeping the persisted preview redacted', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const executed: any[] = []
    const fixture = brokerFixture(database, async (input) => {
      executed.push(input)
      if (input.toolId === 'file.read') throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return { path: '/workspace/notes.txt', before: null, after: input.args.content, beforeSha256: null, sha256: 'new', created: true }
    })
    const pending = fixture.broker.handle({
      runId: 'run-1', requestId: 'write-request', toolCallId: 'write-call', toolId: 'file_write',
      args: { path: 'notes.txt', content: 'original document content' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    fixture.broker.respondToApproval({ requestId: approval.id, decision: 'approve', scope: 'once' })
    await pending

    expect(executed.find((input) => input.toolId === 'file.write')?.args.content).toBe('original document content')
    expect(database.approvals[0].preview.arguments.content).toContain('[FILE CONTENT REDACTED:')
  })

  it.each(['shell_run', 'process_start'])('rejects an outside-workspace delete edited into %s and accepts a corrected edit', async (toolId) => {
    const database = new FakeDatabase()
    database.granted = false
    const execute = vi.fn(async (_input: any) => ({ code: 0, processId: 'process-1' }))
    const fixture = brokerFixture(database, execute)
    const pending = fixture.broker.handle({
      runId: 'run-1', requestId: 'delete-request', toolCallId: 'delete-call', toolId,
      args: { command: 'rm -rf build' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    expect(approval).toBeDefined()

    expect(() => fixture.broker.respondToApproval({
      requestId: approval.id,
      decision: 'edit',
      editedArguments: { command: 'rm -rf ../sibling' },
    })).toThrow(expect.objectContaining({ code: 'security.destructive-outside-workspace' }))
    expect(execute).not.toHaveBeenCalled()

    expect(database.approvals[0].status).toBe('pending')
    fixture.broker.respondToApproval({
      requestId: approval.id, decision: 'edit', editedArguments: { command: 'rm -rf other-build' },
    })
    await expect(pending).resolves.toMatchObject({ code: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]?.args.command).toBe('rm -rf other-build')
  })

  it('validates initial and approval-edited arguments before policy execution', async () => {
    const database = new FakeDatabase()
    const fixture = brokerFixture(database)
    await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'invalid-initial', toolCallId: 'read-invalid', toolId: 'file_read', args: { path: 42 } as any })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' })
    expect(database.toolRows).toHaveLength(0)

    database.granted = false
    const pending = fixture.broker.handle({ runId: 'run-1', requestId: 'write-request', toolCallId: 'write-approval', toolId: 'file_write', args: { path: 'x.txt', content: 'safe' } })
    const pendingRejection = expect(pending).rejects.toThrow('test cleanup')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    expect(approval).toBeDefined()
    expect(() => fixture.broker.respondToApproval({ requestId: approval.id, decision: 'edit', editedArguments: { path: 'x.txt' } })).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_ARGUMENTS' }))
    expect(database.approvals).toHaveLength(1)
    const receipt = database.toolRows.find((row) => row.provider_call_id === 'write-approval')
    expect(receipt?.state).toBe('waiting_approval')
    expect(database.approvals[0]).toMatchObject({ toolCallId: receipt.id, preview: { toolCallId: 'write-approval' } })
    expect(approval.toolCallId).toBe('write-approval')
    fixture.broker.rejectRunApprovals('run-1', 'test cleanup')
    await pendingRejection
  })

  it('denies a same-risk file edit aimed at a protected credential store', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const executed: any[] = []
    const fixture = brokerFixture(database, async (input) => {
      executed.push(input)
      throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    })
    const pending = fixture.broker.handle({
      runId: 'run-1', requestId: 'write-request', toolCallId: 'write-call', toolId: 'file_write',
      args: { path: 'notes.txt', content: 'safe' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval

    expect(() => fixture.broker.respondToApproval({
      requestId: approval.id, decision: 'edit',
      editedArguments: { path: '.ssh/id_ed25519', content: 'replacement' },
    })).toThrow(expect.objectContaining({ code: 'security.protected-credential-store' }))
    expect(executed.every((input) => input.toolId === 'file.read')).toBe(true)
    fixture.broker.rejectRunApprovals('run-1', 'test cleanup')
    await expect(pending).rejects.toThrow('test cleanup')
  })

  it('rechecks a run restricted to read-only while its write approval is pending', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const executed: any[] = []
    const fixture = brokerFixture(database, async (input) => {
      executed.push(input)
      throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    })
    const pending = fixture.broker.handle({
      runId: 'run-1', requestId: 'write-request', toolCallId: 'write-call', toolId: 'file_write',
      args: { path: 'notes.txt', content: 'safe' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    database.run.readOnly = true

    expect(() => fixture.broker.respondToApproval({
      requestId: approval.id, decision: 'approve', scope: 'once',
    })).toThrow(expect.objectContaining({ code: 'run.readonly-capability' }))
    expect(executed.every((input) => input.toolId === 'file.read')).toBe(true)
    fixture.broker.rejectRunApprovals('run-1', 'test cleanup')
    await expect(pending).rejects.toThrow('test cleanup')
  })

  it('denies an unchanged approval when its MCP tool has since been disabled', async () => {
    const database = new FakeDatabase()
    database.granted = false
    let disabled = false
    const execute = vi.fn(async () => ({}))
    const fixture = brokerFixture(database, execute, {
      blockedReason: () => disabled ? 'MCP 工具已停用' : undefined,
      runtimeServer: async () => ({}),
      disabledTools: () => [],
    })
    const pending = fixture.broker.handle({
      runId: 'run-1', requestId: 'mcp-request', toolCallId: 'mcp-call', toolId: 'mcp_call_tool',
      args: { serverId: 'server-1', toolName: 'lookup', arguments: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    disabled = true

    expect(() => fixture.broker.respondToApproval({
      requestId: approval.id, decision: 'approve', scope: 'once',
    })).toThrow(expect.objectContaining({ code: 'mcp.disabled' }))
    expect(execute).not.toHaveBeenCalled()
    fixture.broker.rejectRunApprovals('run-1', 'test cleanup')
    await expect(pending).rejects.toThrow('test cleanup')
  })

  it('does not let an approval edit increase the command risk', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const execute = vi.fn(async () => ({ code: 0 }))
    const fixture = brokerFixture(database, execute)
    const pending = fixture.broker.handle({
      runId: 'run-1', requestId: 'install-request', toolCallId: 'install-call', toolId: 'shell_run',
      args: { command: 'npm install' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval

    expect(() => fixture.broker.respondToApproval({
      requestId: approval.id, decision: 'edit', editedArguments: { command: 'rm -rf build' },
    })).toThrow(expect.objectContaining({ code: 'APPROVAL_POLICY_CHANGED' }))
    expect(execute).not.toHaveBeenCalled()
    fixture.broker.rejectRunApprovals('run-1', 'test cleanup')
    await expect(pending).rejects.toThrow('test cleanup')
  })

  it('rejects Memory writes when Memory is disabled', async () => {
    const database = new FakeDatabase()
    database.settings.appSettings = { memoryEnabled: false }
    const { broker } = brokerFixture(database)
    await expect(broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'memory-1', toolId: 'memory_propose', args: { scope: 'user', kind: 'stable_fact', content: 'x', confidence: 0.9 } })).rejects.toMatchObject({ code: 'memory.disabled' })
    expect(database.savedMemory).toBeUndefined()
  })

  it('maps Memory types and rejects writes from a persisted read-only run', async () => {
    const database = new FakeDatabase()
    const fixture = brokerFixture(database)
    await fixture.broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'memory-1', toolId: 'memory_propose', args: { scope: 'user', kind: 'knowledge_background', content: 'x', confidence: 0.9 } })
    expect(database.savedMemory.kind).toBe('knowledge_background')

    database.run.readOnly = true
    await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'request-2', toolCallId: 'write-1', toolId: 'file_write', args: { path: 'x.txt', content: 'x' } })).rejects.toMatchObject({ code: 'run.readonly-capability' })
  })

  it('requires approval before search and lets an approved read-only run execute it', async () => {
    const database = new FakeDatabase()
    database.run.readOnly = true
    database.granted = false
    const runnerCalls: any[] = []
    const fixture = brokerFixture(database, async (input) => {
      runnerCalls.push(input)
      return { engine: 'bing-html', query: input.args.query, resultCount: 0, results: [] }
    })

    await expect(fixture.broker.handle({
      runId: 'run-1',
      requestId: 'search-invalid',
      toolCallId: 'search-invalid',
      toolId: 'web_search',
      args: { query: '' },
    })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' })
    expect(database.toolRows).toHaveLength(0)

    const pending = fixture.broker.handle({
      runId: 'run-1',
      requestId: 'search-request',
      toolCallId: 'search-approval',
      toolId: 'web_search',
      args: { query: 'DeskForge', maxResults: 5 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runnerCalls).toHaveLength(0)
    expect(database.toolRows[0]).toMatchObject({ tool_id: 'web_search', state: 'waiting_approval' })
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    expect(approval).toMatchObject({ target: 'DeskForge', sendsData: ['工具参数可能发送到外部系统'] })

    fixture.broker.respondToApproval({ requestId: approval.id, decision: 'approve', scope: 'once' })
    await expect(pending).resolves.toMatchObject({ engine: 'bing-html', query: 'DeskForge' })
    expect(runnerCalls).toHaveLength(1)
    expect(runnerCalls[0]).toMatchObject({ toolId: 'web.search', args: { query: 'DeskForge', maxResults: 5 } })
  })

  it('still asks before an outbound search', async () => {
    const database = new FakeDatabase()
    database.run.readOnly = true
    database.granted = false
    const runnerCalls: any[] = []
    const fixture = brokerFixture(database, async (input) => {
      runnerCalls.push(input)
      return { engine: 'bing-html', query: input.args.query, resultCount: 0, results: [] }
    })

    const pending = fixture.broker.handle({
      runId: 'run-1',
      requestId: 'search-balanced',
      toolCallId: 'search-balanced',
      toolId: 'web_search',
      args: { query: 'DeskForge' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runnerCalls).toHaveLength(0)
    expect(database.approvals).toHaveLength(1)
    fixture.broker.rejectRunApprovals('run-1', 'test cleanup')
    await expect(pending).rejects.toThrow('test cleanup')
  })

  it('treats request-approval as conservative even when the global convenience mode is balanced', async () => {
    const database = new FakeDatabase()
    database.settings.appSettings = { memoryEnabled: true, permissionMode: 'balanced' }
    database.granted = false
    const runnerCalls: any[] = []
    const fixture = brokerFixture(database, async (input) => { runnerCalls.push(input); return {} })

    const pending = fixture.broker.handle({
      runId: 'run-1', requestId: 'write-approval-mode', toolCallId: 'write-approval-mode', toolId: 'file_write',
      args: { path: 'inside.txt', content: 'created' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Only the read-only diff preview may touch the runner before approval.
    expect(runnerCalls.filter((call) => !(call.toolId === 'file.read' && String(call.requestId).endsWith('-preview')))).toHaveLength(0)
    expect(database.approvals).toHaveLength(1)
    fixture.broker.rejectRunApprovals('run-1', 'test cleanup')
    await expect(pending).rejects.toThrow('test cleanup')
  })

  it('keeps ordinary writes inside the workspace and still confirms destructive commands', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const runnerCalls: any[] = []
    const fixture = brokerFixture(database, async (input) => {
      runnerCalls.push(input)
      if (input.toolId === 'file.read') throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return { path: 'notes.txt', before: null, after: 'created', beforeSha256: null, sha256: 'new', created: true }
    })

    const writePending = fixture.broker.handle({
      runId: 'run-1', requestId: 'write-workspace', toolCallId: 'write-workspace', toolId: 'file_write',
      args: { path: 'notes.txt', content: 'created' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runnerCalls.filter((call) => !(call.toolId === 'file.read' && String(call.requestId).endsWith('-preview')))).toHaveLength(0)
    const writeApproval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    fixture.broker.respondToApproval({ requestId: writeApproval.id, decision: 'approve', scope: 'once' })
    await expect(writePending).resolves.toMatchObject({ path: 'notes.txt' })
    expect(runnerCalls.every((call) => call.authorizedRoot === '/workspace' && call.workspacePath === '/workspace')).toBe(true)

    const publishPending = fixture.broker.handle({
      runId: 'run-1', requestId: 'publish-full', toolCallId: 'publish-full', toolId: 'shell_run',
      args: { command: 'git push origin main' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const publishApproval = fixture.events.filter((event) => event.kind === 'approval.requested').at(-1)?.approval
    expect(publishApproval).toMatchObject({ riskLevel: 'high_risk_irreversible' })
    fixture.broker.respondToApproval({ requestId: publishApproval.id, decision: 'reject', scope: 'run_tool' })
    await expect(publishPending).rejects.toThrow('用户拒绝了该操作')

    await expect(fixture.broker.handle({
      runId: 'run-1', requestId: 'macos-hard-deny', toolCallId: 'macos-hard-deny', toolId: 'shell_run',
      args: { command: 'osascript -e \'tell application "Finder" to activate\'' },
    })).rejects.toMatchObject({ code: 'shell.macos-app-automation-denied' })
  })

  it('denies protected credential stores and requires one-shot approval for sensitive files', async () => {
    const database = new FakeDatabase()
    database.granted = true
    const fixture = brokerFixture(database, async () => ({ content: 'TOKEN=redacted', sha256: 'x', mtimeMs: 1 }))

    await expect(fixture.broker.handle({
      runId: 'run-1', requestId: 'ssh-key', toolCallId: 'ssh-key', toolId: 'file_read',
      args: { path: '/Users/chen/.ssh/id_ed25519' },
    })).rejects.toMatchObject({ code: 'security.protected-credential-store' })

    const pending = fixture.broker.handle({
      runId: 'run-1', requestId: 'env-read', toolCallId: 'env-read', toolId: 'file_read',
      args: { path: '/tmp/project/.env' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    expect(approval).toMatchObject({ reason: expect.stringContaining('凭据') })
    fixture.broker.respondToApproval({ requestId: approval.id, decision: 'reject', scope: 'run_tool' })
    await expect(pending).rejects.toThrow('用户拒绝了该操作')
  })

  it('fails closed instead of using the disk root when the run workspace disappeared', async () => {
    const database = new FakeDatabase()
    database.getWorkspace = (() => undefined) as any
    const runnerCalls: any[] = []
    const fixture = brokerFixture(database, async (input) => { runnerCalls.push(input); return {} })

    await expect(fixture.broker.handle({
      runId: 'run-1', requestId: 'missing-workspace', toolCallId: 'missing-workspace', toolId: 'file_read',
      args: { path: 'relative.txt' },
    })).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRED' })
    expect(runnerCalls).toHaveLength(0)
  })

  it('keeps fetched page text out of the persisted tool receipt', async () => {
    const database = new FakeDatabase()
    const fixture = brokerFixture(database, async () => ({
      url: 'https://news.example/article',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      charset: 'utf-8',
      text: 'sensitive untrusted page body',
      truncated: false,
      total: 29,
    }))

    const result = await fixture.broker.handle({
      runId: 'run-1',
      requestId: 'fetch-request',
      toolCallId: 'fetch-1',
      toolId: 'web_fetch',
      args: { url: 'https://news.example/article' },
    }) as any

    expect(result.text).toBe('sensitive untrusted page body')
    const persisted = JSON.parse(database.toolRows[0].result_json)
    expect(persisted).toMatchObject({
      url: 'https://news.example/article',
      status: 200,
      text: '[CONTENT OMITTED: 29 chars]',
    })
    expect(JSON.stringify(persisted)).not.toContain('sensitive untrusted page body')
  })

  it('preserves source metadata but omits previews when a fetched page is offloaded', async () => {
    const database = new FakeDatabase()
    const pageText = `private page content ${'x'.repeat(140 * 1024)}`
    const fixture = brokerFixture(database, async () => ({
      url: 'https://large.example/article',
      status: 200,
      contentType: 'text/html',
      charset: 'utf-8',
      text: pageText,
      truncated: false,
      total: pageText.length,
    }))

    const result = await fixture.broker.handle({
      runId: 'run-1',
      requestId: 'large-fetch-request',
      toolCallId: 'large-fetch-1',
      toolId: 'web_fetch',
      args: { url: 'https://large.example/article' },
    }) as any

    expect(result).toMatchObject({ url: 'https://large.example/article', status: 200, truncated: true })
    expect(result.artifact.kind).toBe('tool_result')
    const persisted = JSON.parse(database.toolRows[0].result_json)
    expect(persisted).toMatchObject({
      url: 'https://large.example/article',
      status: 200,
      text: expect.stringContaining('[CONTENT OMITTED'),
    })
    expect(JSON.stringify(persisted)).not.toContain('private page content')
  })
})

describe('ToolBroker Skill resources', () => {
  it('reads managed text resources and rejects traversal and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskforge-skill-'))
    try {
      const skillPath = join(root, 'skill')
      await mkdir(join(skillPath, 'references'), { recursive: true })
      await mkdir(join(skillPath, 'scripts'), { recursive: true })
      await mkdir(join(skillPath, 'docs'), { recursive: true })
      await mkdir(join(skillPath, '.private'), { recursive: true })
      await writeFile(join(skillPath, 'SKILL.md'), '# Skill\n')
      await writeFile(join(skillPath, 'references', 'guide.md'), 'trusted guide\n')
      await writeFile(join(skillPath, 'scripts', 'check.sh'), '#!/bin/sh\necho checked\n')
      await writeFile(join(skillPath, 'docs', 'usage.md'), 'public docs\n')
      await writeFile(join(skillPath, 'config.json'), '{"apiKey":"must-not-load"}\n')
      await writeFile(join(skillPath, 'scripts', 'credentials.json'), '{"token":"must-not-load"}\n')
      await writeFile(join(skillPath, '.env'), 'TOKEN=must-not-load\n')
      await writeFile(join(skillPath, '.private', 'notes.md'), 'must-not-load\n')
      const outside = join(root, 'outside.md')
      await writeFile(outside, 'outside\n')
      await symlink(outside, join(skillPath, 'references', 'escape.md'))

      const database = new FakeDatabase()
      database.skills.set('skill-1', { id: 'skill-1', name: 'Skill One', path: skillPath, enabled: true, permissions: {} })
      const fixture = brokerFixture(database, async () => { throw new Error('runner must not execute Skill resources') })
      const guide = await fixture.broker.handle({ runId: 'run-1', requestId: 'guide', toolCallId: 'skill-guide', toolId: 'skill_read', args: { skillId: 'skill-1', resource: 'references/guide.md' } }) as any
      const canonicalSkillPath = await realpath(skillPath)
      expect(guide.instructions).toBe('trusted guide\n')
      expect(guide.executionContext).toMatchObject({
        workingDirectory: canonicalSkillPath,
        scriptsDirectory: join(canonicalSkillPath, 'scripts'),
        resourcePath: join(canonicalSkillPath, 'references', 'guide.md'),
        resourceDirectory: join(canonicalSkillPath, 'references'),
      })
      expect(JSON.stringify(guide.executionContext)).not.toContain('must-not-load')
      const script = await fixture.broker.handle({ runId: 'run-1', requestId: 'script', toolCallId: 'skill-script', toolId: 'skill_read', args: { skillId: 'skill-1', resource: 'scripts/check.sh' } }) as any
      expect(script.instructions).toContain('echo checked')
      const docs = await fixture.broker.handle({ runId: 'run-1', requestId: 'docs', toolCallId: 'skill-docs', toolId: 'skill_read', args: { skillId: 'skill-1', resource: 'docs/usage.md' } }) as any
      expect(docs.instructions).toBe('public docs\n')
      await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'traversal', toolCallId: 'skill-traversal', toolId: 'skill_read', args: { skillId: 'skill-1', resource: '../outside.md' } })).rejects.toMatchObject({ code: 'INVALID_SKILL_RESOURCE' })
      await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'symlink', toolCallId: 'skill-symlink', toolId: 'skill_read', args: { skillId: 'skill-1', resource: 'references/escape.md' } })).rejects.toMatchObject({ code: 'SKILL_RESOURCE_SYMLINK' })
      await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'config', toolCallId: 'skill-config', toolId: 'skill_read', args: { skillId: 'skill-1', resource: 'config.json' } })).rejects.toMatchObject({ code: 'PRIVATE_SKILL_RESOURCE' })
      await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'credentials', toolCallId: 'skill-credentials', toolId: 'skill_read', args: { skillId: 'skill-1', resource: 'scripts/credentials.json' } })).rejects.toMatchObject({ code: 'PRIVATE_SKILL_RESOURCE' })
      await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'env', toolCallId: 'skill-env', toolId: 'skill_read', args: { skillId: 'skill-1', resource: '.env' } })).rejects.toMatchObject({ code: 'PRIVATE_SKILL_RESOURCE' })
      await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'hidden', toolCallId: 'skill-hidden', toolId: 'skill_read', args: { skillId: 'skill-1', resource: '.private/notes.md' } })).rejects.toMatchObject({ code: 'PRIVATE_SKILL_RESOURCE' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('M2 approval experience', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const lastApproval = (events: any[]) => events.filter((event) => event.kind === 'approval.requested').at(-1)?.approval

  it('attaches a unified diff to file approvals: new files are all additions, edits show hunks', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const files: Record<string, string> = { 'src/app.ts': 'const a = 1\nconst b = 2\nconst c = 3\n' }
    const fixture = brokerFixture(database, async (input) => {
      if (input.toolId === 'file.read') {
        const content = files[input.args.path]
        if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return { path: input.args.path, content, sha256: 'a'.repeat(64) }
      }
      return { path: input.args.path, before: files[input.args.path] ?? null, after: input.args.content ?? 'x', sha256: 'b'.repeat(64), created: !(input.args.path in files) }
    })

    const create = fixture.broker.handle({ runId: 'run-1', requestId: 'r1', toolCallId: 'c1', toolId: 'file_write', args: { path: 'notes/new.md', content: '# 标题\n正文\n' } })
    await tick()
    const createApproval = lastApproval(fixture.events)
    expect(createApproval.diff).toMatchObject({ kind: 'file_diff', operation: 'create', additions: 2, deletions: 0, truncated: false })
    expect(createApproval.diff.text).toContain('--- /dev/null')
    expect(createApproval.diff.hunks[0].lines.every((line: any) => line.kind === 'add')).toBe(true)
    expect(database.approvals.at(-1).preview.diff.additions).toBe(2)
    fixture.broker.respondToApproval({ requestId: createApproval.id, decision: 'reject' })
    await expect(create).rejects.toThrow()

    const edit = fixture.broker.handle({ runId: 'run-1', requestId: 'r2', toolCallId: 'c2', toolId: 'file_replace', args: { path: 'src/app.ts', oldText: 'const b = 2', newText: 'const b = 20', expectedSha256: 'a'.repeat(64) } })
    await tick()
    const editApproval = lastApproval(fixture.events)
    expect(editApproval.diff).toMatchObject({ operation: 'modify', additions: 1, deletions: 1 })
    expect(editApproval.diff.text).toContain('-const b = 2\n+const b = 20')
    fixture.broker.respondToApproval({ requestId: editApproval.id, decision: 'reject' })
    await expect(edit).rejects.toThrow()

    const big = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join('\n')
    const large = fixture.broker.handle({ runId: 'run-1', requestId: 'r3', toolCallId: 'c3', toolId: 'file_write', args: { path: 'big.txt', content: big } })
    await tick()
    const largeApproval = lastApproval(fixture.events)
    expect(largeApproval.diff).toMatchObject({ truncated: true, additions: 2_000 })
    expect(largeApproval.diff.note).toContain('已截断')
    fixture.broker.respondToApproval({ requestId: largeApproval.id, decision: 'reject' })
    await expect(large).rejects.toThrow()
  })

  it('hides sensitive file contents in the preview but keeps the change counts', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const fixture = brokerFixture(database, async (input) => {
      if (input.toolId === 'file.read') return { path: '.env', content: 'TOKEN=old\n', sha256: 'a'.repeat(64) }
      return {}
    })
    const pending = fixture.broker.handle({ runId: 'run-1', requestId: 'env', toolCallId: 'env', toolId: 'file_write', args: { path: '.env', content: 'TOKEN=new\n', expectedSha256: 'a'.repeat(64) } })
    await tick()
    const approval = lastApproval(fixture.events)
    expect(approval.diff).toMatchObject({ additions: 1, deletions: 1, hunks: [], text: '' })
    expect(approval.sessionRule).toMatchObject({ eligible: false })
    fixture.broker.rejectRunApprovals('run-1', 'cleanup')
    await expect(pending).rejects.toThrow('cleanup')
  })

  it('「本会话总是允许此类操作」 auto-approves the same tool + risk and audits the matched rule', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const mutations: any[] = []
    const fixture = brokerFixture(database, async (input) => {
      if (input.toolId === 'file.read') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      mutations.push(input)
      return { path: input.args.path, before: null, after: input.args.content, sha256: 'c'.repeat(64), created: true }
    })
    const first = fixture.broker.handle({ runId: 'run-1', requestId: 'w1', toolCallId: 'w1', toolId: 'file_write', args: { path: 'a.md', content: 'a' } })
    await tick()
    const approval = lastApproval(fixture.events)
    expect(approval.sessionRule).toMatchObject({ eligible: true, label: '「写入文件」（可撤销的本地写入）' })
    fixture.broker.respondToApproval({ requestId: approval.id, decision: 'approve', scope: 'session' })
    await first
    expect(database.sessionRules).toHaveLength(1)
    expect(database.auditEntries.find((entry) => entry.category === 'approval' && entry.payload.outcome === 'approved')?.payload).toMatchObject({ scope: 'session', sessionRule: { id: 'rule-1', created: true } })

    const approvalsBefore = database.approvals.length
    await fixture.broker.handle({ runId: 'run-1', requestId: 'w2', toolCallId: 'w2', toolId: 'file_write', args: { path: 'b.md', content: 'b' } })
    expect(database.approvals).toHaveLength(approvalsBefore)
    expect(mutations).toHaveLength(2)
    const auto = database.auditEntries.find((entry) => entry.payload.outcome === 'auto_approved')
    expect(auto).toMatchObject({ category: 'approval', action: 'file_write', runId: 'run-1', payload: { riskLevel: 'reversible_write', sessionRule: { id: 'rule-1', kind: 'tool' } } })
    expect(database.sessionRules[0].use_count).toBe(1)
    expect(database.events.some((event) => event.type === 'approval.auto_approved')).toBe(true)

    // Another run never inherits the rule.
    database.run.id = 'run-2'
    const otherRun = fixture.broker.handle({ runId: 'run-2', requestId: 'w3', toolCallId: 'w3', toolId: 'file_write', args: { path: 'c.md', content: 'c' } })
    await tick()
    expect(database.approvals.length).toBe(approvalsBefore + 1)
    fixture.broker.rejectRunApprovals('run-2', 'cleanup')
    await expect(otherRun).rejects.toThrow('cleanup')
    database.run.id = 'run-1'

    // Revoked rules stop matching immediately.
    fixture.broker.revokeSessionRule('rule-1')
    expect(database.auditEntries.some((entry) => entry.action === 'session_rule_revoked')).toBe(true)
    const afterRevoke = fixture.broker.handle({ runId: 'run-1', requestId: 'w4', toolCallId: 'w4', toolId: 'file_write', args: { path: 'd.md', content: 'd' } })
    await tick()
    expect(database.approvals.length).toBe(approvalsBefore + 2)
    fixture.broker.rejectRunApprovals('run-1', 'cleanup')
    await expect(afterRevoke).rejects.toThrow('cleanup')
    expect(() => fixture.broker.revokeSessionRule('rule-1')).toThrow('会话规则不存在或已撤销')
  })

  it('never turns high-risk or destructive approvals into session rules', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const fixture = brokerFixture(database, async (input) => {
      if (input.toolId === 'file.read') return { path: input.args.path, content: 'keep\n', sha256: 'a'.repeat(64) }
      return { trashed: true }
    })
    const del = fixture.broker.handle({ runId: 'run-1', requestId: 'd1', toolCallId: 'd1', toolId: 'file_delete', args: { path: 'old.txt' } })
    await tick()
    const delApproval = lastApproval(fixture.events)
    expect(delApproval).toMatchObject({ riskLevel: 'high_risk_irreversible', sessionRule: { eligible: false } })
    expect(delApproval.diff).toMatchObject({ operation: 'delete', deletions: 1, additions: 0 })
    // A forged/buggy UI asking for a session rule still gets a one-shot approval.
    fixture.broker.respondToApproval({ requestId: delApproval.id, decision: 'approve', scope: 'session' })
    await del
    expect(database.sessionRules).toHaveLength(0)

    const del2 = fixture.broker.handle({ runId: 'run-1', requestId: 'd2', toolCallId: 'd2', toolId: 'file_delete', args: { path: 'old2.txt' } })
    await tick()
    expect(database.approvals).toHaveLength(2)
    fixture.broker.rejectRunApprovals('run-1', 'cleanup')
    await expect(del2).rejects.toThrow('cleanup')

    const shellRm = fixture.broker.handle({ runId: 'run-1', requestId: 's1', toolCallId: 's1', toolId: 'shell_run', args: { command: 'rm -rf build' } })
    await tick()
    expect(lastApproval(fixture.events)).toMatchObject({ riskLevel: 'high_risk_irreversible', sessionRule: { eligible: false } })
    fixture.broker.rejectRunApprovals('run-1', 'cleanup')
    await expect(shellRm).rejects.toThrow('cleanup')
  })

  it('scopes shell session rules to the command prefix and blocks rm -rf outside the workspace outright', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const commands: string[] = []
    const fixture = brokerFixture(database, async (input) => { commands.push(String(input.args.command)); return { code: 0, stdout: '' } })
    const first = fixture.broker.handle({ runId: 'run-1', requestId: 'n1', toolCallId: 'n1', toolId: 'shell_run', args: { command: 'npm test -- --run' } })
    await tick()
    const approval = lastApproval(fixture.events)
    expect(approval.sessionRule).toMatchObject({ eligible: true, label: '以「npm test」开头的命令' })
    fixture.broker.respondToApproval({ requestId: approval.id, decision: 'approve', scope: 'session' })
    await first
    await fixture.broker.handle({ runId: 'run-1', requestId: 'n2', toolCallId: 'n2', toolId: 'shell_run', args: { command: 'npm test src/a.test.ts' } })
    expect(commands).toEqual(['npm test -- --run', 'npm test src/a.test.ts'])

    const different = fixture.broker.handle({ runId: 'run-1', requestId: 'n3', toolCallId: 'n3', toolId: 'shell_run', args: { command: 'npm install left-pad' } })
    await tick()
    expect(database.approvals).toHaveLength(2)
    fixture.broker.rejectRunApprovals('run-1', 'cleanup')
    await expect(different).rejects.toThrow('cleanup')

    const chained = fixture.broker.handle({ runId: 'run-1', requestId: 'n4', toolCallId: 'n4', toolId: 'shell_run', args: { command: 'npm test && npm publish' } })
    await tick()
    expect(database.approvals).toHaveLength(3)
    fixture.broker.rejectRunApprovals('run-1', 'cleanup')
    await expect(chained).rejects.toThrow('cleanup')

    for (const command of ['rm -rf ~', 'rm -rf /', 'rm -rf ../sibling', 'sudo rm -rf /etc']) {
      await expect(fixture.broker.handle({ runId: 'run-1', requestId: `x-${command}`, toolCallId: `x-${command}`, toolId: 'shell_run', args: { command } })).rejects.toMatchObject({ code: 'security.destructive-outside-workspace' })
    }
    expect(database.approvals).toHaveLength(3)
  })

  it('runs file_find and file_search as read-only tools without approval', async () => {
    const database = new FakeDatabase()
    database.granted = false
    const calls: any[] = []
    const fixture = brokerFixture(database, async (input) => { calls.push(input); return { matches: [], matchCount: 0 } })
    await fixture.broker.handle({ runId: 'run-1', requestId: 'f1', toolCallId: 'f1', toolId: 'file_find', args: { pattern: '*.ts' } })
    await fixture.broker.handle({ runId: 'run-1', requestId: 'f2', toolCallId: 'f2', toolId: 'file_search', args: { query: 'TODO', glob: '*.md', regex: false } })
    expect(calls.map((call) => call.toolId)).toEqual(['file.find', 'file.search'])
    expect(database.approvals).toHaveLength(0)
    await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'f3', toolCallId: 'f3', toolId: 'file_find', args: { pattern: '*.ts', extra: true } })).rejects.toThrow()
  })
})

describe('knowledge_search tool (M4)', () => {
  it('runs without approval, scopes to the run workspace and returns citations with line ranges', async () => {
    const database = new FakeDatabase()
    const calls: any[] = []
    const knowledge = {
      search: async (workspaceId: string, query: string, options: any) => {
        calls.push({ workspaceId, query, options })
        return { query, state: 'ready' as const, mode: 'keyword' as const, fileCount: 2, results: [{ path: 'docs/周报.md', startLine: 3, endLine: 4, chunkStartLine: 1, chunkEndLine: 4, snippet: '下周计划：回滚演练', score: 0.016, matchedBy: 'keyword' as const }] }
      },
    }
    const events: any[] = []
    const broker = new ToolBroker(database as any, { execute: async () => { throw new Error('runner must not be used') } } as any, {} as any, {} as any, {} as any, (event) => events.push(event), async () => ({}), undefined, undefined, undefined, knowledge)
    const result = await broker.handle({ runId: 'run-1', requestId: 'kb-1', toolCallId: 'kb-call-1', toolId: 'knowledge_search', args: { query: '  回滚演练 ', limit: 5, pathPrefix: 'docs/' } }) as any
    expect(database.approvals).toHaveLength(0)
    expect(calls).toEqual([{ workspaceId: 'workspace-1', query: '回滚演练', options: { limit: 5, pathPrefix: 'docs/' } }])
    expect(result.results[0]).toMatchObject({ path: 'docs/周报.md', startLine: 3, endLine: 4, citation: 'docs/周报.md:3-4' })
    expect(result.trust).toContain('不可信')
    expect(database.toolRows.find((row) => row.tool_id === 'knowledge_search')).toMatchObject({ state: 'succeeded' })
  })

  it('fails clearly when the query is empty or the knowledge service is missing', async () => {
    const database = new FakeDatabase()
    const broker = new ToolBroker(database as any, { execute: async () => ({}) } as any, {} as any, {} as any, {} as any, () => undefined, async () => ({}))
    await expect(broker.handle({ runId: 'run-1', requestId: 'kb-2', toolCallId: 'kb-call-2', toolId: 'knowledge_search', args: { query: 'x' } })).rejects.toMatchObject({ code: 'KNOWLEDGE_UNAVAILABLE' })
    expect(database.approvals).toHaveLength(0)
  })
})
