import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { app, dialog, shell } from 'electron'
import { McpServerInputSchema, type AppSettings, type McpServerInput, type DesktopInvokeChannel, type InstalledCapabilityPackage, type ModelConnectionTest, type ModelProfile } from '@deskforge/contracts'
import { classifyModelError, redactSecrets } from '@deskforge/core'
import { walkWorkspace, type SearchScope } from '../workers/workspace-search'
import type { AppDatabase } from './database'
import type { SecretStore } from './secret-store'
import type { AgentHostBridge, ToolRunnerBridge } from './worker-bridge'
import type { RunCoordinator } from './run-coordinator'
import type { ToolBroker } from './tool-broker'
import type { ChromeBridge } from './chrome-bridge'
import type { SkillService } from './skill-service'
import type { AutomationService } from './automation-service'
import type { McpOAuthService } from './mcp-oauth'
import type { ArtifactStore } from './artifact-store'
import type { McpService } from './mcp-service'
import type { SkillImportService } from './skill-import'
import type { KnowledgeIndexService } from './knowledge/knowledge-index'
import type { EmbeddingsSettingsService } from './knowledge/embeddings'
import { exportSessionMarkdown } from './session-export'
import { BUNDLED_SKILL_NAMES, REMOVED_BUNDLED_SKILLS_SETTING } from './bundled-skills'
import { DEFAULT_SETTINGS, normalizeRunLimits, presentArtifact, presentAudit, presentChromeGrant, presentMcp, presentMemory, presentModel, presentRunSummary, presentSessionRule, presentWorkspace } from './presenters'
import { auditExportFileName, presentAuditRecord, renderAuditExport } from './audit-export'
import { CapabilityPackageService, type ParsedCapabilityPackage } from './capability-package-service'
import { getModelCatalog } from './model-providers'

type Handler = (input: any) => Promise<any> | any

export class IpcApi {
  readonly handlers: Record<DesktopInvokeChannel, Handler>
  private queryAudit(filters: { runId?: string; category?: string; outcome?: string; from?: string; to?: string; text?: string; limit?: number }) {
    const { rows, total } = this.database.queryAudit(filters)
    const report = this.database.auditChainReport()
    const runs = this.database.auditRuns()
    return {
      items: rows.map((row) => presentAuditRecord(row, report.status.get(Number(row.id)) ?? 'legacy')),
      total,
      truncated: total > rows.length,
      categories: this.database.auditCategories(),
      runs,
      chain: report.summary,
    }
  }

  private oauthServerByState = new Map<string, string>()
  private pendingWorkspaceSelections = new Map<string, number>()
  private capabilitySelections = new Map<string, { parsed: ParsedCapabilityPackage; fingerprint: string; expiresAt: number }>()
  private capabilityPackages = new CapabilityPackageService()

  private async searchWorkspaceFiles(workspaceId: string, query?: string, limit = 30): Promise<Array<{ path: string; name: string; isDirectory: boolean; extension?: string }>> {
    const workspace = this.database.getWorkspace(workspaceId)
    if (!workspace || !workspace.root_path) return []
    const root = workspace.root_path
    try {
      const stat = await lstat(root)
      if (!stat.isDirectory()) return []
    } catch {
      return []
    }

    const normalizedQuery = (query ?? '').trim().toLowerCase()
    const maxResults = Math.min(Math.max(limit ?? 30, 1), 100)
    const candidates: Array<{ item: { path: string; name: string; isDirectory: boolean; extension?: string }; score: number }> = []

    const scope: SearchScope = { root, base: root }
    try {
      await walkWorkspace(scope, { maxEntries: 4000, deadline: Date.now() + 2500 }, (entry) => {
        const relPath = entry.display
        if (!relPath || relPath === '.') return true

        const name = basename(relPath)
        const ext = entry.isDirectory ? undefined : extname(name).replace(/^\./, '').toLowerCase()

        if (!normalizedQuery) {
          candidates.push({
            item: { path: relPath, name, isDirectory: entry.isDirectory, ...(ext ? { extension: ext } : {}) },
            score: entry.isDirectory ? 5 : 10,
          })
          return candidates.length < maxResults * 2
        }

        const lowerName = name.toLowerCase()
        const lowerPath = relPath.toLowerCase()

        if (!lowerPath.includes(normalizedQuery)) return true

        let score = 0
        if (lowerName === normalizedQuery) score = 100
        else if (lowerName.startsWith(normalizedQuery)) score = 80
        else if (lowerName.includes(normalizedQuery)) score = 60
        else if (lowerPath.startsWith(normalizedQuery)) score = 40
        else score = 20

        if (!entry.isDirectory) score += 5

        const depth = relPath.split('/').length
        score -= Math.min(depth, 10)

        candidates.push({
          item: { path: relPath, name, isDirectory: entry.isDirectory, ...(ext ? { extension: ext } : {}) },
          score,
        })

        return candidates.length < 150
      })
    } catch {
      return []
    }

    candidates.sort((a, b) => b.score - a.score || a.item.path.localeCompare(b.item.path))
    return candidates.slice(0, maxResults).map((c) => c.item)
  }

