import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { callMcpTool, closeAllMcp, disconnectMcp, listMcpTools } from '../workers/mcp-client'
import { AppDatabase } from './database'
import { McpService } from './mcp-service'
import { ToolBroker } from './tool-broker'

const MOCK_SERVER = fileURLToPath(new URL('./test-fixtures/mock-mcp-server.mjs', import.meta.url))
const SECRET = 'mock-secret-value'

/** Reversible stand-in for Electron safeStorage; the ciphertext never contains the plaintext. */
const cipher = {
  encrypt: async (value: string) => Buffer.from(`enc:${Buffer.from(value, 'utf8').toString('base64').split('').reverse().join('')}`),
  decrypt: async (value: Buffer) => Buffer.from(value.toString('utf8').slice(4).split('').reverse().join(''), 'base64').toString('utf8'),
}

/** Routes MCP runner commands to the real worker-side client, as the tool-runner process does. */
function realMcpRunner(log: any[]) {
  return {
    execute: async (command: any) => {
      log.push({ toolId: command.toolId, args: command.args })
      if (command.toolId === 'mcp.list_tools') return listMcpTools(command.mcpServer)
      if (command.toolId === 'mcp.call_tool') return callMcpTool(command.mcpServer, String(command.args.toolName), command.args.arguments ?? {})
      if (command.toolId === 'mcp.disconnect') return { disconnected: await disconnectMcp(String(command.args.serverId)) }
      throw new Error(`unexpected runner tool ${command.toolId}`)
    },
  }
}

