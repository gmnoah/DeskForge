import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { McpConnectionTest, McpSecretInput, McpServerConfig, McpServerInput, McpToolSummary } from '@deskforge/contracts'
import { mcpSecretValues, mergeMcpSecrets, normalizeMcpServerInput, redactSecrets, scrubSecretValues, type NormalizedMcpConfig } from '@deskforge/core'

import type { AppDatabase } from './database'
import { presentMcp } from './presenters'

export interface McpSecretCipher {
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

export interface McpRunner {
  execute(command: Record<string, unknown>): Promise<any>
}

export interface McpServiceOptions {
  /** Parent of the per-server empty working directories used by `isolated` mode. */
  isolatedRoot: string
  refreshOAuth?: (serverId: string, serverUrl: string) => Promise<void>
}

export interface McpRuntimeContext {
  /** Root of the workspace the calling run belongs to. */
  workspaceRoot?: string
}

export interface McpCatalogEntry {
  id: string
  name: string
  toolNamespace: string
  transport: 'stdio' | 'http'
  tools: string[]
}

const within = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Projects SDK tool descriptors to the summary shown in settings. */
export function summarizeMcpTools(tools: unknown, disabledTools: string[] = []): McpToolSummary[] {
  if (!Array.isArray(tools)) return []
  const disabled = new Set(disabledTools)
  return tools.filter(isRecord).filter((tool) => typeof tool.name === 'string' && tool.name).slice(0, 500).map((tool) => {
    const annotations = isRecord(tool.annotations) ? tool.annotations : {}
    const name = String(tool.name).slice(0, 256)
    return {
      name,
      ...(typeof tool.title === 'string' && tool.title ? { title: tool.title.slice(0, 200) } : typeof annotations.title === 'string' ? { title: annotations.title.slice(0, 200) } : {}),
      ...(typeof tool.description === 'string' && tool.description ? { description: tool.description.slice(0, 600) } : {}),
      enabled: !disabled.has(name),
      ...(typeof annotations.readOnlyHint === 'boolean' ? { readOnlyHint: annotations.readOnlyHint } : {}),
      ...(typeof annotations.destructiveHint === 'boolean' ? { destructiveHint: annotations.destructiveHint } : {}),
    }
  })
}

/**
 * Owns MCP server configuration: validation, encrypted secrets, working
 * directory policy and connection tests. Secret values only exist decrypted
 * transiently, on their way to the tool-runner process.
 */
export class McpService {
  private readonly chosenCwds = new Set<string>()

  constructor(
    private readonly database: AppDatabase,
    private readonly secrets: McpSecretCipher,
    private readonly runner: McpRunner,
    private readonly options: McpServiceOptions,
  ) {}

  list(): McpServerConfig[] {
    return this.database.listMcpServers().map(presentMcp)
  }

  get(id: string): McpServerConfig {
    const row = this.database.listMcpServers().find((server) => server.id === id)
    if (!row) throw new Error('MCP Server 不存在')
    return presentMcp(row)
  }

  /** Records a folder the user picked in the native dialog, allowing it as a custom cwd. */
  async rememberChosenCwd(path: string): Promise<string> {
    const canonical = await realpath(resolve(path))
    this.chosenCwds.add(canonical)
    return canonical
  }

  async save(input: McpServerInput & { secrets?: McpSecretInput }, origin: 'settings' | 'capability_package' = 'settings'): Promise<McpServerConfig> {
    const normalized = normalizeMcpServerInput(input)
    const existing = input.id ? this.database.getMcpServer(input.id) : undefined
    if (input.id && !existing) throw new Error('MCP Server 不存在')
    if (normalized.config.type === 'stdio' && normalized.config.cwdMode === 'custom') {
      normalized.config.cwd = await this.validateCustomCwd(normalized.config.cwd!, existing?.config)
    }
    if (existing && !input.disabledTools && Array.isArray(existing.config?.disabledTools)) {
      normalized.config.disabledTools = existing.config.disabledTools
    }
    const previousSecret = existing?.encrypted_secret ? await this.decodeStoredSecret(existing.encrypted_secret) : undefined
    const merged = mergeMcpSecrets(normalized.config, previousSecret, input.secrets)
    let encrypted: Buffer | null | undefined
    if (merged === 'keep') encrypted = existing?.config?.auth === 'oauth' ? undefined : null
    else encrypted = merged ? await this.secrets.encrypt(JSON.stringify(merged)) : null
    const id = this.database.saveMcpServer({ id: input.id, name: normalized.name, enabled: normalized.enabled, transport: normalized.transport, config: normalized.config }, encrypted)
    await this.disconnect(id)
    const config = normalized.config
    this.database.audit('mcp', existing ? 'server_updated' : 'server_added', `${existing ? '已更新' : '已添加'} MCP Server ${normalized.name}`, {
      actor: origin === 'settings' ? 'user' : 'system',
      outcome: 'succeeded',
      target: id,
      origin,
      transport: normalized.transport,
      // Names only; values never reach the audit log.
      ...(config.type === 'stdio' ? { command: config.command, secretEnvKeys: config.envKeys, plainEnvKeys: Object.keys(config.env), cwdMode: config.cwdMode } : { url: config.url, auth: config.auth, secretHeaderKeys: config.secretHeaderKeys }),
      secretsUpdated: [...Object.keys(input.secrets?.env ?? {}), ...Object.keys(input.secrets?.headers ?? {}), ...(input.secrets?.bearer ? ['bearer'] : [])].filter((key) => key === 'bearer' || Boolean(input.secrets?.env?.[key] ?? input.secrets?.headers?.[key])),
    })
    return this.get(id)
  }