  constructor(
    private database: AppDatabase,
    private secrets: SecretStore,
    private host: AgentHostBridge,
    private runner: ToolRunnerBridge,
    private coordinator: RunCoordinator,
    private broker: ToolBroker,
    private chrome: ChromeBridge,
    private skills: SkillService,
    private automations: AutomationService<any>,
    private oauth: McpOAuthService,
    private artifacts: ArtifactStore,
    private mcp: McpService,
    private skillImports: SkillImportService,
    private knowledge: KnowledgeIndexService,
    private embeddings: EmbeddingsSettingsService,
  ) {
    this.handlers = this.createHandlers()
  }

  private settings(): AppSettings {
    const stored = this.database.getSetting<Partial<AppSettings> & { defaultRunLimits?: any }>('appSettings', {})
    return { ...DEFAULT_SETTINGS, ...stored, defaultRunLimits: normalizeRunLimits(stored.defaultRunLimits) }
  }

  /** Probe a provider with a tiny request. Keys stay in memory only for the call. */
  private async testModelConnection(
    input: { provider: string; modelId: string; baseUrl: string },
    encryptedKey?: Buffer,
    plainKey?: string,
  ): Promise<ModelConnectionTest> {
    const started = Date.now()
    const target = { ...input, provider: input.provider as ModelConnectionTest['provider'] }
    let apiKey = plainKey ?? ''
    try {
      if (!apiKey && encryptedKey) apiKey = await this.secrets.decrypt(encryptedKey)
      const result = await this.host.testProvider({ ...target, apiKey }) as { notice?: string }
      return { ok: true, ...target, latencyMs: Date.now() - started, ...(result?.notice ? { notice: result.notice } : {}) }
    } catch (error) {
      return { ok: false, ...target, latencyMs: Date.now() - started, error: classifyModelError(error, apiKey ? [apiKey] : [], target) }
    } finally {
      apiKey = ''
    }
  }

  private modelProfiles(): ModelProfile[] {
    const settings = this.settings()
    return this.database.listModelProfiles().map((row) => presentModel(row, settings.subagentModelProfileId))
  }