describe('MCP end to end with a mock stdio server', () => {
  let root: string
  let workspaceRoot: string
  let database: AppDatabase
  let service: McpService
  let runnerLog: any[]
  const parentToken = process.env.PARENT_API_TOKEN

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'deskforge-mcp-e2e-'))
    workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    database = new AppDatabase(join(root, 'state.sqlite3'))
    runnerLog = []
    service = new McpService(database, cipher, realMcpRunner(runnerLog), { isolatedRoot: join(root, 'mcp-servers') })
    process.env.PARENT_API_TOKEN = 'parent-secret'
  })

  afterEach(async () => {
    await closeAllMcp()
    database.close()
    await rm(root, { recursive: true, force: true })
    if (parentToken === undefined) delete process.env.PARENT_API_TOKEN
    else process.env.PARENT_API_TOKEN = parentToken
  })

  afterAll(async () => { await closeAllMcp() })

  async function addMockServer(cwdMode: 'workspace' | 'isolated' = 'workspace') {
    return service.save({
      name: 'Mock 工具箱',
      enabled: true,
      toolNamespace: 'mock',
      transport: { type: 'stdio', command: process.execPath, args: [MOCK_SERVER], env: { MOCK_MODE: 'demo' }, envKeys: ['MOCK_TOKEN'], cwdMode },
      secrets: { env: { MOCK_TOKEN: SECRET } },
    })
  }

  it('stores the env secret encrypted, tests the connection and lists discovered tools', async () => {
    const saved = await addMockServer('isolated')
    const row = database.db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(saved.id) as any
    expect(row.config_json).not.toContain(SECRET)
    expect(Buffer.from(row.encrypted_secret).toString('utf8')).not.toContain(SECRET)
    expect(JSON.stringify(saved)).not.toContain(SECRET)
    expect(saved.transport).toMatchObject({ type: 'stdio', envKeys: ['MOCK_TOKEN'], env: { MOCK_MODE: 'demo' }, cwdMode: 'isolated' })

    const result = await service.test(saved.id)
    expect(result).toMatchObject({ ok: true, serverVersion: '1.2.3', toolCount: 3, connectedVia: 'stdio' })
    expect(result.tools?.map((tool) => tool.name)).toEqual(['echo', 'whoami', 'delete_everything'])
    expect(result.tools?.[2]).toMatchObject({ destructiveHint: true, enabled: true })

    const listed = service.get(saved.id)
    expect(listed).toMatchObject({ health: 'healthy', connectedVia: 'stdio' })
    expect(listed.tools).toHaveLength(3)
    const disabled = service.setToolEnabled(saved.id, 'delete_everything', false)
    expect(disabled.disabledTools).toEqual(['delete_everything'])
    expect(disabled.tools?.find((tool) => tool.name === 'delete_everything')?.enabled).toBe(false)

    const audit = JSON.stringify(database.db.prepare('SELECT * FROM audit_events').all())
    expect(audit).toContain('MOCK_TOKEN')
    expect(audit).not.toContain(SECRET)

    // Editing without resubmitting the secret keeps the stored value.
    await service.save({ id: saved.id, name: 'Mock 工具箱', enabled: true, toolNamespace: 'mock', transport: { type: 'stdio', command: process.execPath, args: [MOCK_SERVER], env: { MOCK_MODE: 'demo' }, envKeys: ['MOCK_TOKEN'], cwdMode: 'isolated' }, secrets: { env: { MOCK_TOKEN: '' } } })
    expect(JSON.parse(await cipher.decrypt(Buffer.from((database.db.prepare('SELECT encrypted_secret FROM mcp_servers WHERE id=?').get(saved.id) as any).encrypted_secret)))).toEqual({ env: { MOCK_TOKEN: SECRET } })
    expect(service.get(saved.id).disabledTools).toEqual(['delete_everything'])
  }, 30_000)

  it('reports a failing server without leaking its secret', async () => {
    const saved = await service.save({
      name: '坏掉的服务', enabled: true, toolNamespace: 'broken',
      transport: { type: 'stdio', command: process.execPath, args: ['-e', `process.stderr.write('token is ' + process.env.MOCK_TOKEN); process.exit(3)`], envKeys: ['MOCK_TOKEN'] },
      secrets: { env: { MOCK_TOKEN: SECRET } },
    })
    const result = await service.test(saved.id)
    expect(result.ok).toBe(false)
    expect(result.error?.message).not.toContain(SECRET)
    expect(service.get(saved.id)).toMatchObject({ health: 'unhealthy' })
    expect(JSON.stringify(service.get(saved.id))).not.toContain(SECRET)
    expect(JSON.stringify(database.db.prepare('SELECT * FROM audit_events').all())).not.toContain(SECRET)
  }, 30_000)

  it('lists tools freely but runs every MCP call through approval, never via session rules', async () => {
    const saved = await addMockServer('workspace')
    await service.test(saved.id, { workspaceRoot })
    service.setToolEnabled(saved.id, 'delete_everything', false)
    const workspaceId = database.addWorkspace(workspaceRoot, 'workspace')
    const run = database.createRun({ title: 'MCP 测试', prompt: '调用 mock', workspaceId })
    database.transitionRun(run.id, 'running')

    const events: any[] = []
    const artifacts = { putText: async (input: any) => ({ id: `artifact-${events.length}`, ...input }), putBuffer: async (input: any) => ({ id: 'b', ...input }), read: async () => Buffer.from('') }
    const broker = new ToolBroker(database, realMcpRunner(runnerLog) as any, artifacts as any, {} as any, cipher as any, (event) => events.push(event), async () => ({}), undefined, undefined, service)
    const call = (toolId: string, args: Record<string, unknown>, id: string) => broker.handle({ runId: run.id, requestId: `request-${id}`, toolCallId: `call-${id}`, toolId, args })
    const nextApproval = async (count: number) => {
      await vi.waitFor(() => expect(events.filter((event) => event.kind === 'approval.requested')).toHaveLength(count), { timeout: 10_000 })
      return events.filter((event) => event.kind === 'approval.requested')[count - 1].approval
    }

    // Discovery is read-only and auto-runs; disabled tools are hidden from the Agent.
    const listed = await call('mcp_list_tools', { serverId: saved.id }, 'list') as any
    expect(listed.tools.map((tool: any) => tool.name)).toEqual(['echo', 'whoami'])
    expect(events.filter((event) => event.kind === 'approval.requested')).toHaveLength(0)

    // A call waits for the user even though the server labels the tool read-only.
    const before = runnerLog.filter((entry) => entry.toolId === 'mcp.call_tool').length
    const pendingEcho = call('mcp_call_tool', { serverId: saved.id, toolName: 'echo', arguments: { text: '你好' } }, 'echo-1')
    const first = await nextApproval(1)
    expect(first).toMatchObject({ riskLevel: 'external_side_effect', target: 'Mock 工具箱 · echo', sessionRule: { eligible: false } })
    expect(runnerLog.filter((entry) => entry.toolId === 'mcp.call_tool')).toHaveLength(before)
    // Asking for a session rule is downgraded to a one-time approval.
    broker.respondToApproval({ requestId: first.id, decision: 'approve', scope: 'session' })
    expect(JSON.stringify(await pendingEcho)).toContain('echo:你好')
    expect(database.listSessionRules(run.id)).toEqual([])

    // The same call asks again: no run grant and no session rule were created.
    const pendingWhoami = call('mcp_call_tool', { serverId: saved.id, toolName: 'whoami', arguments: {} }, 'whoami')
    const second = await nextApproval(2)
    broker.respondToApproval({ requestId: second.id, decision: 'approve', scope: 'run_tool' })
    const whoami = JSON.parse(((await pendingWhoami) as any).content[0].text)
    expect(whoami).toEqual({ cwd: await realpath(workspaceRoot), secretInjected: true, plain: 'demo', parentSecretVisible: false })

    const pendingAgain = call('mcp_call_tool', { serverId: saved.id, toolName: 'echo', arguments: { text: '你好' } }, 'echo-2')
    const third = await nextApproval(3)
    broker.respondToApproval({ requestId: third.id, decision: 'reject' })
    await expect(pendingAgain).rejects.toThrow()

    // Disabled tools and servers are refused before any approval card.
    await expect(call('mcp_call_tool', { serverId: saved.id, toolName: 'delete_everything', arguments: {} }, 'delete')).rejects.toMatchObject({ code: 'mcp.disabled' })
    await service.setEnabled(saved.id, false)
    await expect(call('mcp_list_tools', { serverId: saved.id }, 'list-disabled')).rejects.toThrow('已停用')
    expect(events.filter((event) => event.kind === 'approval.requested')).toHaveLength(3)

    const approvals = (database.db.prepare("SELECT payload_json FROM audit_events WHERE category='approval'").all() as any[]).map((row) => JSON.parse(row.payload_json))
    expect(approvals.some((payload) => payload.outcome === 'auto_approved')).toBe(false)
  }, 60_000)
})
