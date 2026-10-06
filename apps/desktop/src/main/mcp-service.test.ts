import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AppDatabase } from './database'
import { McpService, summarizeMcpTools } from './mcp-service'

const cipher = {
  encrypt: async (value: string) => Buffer.from(`enc:${Buffer.from(value, 'utf8').toString('base64').split('').reverse().join('')}`),
  decrypt: async (value: Buffer) => Buffer.from(value.toString('utf8').slice(4).split('').reverse().join(''), 'base64').toString('utf8'),
}

describe('McpService', () => {
  let root: string
  let database: AppDatabase
  let runnerCalls: any[]
  let runnerResult: any
  let service: McpService

  const stdio = (extra: Record<string, unknown> = {}) => ({ type: 'stdio' as const, command: 'node', args: ['server.js'], envKeys: [] as string[], ...extra })
  const storedSecret = async (id: string) => {
    const row = database.db.prepare('SELECT encrypted_secret, config_json FROM mcp_servers WHERE id=?').get(id) as any
    return { config: row.config_json as string, secret: row.encrypted_secret ? JSON.parse(await cipher.decrypt(Buffer.from(row.encrypted_secret))) : null, raw: row.encrypted_secret ? Buffer.from(row.encrypted_secret).toString('utf8') : '' }
  }
  const auditText = () => JSON.stringify(database.db.prepare('SELECT * FROM audit_events').all())

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'deskforge-mcp-service-')))
    database = new AppDatabase(join(root, 'state.sqlite3'))
    runnerCalls = []
    runnerResult = { tools: [] }
    service = new McpService(database, cipher, { execute: async (command: any) => { runnerCalls.push(command); return runnerResult } }, { isolatedRoot: join(root, 'isolated') })
  })

  afterEach(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })

  it('encrypts HTTP header and bearer secrets and keeps only names in config, presenter and audit', async () => {
    const saved = await service.save({
      name: '远程知识库', enabled: true, toolNamespace: 'kb',
      transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp', auth: 'bearer', headers: { 'X-Team': 'office' }, secretHeaderKeys: ['X-Api-Key'], sseFallback: true },
      secrets: { headers: { 'X-Api-Key': 'header-secret-1' }, bearer: 'bearer-secret-2' },
    })
    const stored = await storedSecret(saved.id)
    expect(stored.secret).toEqual({ headers: { 'x-api-key': 'header-secret-1' }, bearer: 'bearer-secret-2' })
    for (const text of [stored.config, stored.raw, JSON.stringify(saved), auditText()]) {
      expect(text).not.toContain('header-secret-1')
      expect(text).not.toContain('bearer-secret-2')
    }
    expect(saved.transport).toMatchObject({ type: 'streamable_http', headers: { 'x-team': 'office' }, secretHeaderKeys: ['x-api-key'], sseFallback: true, secretConfigured: true })
    expect(auditText()).toContain('x-api-key')

    // The runtime view decrypts for the worker only.
    const runtime = await service.runtimeServer(saved.id)
    expect(runtime.secrets).toEqual({ headers: { 'x-api-key': 'header-secret-1' }, bearer: 'bearer-secret-2' })

    // Switching auth off and dropping secret headers clears the encrypted blob.
    const cleared = await service.save({ id: saved.id, name: '远程知识库', enabled: true, toolNamespace: 'kb', transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp', auth: 'none' } })
    expect((await storedSecret(saved.id)).secret).toBeNull()
    expect(cleared.transport).toMatchObject({ secretConfigured: false })
  })

  it('rejects secrets typed into plain fields and undeclared or missing secret values', async () => {
    await expect(service.save({ name: 'x', enabled: true, toolNamespace: 'x', transport: stdio({ env: { OPENAI_API_KEY: 'sk-live' } }) })).rejects.toThrow('加密保存')
    await expect(service.save({ name: 'x', enabled: true, toolNamespace: 'x', transport: stdio({ envKeys: ['MY_TOKEN'] }) })).rejects.toThrow('MY_TOKEN')
    await expect(service.save({ name: 'x', enabled: true, toolNamespace: 'x', transport: stdio({ env: { NODE_OPTIONS: '--require x' } }) })).rejects.toThrow('不允许')
    await expect(service.save({ name: 'x', enabled: true, toolNamespace: 'x', transport: { type: 'streamable_http', url: 'http://mcp.example.com/mcp', auth: 'none' } })).rejects.toThrow('HTTPS')
    expect(database.listMcpServers()).toHaveLength(0)
  })

  it('keeps, replaces and removes individual env secrets on edit', async () => {
    const saved = await service.save({ name: 'gh', enabled: true, toolNamespace: 'gh', transport: stdio({ envKeys: ['GH_TOKEN', 'OTHER_SECRET'] }), secrets: { env: { GH_TOKEN: 'one', OTHER_SECRET: 'two' } } })
    await service.save({ id: saved.id, name: 'gh', enabled: true, toolNamespace: 'gh', transport: stdio({ envKeys: ['GH_TOKEN', 'OTHER_SECRET'] }), secrets: { env: { GH_TOKEN: '', OTHER_SECRET: 'three' } } })
    expect((await storedSecret(saved.id)).secret).toEqual({ env: { GH_TOKEN: 'one', OTHER_SECRET: 'three' } })
    await service.save({ id: saved.id, name: 'gh', enabled: true, toolNamespace: 'gh', transport: stdio({ envKeys: ['GH_TOKEN'] }) })
    expect((await storedSecret(saved.id)).secret).toEqual({ env: { GH_TOKEN: 'one' } })
    await service.save({ id: saved.id, name: 'gh', enabled: true, toolNamespace: 'gh', transport: stdio() })
    expect((await storedSecret(saved.id)).secret).toBeNull()
    // Saving drops the cached connection so the worker restarts with new settings.
    expect(runnerCalls.filter((call) => call.toolId === 'mcp.disconnect')).toHaveLength(4)
  })

  it('constrains custom working directories to dialog choices or workspaces', async () => {
    const outside = join(root, 'outside'); const workspace = join(root, 'ws'); const nested = join(workspace, 'tools')
    await mkdir(outside); await mkdir(nested, { recursive: true })
    database.addWorkspace(workspace, 'ws')
    const save = (cwd: string, id?: string) => service.save({ ...(id ? { id } : {}), name: 'cwd', enabled: true, toolNamespace: 'cwd', transport: stdio({ cwdMode: 'custom', cwd }) })

    await expect(save(outside)).rejects.toThrow('选择文件夹')
    await expect(save('/')).rejects.toThrow('根目录或个人主目录')
    await expect(save(homedir())).rejects.toThrow('根目录或个人主目录')
    await expect(save(join(root, 'missing'))).rejects.toThrow('不存在')

    const inWorkspace = await save(nested)
    expect(inWorkspace.transport).toMatchObject({ cwdMode: 'custom', cwd: nested })
    await service.rememberChosenCwd(outside)
    const chosen = await save(outside)
    expect((await service.runtimeServer(chosen.id)).config.cwd).toBe(outside)

    // An unchanged custom cwd survives restarts (fresh service, no dialog memory).
    const restarted = new McpService(database, cipher, { execute: async () => ({}) }, { isolatedRoot: join(root, 'isolated') })
    await expect(restarted.save({ id: chosen.id, name: 'cwd 2', enabled: true, toolNamespace: 'cwd', transport: stdio({ cwdMode: 'custom', cwd: outside }) })).resolves.toMatchObject({ name: 'cwd 2' })

    // Replacing the directory with a symlink is caught at launch.
    await rename(outside, `${outside}-real`)
    await symlink(`${outside}-real`, outside)
    await expect(service.runtimeServer(chosen.id)).rejects.toThrow('重新选择')
  })

  it('resolves isolated and workspace working directories at runtime', async () => {
    const isolated = await service.save({ name: 'iso', enabled: true, toolNamespace: 'iso', transport: stdio() })
    expect(isolated.transport).toMatchObject({ cwdMode: 'isolated' })
    expect((await service.runtimeServer(isolated.id)).config.cwd).toBe(join(root, 'isolated', isolated.id))

    const ws = await service.save({ name: 'ws', enabled: true, toolNamespace: 'ws', transport: stdio({ cwdMode: 'workspace' }) })
    await expect(service.runtimeServer(ws.id)).rejects.toThrow('没有可用的工作区')
    expect((await service.runtimeServer(ws.id, { workspaceRoot: root })).config.cwd).toBe(root)
  })

  it('records discovered tools, honours per-tool switches and builds the run catalog', async () => {
    runnerResult = { tools: [{ name: 'search', description: '搜索', annotations: { readOnlyHint: true } }, { name: 'write' }], serverVersion: { version: '0.9.0' }, connectedVia: 'streamable_http' }
    const saved = await service.save({ name: '搜索', enabled: true, toolNamespace: 'search', transport: { type: 'streamable_http', url: 'http://127.0.0.1:9/mcp', auth: 'none' } })
    const result = await service.test(saved.id)
    expect(result).toMatchObject({ ok: true, toolCount: 2, serverVersion: '0.9.0', connectedVia: 'streamable_http' })
    service.setToolEnabled(saved.id, 'write', false)
    expect(service.catalog()).toEqual([{ id: saved.id, name: '搜索', toolNamespace: 'search', transport: 'http', tools: ['search'] }])
    expect(service.blockedReason(saved.id, 'write')).toContain('已在设置中停用')
    expect(service.blockedReason(saved.id, 'search')).toBeUndefined()
    expect(service.blockedReason('missing')).toContain('不存在')
    await service.setEnabled(saved.id, false)
    expect(service.catalog()).toEqual([])
    expect(service.blockedReason(saved.id, 'search')).toContain('已停用')
    await service.remove(saved.id)
    expect(service.list()).toEqual([])
    expect(auditText()).toContain('server_removed')
  })

  it('summarizes tool metadata defensively', () => {
    const tools = summarizeMcpTools([{ name: 'a', title: 'A', description: 'x'.repeat(5_000), annotations: { destructiveHint: true } }, { nope: true }, { name: 'b' }], ['b'])
    expect(tools.map((tool) => [tool.name, tool.enabled])).toEqual([['a', true], ['b', false]])
    expect(tools[0]!.description!.length).toBeLessThanOrEqual(1_000)
    expect(tools[0]).toMatchObject({ destructiveHint: true })
  })

  it('marks capability package installs as system-originated', async () => {
    await service.save({ name: '包内服务', enabled: false, toolNamespace: 'pkg', transport: stdio() }, 'capability_package')
    const event = database.db.prepare("SELECT payload_json FROM audit_events WHERE action='server_added'").get() as any
    expect(JSON.parse(event.payload_json)).toMatchObject({ actor: 'system', origin: 'capability_package' })
  })
})