  private createHandlers(): Record<DesktopInvokeChannel, Handler> {
    return {
      bootstrap: () => {
        const settings = this.settings()
        const selectedId = this.database.getSetting<string | undefined>('selectedWorkspaceId', undefined)
        const workspaces = this.database.listWorkspaces().map((row) => presentWorkspace(row, selectedId))
        const profiles = this.modelProfiles()
        return {
          app: this.appInfo(),
          onboardingComplete: workspaces.length > 0 && profiles.some((profile) => profile.keyConfigured),
          settings,
          ...(selectedId ? { selectedWorkspaceId: selectedId } : {}),
          workspaces,
          modelProfiles: profiles,
          chrome: this.chrome.getStatus(),
        }
      },
      'app:get-info': () => this.appInfo(),
      'app:choose-workspace': async () => {
        const selected = (await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择 Agent 工作区' })).filePaths[0]
        if (!selected) return null
        const canonical = await realpath(selected)
        this.pendingWorkspaceSelections.set(canonical, Date.now() + 5 * 60_000)
        return canonical
      },
      'app:choose-files': async () => (await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: '选择附件' })).filePaths,
      'app:import-attachments': async () => {
        const selected = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: '选择附件（单个最大 25 MB）' })
        if (selected.canceled) return []
        const rows = []
        let total = 0
        for (const path of selected.filePaths.slice(0, 10)) {
          const data = await readFile(path)
          if (data.byteLength > 25 * 1024 * 1024) throw new Error(`${basename(path)} 超过 25 MB`)
          total += data.byteLength
          if (total > 100 * 1024 * 1024) throw new Error('本次附件总大小超过 100 MB')
          rows.push(presentArtifact(await this.artifacts.putBuffer({ name: basename(path), kind: 'attachment', data, metadata: { importedAt: new Date().toISOString() } })))
        }
        return rows
      },
      'app:reveal-path': async ({ path }) => { shell.showItemInFolder(path) },
      'app:open-path': async ({ path }) => {
        const errorMessage = await shell.openPath(path)
        if (errorMessage) return { success: false, error: errorMessage }
        return { success: true }
      },

      'workspaces:list': () => { const selected = this.database.getSetting<string | undefined>('selectedWorkspaceId', undefined); return this.database.listWorkspaces().map((row) => presentWorkspace(row, selected)) },
      'workspaces:create': async ({ path, name }) => {
        const canonical = await realpath(path)
        if (canonical === '/' ) throw new Error('不能把磁盘根目录 / 设为工作区')
        const expiry = this.pendingWorkspaceSelections.get(canonical)
        this.pendingWorkspaceSelections.delete(canonical)
        if (!expiry || expiry < Date.now()) throw new Error('工作区授权已失效，请通过文件夹选择器重新选择')
        const id = this.database.addWorkspace(canonical, name ?? basename(canonical))
        if (!this.database.getSetting('selectedWorkspaceId', '')) this.database.setSetting('selectedWorkspaceId', id)
        return presentWorkspace(this.database.getWorkspace(id), this.database.getSetting('selectedWorkspaceId', id))
      },
      'workspaces:update': ({ id, name, rules }) => {
        const existing = this.database.getWorkspace(id)
        if (!existing) throw new Error('工作区不存在')
        this.database.db.prepare('UPDATE workspaces SET name=?,rules=?,updated_at=? WHERE id=?').run(name ?? existing.name, rules ?? existing.rules, new Date().toISOString(), id)
        return presentWorkspace(this.database.getWorkspace(id), this.database.getSetting('selectedWorkspaceId', ''))
      },
      'workspaces:remove': async ({ id }) => { this.database.removeWorkspace(id); await this.knowledge.drop(id).catch(() => undefined) },
      'workspaces:select': ({ id }) => { const row = this.database.getWorkspace(id); if (!row) throw new Error('工作区不存在'); this.database.setSetting('selectedWorkspaceId', id); return presentWorkspace(row, id) },
      'workspaces:search-files': ({ workspaceId, query, limit }) => this.searchWorkspaceFiles(workspaceId, query, limit),

      'runs:list': (input) => {
        const profiles = this.modelProfiles()
        let rows = this.database.listRuns(Math.min(input?.limit ?? 50, 100))
        if (input?.workspaceId) rows = rows.filter((row) => row.workspaceId === input.workspaceId)
        if (input?.status) rows = rows.filter((row) => row.status === input.status)
        return { items: rows.map((row) => presentRunSummary(row, profiles.find((profile) => profile.id === row.modelProfileId) ?? this.snapshotProfile(row))) }
      },
      'runs:get': ({ id }) => this.coordinator.getDetail(id),
      'runs:create': (input) => this.coordinator.create({ workspaceId: input.workspaceId, objective: input.objective, accessMode: input.accessMode, permissionMode: input.permissionMode, mode: input.mode, title: input.title, modelProfileId: input.modelProfileId, limits: input.limits, attachmentIds: input.attachmentIds, readOnly: input.mode === 'plan' }),
      'runs:send-message': async ({ runId, content, accessMode, permissionMode, attachmentIds }) => { await this.coordinator.sendMessage(runId, content, accessMode, attachmentIds, permissionMode) },
      'runs:pause': ({ id }) => this.coordinator.pause(id),
      'runs:resume': ({ id }) => this.coordinator.resume(id),
      'runs:cancel': ({ id }) => this.coordinator.cancel(id),
      'runs:remove': ({ id }) => { this.coordinator.delete(id) },
      'runs:respond-approval': (input) => { this.broker.respondToApproval(input) },
      'runs:search': ({ query, workspaceId, limit }) => {
        const hits = this.database.searchRuns(query, { ...(workspaceId ? { workspaceId } : {}), ...(limit ? { limit } : {}) })
        return hits.flatMap((hit) => {
          const run = this.database.getRun(hit.runId)
          if (!run) return []
          return [{ runId: hit.runId, title: String(run.title), workspaceId: String(run.workspaceId ?? ''), status: run.status, updatedAt: String(run.updatedAt), matchedIn: hit.matchedIn, ...(hit.messageId ? { messageId: hit.messageId } : {}), snippet: hit.snippet.slice(0, 300) }]
        })
      },
      'runs:rename': async ({ id, title }) => {
        const next = String(title).replace(/\s+/g, ' ').trim().slice(0, 500)
        if (!next) throw new Error('会话名称不能为空')
        this.database.renameRun(id, next)
        this.database.audit('session', 'rename', `会话已重命名为「${next.slice(0, 60)}」`, { actor: 'user', outcome: 'succeeded', target: id }, id)
        this.coordinator.emitRun(id)
        return this.coordinator.getDetail(id).run
      },
      'runs:export-markdown': async ({ id }) => {
        const detail = await this.coordinator.getDetail(id)
        return exportSessionMarkdown(detail, {
          database: this.database,
          secrets: this.secrets,
          appVersion: app.getVersion(),
          timeZone: this.settings().timezone,
          chooseTarget: async (defaultName) => {
            const target = await dialog.showSaveDialog({ title: '导出会话为 Markdown', defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: 'Markdown', extensions: ['md'] }] })
            return target.canceled || !target.filePath ? undefined : target.filePath
          },
        })
      },
      'knowledge:list-status': async () => Promise.all(this.database.listWorkspaces().map((row: any) => this.knowledge.status(String(row.id)))),
      'knowledge:rebuild': async ({ workspaceId, mode }) => {
        const status = await this.knowledge.build(workspaceId, mode)
        this.database.audit('knowledge', mode === 'full' ? 'rebuild' : 'update', `本地知识库${mode === 'full' ? '重建' : '增量更新'}：${status.fileCount} 个文件，${status.chunkCount} 个片段`, { actor: 'user', outcome: status.error ? 'failed' : 'succeeded', target: workspaceId, ...(status.lastRun ?? {}), truncated: status.truncated })
        return status
      },
      'knowledge:clear': async ({ workspaceId }) => {
        const status = await this.knowledge.clear(workspaceId)
        this.database.audit('knowledge', 'clear', '本地知识库索引已清除', { actor: 'user', outcome: 'succeeded', target: workspaceId })
        return status
      },
      'knowledge:search': ({ workspaceId, query, limit }) => this.knowledge.search(workspaceId, query, { ...(limit ? { limit } : {}) }),
      'knowledge:get-embeddings': () => this.embeddings.view(),
      'knowledge:set-embeddings': (input) => this.embeddings.update(input),
      'knowledge:test-embeddings': () => this.embeddings.test(),
      'approvals:list-session-rules': (input) => this.database.listSessionRules(input?.runId).map(presentSessionRule),
      'approvals:revoke-session-rule': ({ id }) => { this.broker.revokeSessionRule(id); return { revoked: true as const } },

      'models:list': () => this.modelProfiles(),
      'models:catalog': ({ provider }) => getModelCatalog(provider),
      'models:upsert': (input) => {
        const existing = input.id ? this.database.listModelProfiles().find((row) => row.id === input.id) : undefined
        const id = this.database.saveModelProfile({ ...input, isDefault: existing?.isDefault ?? this.database.listModelProfiles().length === 0, capabilities: input.capabilities ?? {} })
        return this.modelProfiles().find((profile) => profile.id === id)!
      },
      'models:remove': ({ id }) => { this.database.deleteModelProfile(id) },
      'models:set-secret': async ({ profileId, apiKey }) => { this.database.setModelEncryptedKey(profileId, await this.secrets.encrypt(apiKey)); this.database.audit('secret', 'set_model_key', '模型密钥已更新', { actor: 'user', outcome: 'succeeded', target: profileId }) },
      'models:delete-secret': ({ profileId }) => { this.database.setModelEncryptedKey(profileId, null) },
      'models:test': async ({ profileId }) => {
        const raw = this.database.getModelProfileSecret(profileId)
        if (!raw?.encryptedKey) throw new Error('模型配置尚未设置 API Key')
        return this.testModelConnection({ provider: raw.provider, modelId: raw.modelId, baseUrl: raw.baseUrl }, raw.encryptedKey)
      },
      'models:test-draft': async ({ provider, modelId, baseUrl, apiKey, profileId }) => {
        const target = { provider, modelId: modelId.trim(), baseUrl: baseUrl.trim() }
        if (apiKey?.trim()) return this.testModelConnection(target, undefined, apiKey.trim())
        const saved = profileId ? this.database.getModelProfileSecret(profileId) : undefined
        if (!saved?.encryptedKey) throw new Error('请先填写 API Key 再测试连接')
        return this.testModelConnection(target, saved.encryptedKey)
      },
      'models:set-defaults': ({ defaultModelProfileId, subagentModelProfileId }) => {
        this.database.setDefaultModelProfile(defaultModelProfileId)
        const settings = this.settings(); settings.defaultModelProfileId = defaultModelProfileId
        if (subagentModelProfileId) settings.subagentModelProfileId = subagentModelProfileId; else delete settings.subagentModelProfileId
        this.database.setSetting('appSettings', settings as any)
      },

      'settings:get': () => this.settings(),
      'settings:update': (input) => {
        const settings = { ...this.settings(), ...input, defaultRunLimits: { ...this.settings().defaultRunLimits, ...(input.defaultRunLimits ?? {}) } }
        this.database.setSetting('appSettings', settings as any)
        app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
        return settings
      },

      'permissions:list-persistent': () => this.database.listPersistentGrants(),
      'permissions:create-persistent': ({ workspaceId, toolName, path, expiresAt }) => {
        const normalizedPath = path.trim()
        if (!normalizedPath || normalizedPath.includes('\0')) throw new Error('授权路径无效')
        const grant = this.database.addPersistentGrant(workspaceId, toolName, normalizedPath, expiresAt)
        this.database.audit('security', 'create_persistent_grant', `已创建 ${toolName} 的永久授权`, { actor: 'user', outcome: 'approved', target: normalizedPath })
        return grant
      },
      'permissions:remove-persistent': ({ id }) => {
        this.database.removePersistentGrant(id)
        this.database.audit('security', 'remove_persistent_grant', '已撤销永久授权', { actor: 'user', outcome: 'succeeded', target: id })
      },

      'capability-packages:choose': async () => {
        const result = await dialog.showOpenDialog({ title: '选择本地能力包', properties: ['openDirectory'] })
        if (result.canceled || !result.filePaths[0]) return null
        const parsed = await this.capabilityPackages.inspect(result.filePaths[0])
        const selectionId = randomUUID()
        const fingerprint = this.capabilityFingerprint(parsed)
        this.capabilitySelections.set(selectionId, { parsed, fingerprint, expiresAt: Date.now() + 10 * 60_000 })
        return this.presentCapabilityPreview(selectionId, parsed)
      },
      'capability-packages:install': async ({ selectionId, workspaceId }) => {
        const selection = this.capabilitySelections.get(selectionId)
        this.capabilitySelections.delete(selectionId)
        if (!selection || selection.expiresAt < Date.now()) throw new Error('能力包选择已失效，请重新选择')
        const parsed = await this.capabilityPackages.inspect(selection.parsed.rootDirectory)
        if (this.capabilityFingerprint(parsed) !== selection.fingerprint) throw new Error('能力包在确认后发生变化，请重新选择')
        const installed = this.installedCapabilityPackages()
        if (installed.some((item) => item.name === parsed.manifest.name && item.version === parsed.manifest.version)) throw new Error('该版本能力包已经安装')
        const workspace = workspaceId ? this.database.getWorkspace(workspaceId) : undefined
        if (parsed.rules.length && !workspace) throw new Error('能力包包含规则，安装时必须选择作用工作区')

        const mcpInputs = parsed.mcpConfigs.map(({ relativePath, config }) => {
          if ('id' in config || 'secrets' in config) throw new Error(`能力包 MCP 配置不得携带 id 或 Secret：${relativePath}`)
          const input = McpServerInputSchema.parse(config) as McpServerInput
          // Packages cannot choose an arbitrary working directory.
          if (input.transport.type === 'stdio' && input.transport.cwdMode === 'custom') throw new Error(`能力包 MCP 配置不能指定自定义工作目录：${relativePath}`)
          if ((input.transport.type === 'stdio' && input.transport.envKeys.length) || (input.transport.type === 'streamable_http' && (input.transport.auth === 'bearer' || input.transport.auth === 'headers'))) {
            throw new Error(`能力包 MCP 配置需要密钥，请安装后在设置中手动添加：${relativePath}`)
          }
          return input
        })
        const ruleBlock = parsed.rules.map((rule) => `\n<!-- capability:${parsed.manifest.name}@${parsed.manifest.version}:${rule.relativePath} -->\n${rule.content.trim()}\n`).join('')
        if (workspace && Buffer.byteLength(`${workspace.rules ?? ''}${ruleBlock}`) > 128 * 1024) throw new Error('能力包规则会使工作区规则超过 128 KB 上限')
        const templateContents = await Promise.all(parsed.templates.map(async (template) => {
          const source = join(parsed.rootDirectory, template.relativePath)
          const info = await lstat(source)
          const canonical = await realpath(source)
          const fromRoot = relative(parsed.rootDirectory, canonical)
          if (info.isSymbolicLink() || !info.isFile() || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) throw new Error(`模板路径不安全：${template.relativePath}`)
          const content = await readFile(canonical)
          if (createHash('sha256').update(content).digest('hex') !== template.sha256) throw new Error(`模板在安装期间发生变化：${template.relativePath}`)
          return { template, content }
        }))
        const skillIds: string[] = []
        for (const skill of parsed.skills) skillIds.push((await this.skills.import({ directory: skill.directory })).id)
        const mcpServerIds: string[] = []
        for (const input of mcpInputs) mcpServerIds.push((await this.mcp.save(input, 'capability_package')).id)
        if (workspace && parsed.rules.length) {
          this.database.updateWorkspaceRules(workspace.id, `${workspace.rules ?? ''}${ruleBlock}`.trim())
        }
        const packageId = randomUUID()
        const templateRoot = join(app.getPath('userData'), 'capability-packages', packageId)
        const templatePaths: string[] = []
        for (const { template, content } of templateContents) {
          const target = join(templateRoot, template.relativePath)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await writeFile(target, content, { mode: 0o600 })
          templatePaths.push(target)
        }
        const entry: InstalledCapabilityPackage = {
          id: packageId,
          name: parsed.manifest.name,
          version: parsed.manifest.version,
          ...(workspace ? { workspaceId: workspace.id } : {}),
          skillIds,
          mcpServerIds,
          ruleSources: parsed.rules.map((rule) => rule.relativePath),
          templatePaths,
          installedAt: new Date().toISOString(),
        }
        this.database.setSetting('installedCapabilityPackages', [...installed, entry] as any)
        this.database.audit('capability', 'install_package', `已安装能力包 ${entry.name}@${entry.version}`, { actor: 'user', outcome: 'succeeded', target: entry.id, skillIds, mcpServerIds })
        return entry
      },
      'capability-packages:list': () => this.installedCapabilityPackages(),

      'memory:list': (input) => this.database.listMemory().map(presentMemory).filter((entry) => (!input?.workspaceId || entry.workspaceId === input.workspaceId) && (!input?.state || entry.state === input.state) && (!input?.scope || entry.scope === input.scope)),
      'memory:propose': (input) => { const id = this.database.saveMemory({ workspaceId: input.workspaceId, kind: input.type, scope: input.scope, content: input.content, confidence: input.confidence, source: [input.source], status: 'proposed' }); return presentMemory(this.database.getMemory(id)) },
      'memory:confirm': ({ id }) => { this.database.updateMemoryStatus(id, 'confirmed'); return presentMemory(this.database.getMemory(id)) },
      'memory:disable': ({ id }) => { this.database.updateMemoryStatus(id, 'disabled'); return presentMemory(this.database.getMemory(id)) },
      'memory:remove': ({ id }) => { this.database.deleteMemory(id) },

      'mcp:list': () => this.mcp.list(),
      'mcp:upsert': (input) => this.mcp.save(input),
      'mcp:remove': async ({ id }) => {
        for (const [state, serverId] of this.oauthServerByState) if (serverId === id) this.oauthServerByState.delete(state)
        await this.mcp.remove(id)
      },
      'mcp:test': ({ id, workspaceId }) => {
        const workspaceRoot = this.workspaceRootFor(workspaceId)
        return this.mcp.test(id, workspaceRoot ? { workspaceRoot } : {})
      },
      'mcp:set-enabled': ({ id, enabled }) => this.mcp.setEnabled(id, enabled),
      'mcp:set-tool-enabled': ({ id, toolName, enabled }) => this.mcp.setToolEnabled(id, toolName, enabled),
      'mcp:choose-cwd': async () => {
        const result = await dialog.showOpenDialog({ title: '选择 MCP Server 的工作目录', properties: ['openDirectory', 'createDirectory'] })
        if (result.canceled || !result.filePaths[0]) return null
        return this.mcp.rememberChosenCwd(result.filePaths[0])
      },
      'mcp:start-oauth': async ({ id }) => {
        const row = this.database.getMcpServer(id)
        if (!row || row.transport !== 'http' || row.config?.auth !== 'oauth' || typeof row.config?.url !== 'string') throw new Error('该 MCP Server 未配置 OAuth Streamable HTTP')
        const started = await this.oauth.startOAuth(id, row.config.url)
        this.oauthServerByState.set(started.state, id)
        await shell.openExternal(started.authorizationUrl)
        this.database.audit('mcp', 'oauth_start', '已打开 MCP OAuth 授权页面', { actor: 'user', outcome: 'started', target: id })
        return started
      },
      'mcp:complete-oauth': ({ id, callbackUrl, state }) => this.completeOAuth(id, callbackUrl, state),

      'skills:list': () => this.skills.list(),
      'skills:get': ({ id }) => this.skills.get({ id }),
      'skills:import': async ({ directory }) => {
        // Legacy direct import still goes through the same validation as the preview flow.
        const preview = await this.skillImports.previewFolder(directory)
        return this.confirmSkillImport(preview.selectionId)
      },
      'skills:remove': async ({ id }) => {
        const removed = await this.skills.remove({ id })
        if (removed.source?.kind === 'bundled' || (!removed.source && BUNDLED_SKILL_NAMES.includes(removed.name))) {
          // Remember the choice so the bundled copy is not reinstalled on next launch.
          const current = this.database.getSetting<string[]>(REMOVED_BUNDLED_SKILLS_SETTING, [])
          this.database.setSetting(REMOVED_BUNDLED_SKILLS_SETTING, [...new Set([...(Array.isArray(current) ? current : []), removed.name])] as any)
        }
        this.database.audit('skill', 'remove', `已移除 Skill ${removed.name}`, { actor: 'user', outcome: 'succeeded', target: removed.id, name: removed.name })
      },
      'skills:set-enabled': async (input) => {
        const result = await this.skills.setEnabled(input)
        this.database.audit('skill', input.enabled ? 'enable' : 'disable', `${input.enabled ? '已启用' : '已停用'} Skill ${result.name}`, { actor: 'user', outcome: 'succeeded', target: result.id })
        return result
      },
      'skills:preview-folder': async () => {
        const result = await dialog.showOpenDialog({ title: '选择包含 SKILL.md 的文件夹', properties: ['openDirectory'] })
        if (result.canceled || !result.filePaths[0]) return null
        return this.skillImports.previewFolder(result.filePaths[0])
      },
      'skills:preview-git': (input) => this.skillImports.previewGit(input),
      'skills:preview-update': ({ id }) => this.skillImports.previewUpdate(id),
      'skills:confirm-import': ({ selectionId }) => this.confirmSkillImport(selectionId),
      'skills:cancel-import': async ({ selectionId }) => { await this.skillImports.cancel(selectionId) },

      'automations:list': (input) => this.automations.list(input),
      'automations:upsert': (input) => this.automations.upsert(input),
      'automations:remove': ({ id }) => this.automations.remove(id),
      'automations:set-enabled': (input) => this.automations.setEnabled(input),
      'automations:run-now': ({ id }) => this.automations.runNow(id),

      'chrome:get-status': () => this.chrome.getStatus(),
      'chrome:list-grants': (input) => (input?.runId ? this.database.listChromeGrants(input.runId) : this.database.listAllChromeGrants()).map(presentChromeGrant),
      'chrome:request-binding': async ({ runId }) => { await this.chrome.bindLatest(runId); return { requested: true as const } },
      'chrome:revoke-grant': ({ id }) => this.chrome.revokeStoredGrant(id),

      'audit:list': (input) => { let items = this.database.listAudit(input?.limit ?? 100).map(presentAudit); if (input?.runId) items = items.filter((item) => item.runId === input.runId); if (input?.outcome) items = items.filter((item) => item.outcome === input.outcome); return { items } },
      'audit:export-diagnostics': async (input) => {
        const entries = this.database.listAudit().filter((entry) => !input?.runId || entry.run_id === input.runId)
        const trace = this.database.diagnosticTraceBundle(input?.runId)
        const bundle = {
          format: 'deskforge-diagnostics-v2',
          exportedAt: new Date().toISOString(),
          auditChain: this.database.verifyAuditChain(),
          auditEntries: entries,
          traces: trace.traces,
          traceSpans: trace.spans,
        }
        const result = await dialog.showSaveDialog({ title: '导出脱敏诊断包', defaultPath: `deskforge-diagnostics-${new Date().toISOString().slice(0, 10)}.json` })
        if (result.canceled || !result.filePath) return null
        const redacted = redactSecrets(JSON.stringify(bundle, null, 2))
          .replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|secret|password)"\s*:\s*")[^"]+/gi, '$1REDACTED')
        await writeFile(result.filePath, redacted, { mode: 0o600 })
        return { path: result.filePath, entryCount: entries.length, redacted: true }
      },
      'audit:query': (input) => this.queryAudit(input ?? {}),
      'audit:export': async ({ format, ...filters }) => {
        const result = this.queryAudit({ ...filters, limit: filters.limit ?? 5_000 })
        const extension = format === 'markdown' ? 'md' : format
        const target = await dialog.showSaveDialog({
          title: '导出审计日志',
          defaultPath: auditExportFileName(format),
          filters: [{ name: format === 'csv' ? 'CSV' : format === 'markdown' ? 'Markdown' : 'JSON', extensions: [extension] }],
        })
        if (target.canceled || !target.filePath) return null
        const body = renderAuditExport(format, result.items, { exportedAt: new Date().toISOString(), filters, chain: result.chain, total: result.total })
        await writeFile(target.filePath, body, { mode: 0o600 })
        this.database.audit('audit', 'export', `导出审计日志（${format.toUpperCase()}，${result.items.length} 条）`, { actor: 'user', outcome: 'succeeded', format, entryCount: result.items.length, chainValid: result.chain.valid })
        return { path: target.filePath, format, entryCount: result.items.length, chainValid: result.chain.valid }
      },
      'artifacts:get-text': async ({ id, maxBytes }) => {
        const row = this.database.getArtifact(id); if (!row) throw new Error('产物不存在')
        const buffer = await readFile(row.path); const limit = maxBytes ?? 2 * 1024 * 1024
        return { artifact: presentArtifact(row), text: buffer.subarray(0, limit).toString('utf8'), truncated: buffer.length > limit }
      },
      'artifacts:reveal': ({ id }) => { const row = this.database.getArtifact(id); if (!row) throw new Error('产物不存在'); shell.showItemInFolder(row.path) },
      'artifacts:open': async ({ id }) => {
        const row = this.database.getArtifact(id)
        if (!row) throw new Error('产物不存在')
        const errorMessage = await shell.openPath(row.path)
        if (errorMessage) return { success: false, error: errorMessage }
        return { success: true }
      },
      'artifacts:undo-change': async ({ id }) => {
        const diff = this.database.getArtifact(id)
        if (!diff || diff.kind !== 'diff') throw new Error('只能撤销文件 Diff 产物')
        const metadata = this.parseObject(diff.metadata_json)
        const path = typeof metadata.path === 'string' ? metadata.path : ''
        const afterSha256 = typeof metadata.afterSha256 === 'string' ? metadata.afterSha256 : ''
        const createdFile = metadata.createdFile === true
        if (!path || !afterSha256 || !diff.run_id) throw new Error('Diff 缺少安全撤销信息')
        const run = this.database.getRun(diff.run_id)
        const workspace = this.database.getWorkspace(run?.workspaceId)
        if (!run || !workspace?.root_path) throw new Error('Diff 所属工作区已不可用')
        const workspaceRelativePath = relative(workspace.root_path, path)
        const pathIsOutsideWorkspace = workspaceRelativePath === '..'
          || workspaceRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
          || isAbsolute(workspaceRelativePath)
        if (pathIsOutsideWorkspace || workspace.root_path === '/') {
          throw Object.assign(
            new Error('只能撤销当前工作区内部的文件变更。DeskForge 不会授权磁盘根目录 /。'),
            { code: 'WORKSPACE_ROOT_FORBIDDEN' },
          )
        }
        let content = ''
        if (!createdFile) {
          const snapshotId = typeof metadata.snapshotArtifactId === 'string' ? metadata.snapshotArtifactId : ''
          const snapshot = this.database.getArtifact(snapshotId)
          if (!snapshot || snapshot.kind !== 'file_snapshot' || snapshot.run_id !== diff.run_id) throw new Error('原文件快照不存在')
          content = (await readFile(snapshot.path)).toString('utf8')
        }
        await this.runner.execute({
          runId: run.id,
          toolId: 'file.restore',
          workspacePath: workspace.root_path,
          authorizedRoot: workspace.root_path,
          args: { path, content, expectedCurrentSha256: afterSha256, createdFile },
        })
        this.database.audit('artifact', 'undo_change', `已撤销 ${basename(path)} 的 Agent 变更`, { actor: 'user', outcome: 'succeeded', target: path }, run.id)
        return { restored: true as const, path, createdFileRemoved: createdFile }
      },
    }
  }

  private appInfo() { return { name: 'DeskForge', version: app.getVersion(), platform: process.platform, arch: process.arch, locale: app.getLocale() || 'zh-CN' } }
  async completeOAuthCallback(callbackUrl: string): Promise<void> {
    const state = new URL(callbackUrl).searchParams.get('state')
    if (!state) throw new Error('OAuth 回调缺少 state')
    const id = this.oauthServerByState.get(state)
    if (!id) throw new Error('OAuth 回调已失效或不属于当前应用会话')
    await this.completeOAuth(id, callbackUrl, state)
  }

  private async completeOAuth(id: string, callbackUrl: string, state: string): Promise<any> {
    await this.oauth.completeOAuth(id, callbackUrl, state)
    this.oauthServerByState.delete(state)
    this.database.updateMcpHealth(id, 'unknown')
    this.database.audit('mcp', 'oauth_complete', 'MCP OAuth 授权完成', { actor: 'user', outcome: 'succeeded', target: id })
    return presentMcp(this.database.listMcpServers().find((server) => server.id === id))
  }

  private workspaceRootFor(workspaceId?: string): string | undefined {
    const workspace = workspaceId ? this.database.getWorkspace(workspaceId) : this.database.listWorkspaces()[0]
    return typeof workspace?.root_path === 'string' ? workspace.root_path : undefined
  }

  private async confirmSkillImport(selectionId: string) {
    const manifest = await this.skillImports.confirm(selectionId)
    const removedBundled = this.database.getSetting<string[]>(REMOVED_BUNDLED_SKILLS_SETTING, [])
    if (Array.isArray(removedBundled) && removedBundled.includes(manifest.name)) {
      this.database.setSetting(REMOVED_BUNDLED_SKILLS_SETTING, removedBundled.filter((name) => name !== manifest.name) as any)
    }
    const source = manifest.source
    this.database.audit('skill', 'import', `已导入 Skill ${manifest.name}@${manifest.version}`, {
      actor: 'user', outcome: 'succeeded', target: manifest.id, name: manifest.name, version: manifest.version,
      source: source?.kind === 'git' ? { kind: 'git', url: source.url, ...(source.ref ? { ref: source.ref } : {}), ...(source.subpath ? { subpath: source.subpath } : {}), ...(source.commit ? { commit: source.commit } : {}) } : { kind: source?.kind ?? 'folder' },
    })
    return manifest
  }

  private decodeSecret(value: string): Record<string, unknown> | string {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : value
    } catch { return value }
  }
  private installedCapabilityPackages(): InstalledCapabilityPackage[] {
    const value = this.database.getSetting<unknown>('installedCapabilityPackages', [])
    return Array.isArray(value) ? value as InstalledCapabilityPackage[] : []
  }
  private capabilityFingerprint(parsed: ParsedCapabilityPackage): string {
    return createHash('sha256').update(JSON.stringify(parsed.files.map((file) => [file.relativePath, file.sha256]))).digest('hex')
  }
  private presentCapabilityPreview(selectionId: string, parsed: ParsedCapabilityPackage): any {
    return {
      selectionId,
      name: parsed.manifest.name,
      version: parsed.manifest.version,
      directory: parsed.rootDirectory,
      skills: parsed.skills.map((skill) => skill.relativePath),
      mcpConfigs: parsed.mcpConfigs.map((entry) => entry.config),
      rules: parsed.rules.map((entry) => entry.relativePath),
      templates: parsed.templates.map((entry) => ({ path: entry.relativePath, size: entry.size, sha256: entry.sha256 })),
      fileCount: parsed.files.length,
      totalBytes: parsed.totalBytes,
    }
  }
  private snapshotProfile(row: any): ModelProfile {
    const snapshot = row.modelSnapshot ?? {}
    return {
      id: snapshot.profileId ?? row.modelProfileId ?? 'deleted-profile',
      name: '任务模型快照',
      provider: snapshot.provider ?? 'deepseek',
      modelId: snapshot.modelId ?? 'unknown',
      baseUrl: snapshot.baseUrl ?? 'https://api.deepseek.com/v1',
      capabilities: snapshot.capabilities ?? { contextWindow: 128_000, maxOutputTokens: 8_192, toolCalling: true, vision: false, reasoning: false, promptCaching: false },
      keyConfigured: false,
      isDefault: false,
      isSubagentDefault: false,
      createdAt: row.createdAt ?? new Date(0).toISOString(),
      updatedAt: row.updatedAt ?? new Date(0).toISOString(),
    }
  }
  private parseObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'string') return {}
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} }
  }
}