  async remove(id: string): Promise<void> {
    const row = this.database.getMcpServer(id)
    await this.disconnect(id)
    this.database.removeMcpServer(id)
    if (row) this.database.audit('mcp', 'server_removed', `已移除 MCP Server ${row.name}`, { actor: 'user', outcome: 'succeeded', target: id })
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig> {
    const row = this.requireRow(id)
    this.database.setMcpEnabled(id, enabled)
    if (!enabled) await this.disconnect(id)
    this.database.audit('mcp', enabled ? 'server_enabled' : 'server_disabled', `${enabled ? '已启用' : '已停用'} MCP Server ${row.name}`, { actor: 'user', outcome: 'succeeded', target: id })
    return this.get(id)
  }

  setToolEnabled(id: string, toolName: string, enabled: boolean): McpServerConfig {
    const row = this.requireRow(id)
    const disabled = new Set<string>(Array.isArray(row.config?.disabledTools) ? row.config.disabledTools : [])
    if (enabled) disabled.delete(toolName)
    else disabled.add(toolName)
    this.database.setMcpConfig(id, { ...row.config, disabledTools: [...disabled].sort() })
    if (Array.isArray(row.tools)) this.database.updateMcpTools(id, row.tools.map((tool: McpToolSummary) => ({ ...tool, enabled: !disabled.has(tool.name) })), row.connected_via ?? undefined)
    this.database.audit('mcp', enabled ? 'tool_enabled' : 'tool_disabled', `${enabled ? '已启用' : '已停用'} MCP 工具 ${toolName}`, { actor: 'user', outcome: 'succeeded', target: id, toolName })
    return this.get(id)
  }

  /** Why a call to this server/tool must be refused before approval, if at all. */
  blockedReason(serverId: unknown, toolName?: unknown): string | undefined {
    const row = typeof serverId === 'string' ? this.database.getMcpServer(serverId) : undefined
    if (!row) return 'MCP Server 不存在，请先在设置中添加'
    if (!row.enabled) return `MCP Server「${row.name}」已停用`
    if (typeof toolName === 'string' && Array.isArray(row.config?.disabledTools) && row.config.disabledTools.includes(toolName)) {
      return `MCP 工具「${toolName}」已在设置中停用`
    }
    return undefined
  }

  disabledTools(serverId: string): string[] {
    const row = this.database.getMcpServer(serverId)
    return Array.isArray(row?.config?.disabledTools) ? row.config.disabledTools : []
  }

  /** Enabled servers and their enabled tool names, for the run context. */
  catalog(): McpCatalogEntry[] {
    return this.database.listMcpServers().filter((row) => row.enabled).map((row) => {
      const disabled = new Set<string>(Array.isArray(row.config?.disabledTools) ? row.config.disabledTools : [])
      const tools = Array.isArray(row.tools) ? row.tools.map((tool: McpToolSummary) => tool.name).filter((name: string) => !disabled.has(name)) : []
      return { id: row.id, name: row.name, toolNamespace: String(row.config?.toolNamespace ?? row.name), transport: row.transport === 'stdio' ? 'stdio' : 'http', tools }
    })
  }

  /** Decrypted, cwd-resolved server description handed to the tool runner. */
  async runtimeServer(id: string, context: McpRuntimeContext = {}): Promise<Record<string, any>> {
    let row = this.requireRow(id)
    if (row.config?.auth === 'oauth' && typeof row.config?.url === 'string' && this.options.refreshOAuth) {
      await this.options.refreshOAuth(id, row.config.url)
      row = this.requireRow(id)
    }
    const config: NormalizedMcpConfig & Record<string, unknown> = { ...row.config }
    if (row.transport === 'stdio' || config.type === 'stdio') {
      const mode = (config as any).cwdMode ?? ((config as any).cwd ? 'custom' : 'isolated')
      ;(config as any).cwd = await this.resolveCwd(id, mode, (config as any).cwd, context)
    }
    const secrets = row.encrypted_secret ? await this.decodeStoredSecret(row.encrypted_secret) : undefined
    return { id, transport: row.transport, config, ...(secrets !== undefined ? { secrets } : {}) }
  }

  async test(id: string, context: McpRuntimeContext = {}): Promise<McpConnectionTest> {
    const started = Date.now()
    const row = this.requireRow(id)
    let secretValues: string[] = []
    try {
      const server = await this.runtimeServer(id, context)
      secretValues = mcpSecretValues(server.secrets)
      const result = await this.runner.execute({ runId: 'system', toolId: 'mcp.list_tools', args: { serverId: id }, mcpServer: server })
      const tools = summarizeMcpTools(result?.tools, this.disabledTools(id))
      const fingerprint = createHash('sha256').update(JSON.stringify(result?.tools ?? [])).digest('hex')
      const serverVersion = typeof result?.serverVersion?.version === 'string' ? result.serverVersion.version : undefined
      const connectedVia = result?.connectedVia === 'sse' || result?.connectedVia === 'streamable_http' || result?.connectedVia === 'stdio' ? result.connectedVia : undefined
      this.database.updateMcpHealth(id, 'healthy', undefined, fingerprint, serverVersion)
      this.database.updateMcpTools(id, tools, connectedVia)
      this.database.audit('mcp', 'test', `MCP Server ${row.name} 连接成功，发现 ${tools.length} 个工具`, { actor: 'user', outcome: 'succeeded', target: id, toolCount: tools.length, ...(connectedVia ? { connectedVia } : {}) })
      return { ok: true, latencyMs: Date.now() - started, ...(serverVersion ? { serverVersion } : {}), toolCount: tools.length, tools, ...(connectedVia ? { connectedVia } : {}) }
    } catch (error) {
      const message = this.scrub(error instanceof Error ? error.message : String(error), secretValues)
      this.database.updateMcpHealth(id, 'unhealthy', message)
      this.database.audit('mcp', 'test', `MCP Server ${row.name} 连接失败`, { actor: 'user', outcome: 'failed', target: id, error: message.slice(0, 500) })
      return { ok: false, latencyMs: Date.now() - started, error: { code: 'MCP_CONNECTION_FAILED', message, retryable: true } }
    }
  }

  /** Removes secret values and generic credential patterns from text bound for logs or UI. */
  scrub(text: string, secretValues: string[]): string {
    return redactSecrets(scrubSecretValues(text, secretValues)).slice(0, 2_000)
  }

  private requireRow(id: string): any {
    const row = this.database.getMcpServer(id)
    if (!row) throw new Error('MCP Server 不存在')
    return row
  }

  private async disconnect(id: string): Promise<void> {
    await this.runner.execute({ runId: 'system', toolId: 'mcp.disconnect', args: { serverId: id } }).catch(() => undefined)
  }

  private async decodeStoredSecret(blob: Buffer): Promise<unknown> {
    const text = await this.secrets.decrypt(blob)
    try { return JSON.parse(text) as unknown } catch { return text }
  }

  private async validateCustomCwd(input: string, previous: Record<string, unknown> | undefined): Promise<string> {
    let canonical: string
    try {
      canonical = await realpath(resolve(input))
    } catch {
      throw new Error(`工作目录不存在：${input}`)
    }
    if (!(await stat(canonical)).isDirectory()) throw new Error('工作目录必须是文件夹')
    if (canonical === '/' || canonical === (await realpath(homedir()).catch(() => homedir()))) throw new Error('工作目录不能是磁盘根目录或个人主目录，请选择具体的文件夹')
    const unchanged = previous?.cwdMode === 'custom' && previous?.cwd === canonical
    const insideWorkspace = await this.isInsideWorkspace(canonical)
    if (!unchanged && !insideWorkspace && !this.chosenCwds.has(canonical)) {
      throw new Error('工作目录需要通过「选择文件夹」指定，或位于已授权的工作区内')
    }
    return canonical
  }

  private async isInsideWorkspace(path: string): Promise<boolean> {
    for (const workspace of this.database.listWorkspaces()) {
      const root = await realpath(String(workspace.root_path)).catch(() => undefined)
      if (root && within(root, path)) return true
    }
    return false
  }

  private async resolveCwd(id: string, mode: string, cwd: unknown, context: McpRuntimeContext): Promise<string> {
    if (mode === 'workspace') {
      if (!context.workspaceRoot) throw new Error('该 MCP Server 配置为在工作区中运行，但当前没有可用的工作区')
      return realpath(context.workspaceRoot)
    }
    if (mode === 'custom') {
      if (typeof cwd !== 'string' || !cwd) throw new Error('MCP Server 缺少工作目录')
      const canonical = await realpath(cwd).catch(() => undefined)
      if (!canonical || canonical !== cwd || !(await stat(canonical)).isDirectory()) throw new Error(`MCP 工作目录不存在或已被替换为链接：${cwd}，请在设置中重新选择`)
      return canonical
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('MCP Server ID 无效')
    const directory = join(this.options.isolatedRoot, id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('MCP 隔离工作目录不安全')
    return realpath(directory)
  }
}
