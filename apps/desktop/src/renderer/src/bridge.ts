import type {
  ApprovalDiffLineView,
  ApprovalDiffView,
  ApprovalHistoryItem,
  ApprovalItem,
  AuditExportFormat,
  AuditFilters,
  AuditQueryView,
  SessionRuleItem,
  SessionSearchHitItem,
  SessionExportView,
  KnowledgeStatusItem,
  KnowledgeSearchView,
  EmbeddingsView,
  EmbeddingsInput,
  SessionRuleOffer,
  ArtifactItem,
  AutomationItem,
  CapabilityPackageItem,
  ChromeStatusView,
  DiffItem,
  EventItem,
  JsonRecord,
  McpServerItem,
  McpTestResult,
  McpToolItem,
  MemoryItem,
  ModelProvider,
  ModelProfileItem,
  PlanStepItem,
  PersistentGrantItem,
  RunDetailView,
  RunAccessMode,
  RunPermissionMode,
  RunItem,
  RunProgressItem,
  RunStatus,
  SourceItem,
  SettingsView,
  SkillImportFileItem,
  SkillImportPreviewItem,
  SkillItem,
  SkillOrigin,
  ToolActivityItem,
  RunTraceItem,
  TraceSpanItem,
  VerificationView,
  WorkbenchSnapshot,
  WorkspaceItem,
} from './types'

type UnknownFn = (...args: unknown[]) => unknown

interface LocatedMethod {
  fn: UnknownFn
  owner: JsonRecord
  path: string
}

const EMPTY_CHROME: ChromeStatusView = { connected: false, grants: [] }

function rootBridge(): JsonRecord {
  const value = (window as Window & { deskforge?: unknown }).deskforge
  if (!value || typeof value !== 'object') {
    throw new Error('桌面安全组件尚未就绪，请重启应用后再试。')
  }
  return value as unknown as JsonRecord
}

function locate(path: string): LocatedMethod | undefined {
  const parts = path.split('.')
  let owner = rootBridge()
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = owner[parts[index] ?? '']
    if (!next || typeof next !== 'object') return undefined
    owner = next as JsonRecord
  }
  const key = parts.at(-1) ?? ''
  const fn = owner[key]
  return typeof fn === 'function' ? { fn: fn as UnknownFn, owner, path } : undefined
}

async function call<T>(variants: Array<{ path: string; args?: unknown[] }>): Promise<T> {
  for (const variant of variants) {
    const method = locate(variant.path)
    if (!method) continue
    return await Promise.resolve(method.fn.apply(method.owner, variant.args ?? [])) as T
  }
  const names = variants.map((variant) => variant.path).join(' / ')
  throw new Error(`当前桌面桥不支持此操作（${names}）。请升级或重启应用。`)
}

async function optionalCall<T>(variants: Array<{ path: string; args?: unknown[] }>): Promise<T | undefined> {
  for (const variant of variants) {
    const method = locate(variant.path)
    if (!method) continue
    return await Promise.resolve(method.fn.apply(method.owner, variant.args ?? [])) as T
  }
  return undefined
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function textValue(source: JsonRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return fallback
}

function booleanValue(source: JsonRecord, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean') return value
  }
  return fallback
}

function numberValue(source: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function arrayValue(value: unknown, keys: string[] = ['items']): unknown[] {
  if (Array.isArray(value)) return value
  const source = record(value)
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key] as unknown[]
  }
  return []
}

function idValue(source: JsonRecord, fallbackPrefix: string, index: number): string {
  return textValue(source, ['id', 'runId', 'workspaceId', 'profileId', 'memoryId'], `${fallbackPrefix}-${index}`)
}

function normalizeWorkspace(value: unknown, index: number): WorkspaceItem {
  const source = record(value)
  const path = textValue(source, ['path', 'rootPath', 'directory'])
  return {
    ...source,
    id: idValue(source, 'workspace', index),
    name: textValue(source, ['name', 'title'], path.split('/').filter(Boolean).at(-1) ?? '未命名工作区'),
    path,
    selected: booleanValue(source, ['selected', 'isSelected']),
  }
}

const statuses = new Set<RunStatus>([
  'understanding', 'planning', 'running', 'verifying', 'completed', 'waiting_approval',
  'waiting_user', 'paused', 'failed', 'cancelled',
])

function normalizeRun(value: unknown, index: number): RunItem {
  const source = record(value)
  const rawStatus = textValue(source, ['status', 'state'], 'understanding') as RunStatus
  const status = statuses.has(rawStatus) ? rawStatus : 'understanding'
  const item: RunItem = {
    ...source,
    id: idValue(source, 'run', index),
    title: textValue(source, ['title', 'name', 'goal', 'prompt'], '新工作'),
    status,
  }
  const prompt = textValue(source, ['prompt', 'request'])
  const goal = textValue(source, ['goal', 'objective'])
  const workspaceId = textValue(source, ['workspaceId', 'workspace_id'])
  const modelProfileId = textValue(source, ['modelProfileId', 'model_profile_id']) || textValue(record(source.model), ['profileId'])
  const accessMode: RunAccessMode = 'approval'
  const permissionMode: RunPermissionMode = textValue(source, ['permissionMode', 'permission_mode'], 'approval') === 'workspace_auto' ? 'workspace_auto' : 'approval'
  const createdAt = textValue(source, ['createdAt', 'created_at'])
  const updatedAt = textValue(source, ['updatedAt', 'updated_at'])
  const result = textValue(source, ['result', 'outcome', 'completionStatus'])
  if (prompt) item.prompt = prompt
  if (goal) item.goal = goal
  if (workspaceId) item.workspaceId = workspaceId
  if (modelProfileId) item.modelProfileId = modelProfileId
  item.accessMode = accessMode
  item.permissionMode = permissionMode
  if (createdAt) item.createdAt = createdAt
  if (updatedAt) item.updatedAt = updatedAt
  if (result === 'verified' || result === 'partial') item.result = result
  return item
}

function normalizeModel(value: unknown, index: number): ModelProfileItem {
  const source = record(value)
  const rawProvider = textValue(source, ['provider'], 'deepseek')
  const provider: ModelProvider = rawProvider === 'kimi' || rawProvider === 'tongyi' || rawProvider === 'custom' || rawProvider === 'deepseek'
    ? rawProvider
    : 'custom'
  const providerName = provider === 'deepseek' ? 'DeepSeek' : provider === 'kimi' ? 'Kimi' : provider === 'tongyi' ? '通义' : '自定义'
  const baseUrl = textValue(source, ['baseUrl', 'base_url'])
  return {
    ...source,
    id: idValue(source, 'model', index),
    name: textValue(source, ['name', 'label'], providerName),
    provider,
    modelId: textValue(source, ['modelId', 'model', 'model_id']),
    ...(baseUrl ? { baseUrl } : {}),
    isDefault: booleanValue(source, ['isDefault', 'default']),
    isSubagentDefault: booleanValue(source, ['isSubagentDefault', 'subagentDefault']),
    hasSecret: booleanValue(source, ['hasSecret', 'secretConfigured', 'keyConfigured']),
  }
}

function normalizeMemory(value: unknown, index: number): MemoryItem {
  const source = record(value)
  const rawStatus = textValue(source, ['status', 'state'], 'proposed')
  const rawScope = textValue(source, ['scope'], 'user')
  const status = rawStatus === 'confirmed' || rawStatus === 'disabled' ? rawStatus : 'proposed'
  const scope = rawScope === 'workspace' || rawScope === 'thread' ? rawScope : 'user'
  const item: MemoryItem = {
    ...source,
    id: idValue(source, 'memory', index),
    content: textValue(source, ['content', 'text', 'summary']),
    status,
    scope,
  }
  const confidence = numberValue(source, ['confidence'])
  const kind = textValue(source, ['kind', 'type'])
  const sources = arrayValue(source.sources)
  const firstSource = record(sources[0])
  const origin = textValue(source, ['source', 'sourceLabel']) || textValue(firstSource, ['reference'])
  const createdAt = textValue(source, ['createdAt', 'created_at'])
  if (confidence !== undefined) item.confidence = confidence
  if (kind) item.kind = kind
  if (origin) item.source = origin
  if (createdAt) item.createdAt = createdAt
  return item
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function connectedVia(value: unknown): McpServerItem['connectedVia'] {
  return value === 'stdio' || value === 'streamable_http' || value === 'sse' ? value : undefined
}

export function normalizeMcpTool(value: unknown): McpToolItem | undefined {
  const source = record(value)
  const name = textValue(source, ['name'])
  if (!name) return undefined
  const tool: McpToolItem = { name, enabled: booleanValue(source, ['enabled'], true) }
  const title = textValue(source, ['title'])
  const description = textValue(source, ['description'])
  if (title) tool.title = title
  if (description) tool.description = description
  if (source.readOnlyHint === true) tool.readOnlyHint = true
  if (source.destructiveHint === true) tool.destructiveHint = true
  return tool
}

export function normalizeMcp(value: unknown, index: number): McpServerItem {
  const source = record(value)
  const transportSource = record(source.transport)
  const rawTransport = textValue(source, ['type']) || textValue(transportSource, ['type'], 'stdio')
  const item: McpServerItem = {
    ...source,
    id: idValue(source, 'mcp', index),
    name: textValue(source, ['name', 'label'], 'MCP Server'),
    transport: rawTransport === 'http' || rawTransport === 'streamable-http' || rawTransport === 'streamable_http' ? 'http' : 'stdio',
    enabled: booleanValue(source, ['enabled'], true),
  }
  const command = textValue(source, ['command']) || textValue(transportSource, ['command'])
  const url = textValue(source, ['url', 'endpoint']) || textValue(transportSource, ['url'])
  const health = textValue(source, ['health'])
  const status = textValue(source, ['status']) || (health === 'healthy' ? 'connected' : health === 'unhealthy' ? 'error' : 'stopped')
  const tools = arrayValue(source.tools).map(normalizeMcpTool).filter((tool): tool is McpToolItem => Boolean(tool))
  const toolCount = numberValue(source, ['toolCount', 'toolsCount']) ?? (Array.isArray(source.tools) ? tools.length : undefined)
  const auth = textValue(transportSource, ['auth'])
  const namespace = textValue(source, ['toolNamespace'])
  const cwdMode = textValue(transportSource, ['cwdMode'])
  const cwd = textValue(transportSource, ['cwd'])
  const via = connectedVia(source.connectedVia)
  const lastError = textValue(record(source.lastError), ['message']) || textValue(source, ['lastError'])
  const serverVersion = textValue(source, ['serverVersion'])
  const lastCheckedAt = textValue(source, ['lastCheckedAt'])
  if (namespace) item.toolNamespace = namespace
  if (command) item.command = command
  if (url) item.url = url
  if (status === 'connected' || status === 'stopped' || status === 'error' || status === 'testing') item.status = status
  if (toolCount !== undefined) item.toolCount = toolCount
  if (Array.isArray(source.tools)) item.tools = tools
  if (auth === 'none' || auth === 'bearer' || auth === 'headers' || auth === 'oauth') item.auth = auth
  if (item.transport === 'stdio') {
    item.args = stringList(transportSource.args)
    item.env = stringRecord(transportSource.env)
    item.envKeys = stringList(transportSource.envKeys)
    item.cwdMode = cwdMode === 'workspace' || cwdMode === 'custom' ? cwdMode : 'isolated'
    if (cwd) item.cwd = cwd
  } else {
    item.headers = stringRecord(transportSource.headers)
    item.secretHeaderKeys = stringList(transportSource.secretHeaderKeys)
    item.sseFallback = booleanValue(transportSource, ['sseFallback'], true)
  }
  if (via) item.connectedVia = via
  if (lastError) item.lastError = lastError
  if (serverVersion) item.serverVersion = serverVersion
  if (lastCheckedAt) item.lastCheckedAt = lastCheckedAt
  item.secretConfigured = booleanValue(transportSource, ['secretConfigured'])
  return item
}

export function normalizeMcpTest(value: unknown): McpTestResult {
  const source = record(value)
  const result: McpTestResult = {
    ok: source.ok === true,
    tools: arrayValue(source.tools).map(normalizeMcpTool).filter((tool): tool is McpToolItem => Boolean(tool)),
  }
  const latency = numberValue(source, ['latencyMs'])
  const toolCount = numberValue(source, ['toolCount'])
  const via = connectedVia(source.connectedVia)
  const version = textValue(source, ['serverVersion'])
  const error = textValue(record(source.error), ['message']) || textValue(source, ['error'])
  if (latency !== undefined) result.latencyMs = latency
  if (toolCount !== undefined) result.toolCount = toolCount
  if (via) result.connectedVia = via
  if (version) result.serverVersion = version
  if (!result.ok) result.error = error || 'MCP 连接测试失败'
  return result
}

function normalizeSkillOrigin(value: unknown): SkillOrigin | undefined {
  const source = record(value)
  const kind = source.kind
  if (kind !== 'bundled' && kind !== 'folder' && kind !== 'git') return undefined
  const origin: SkillOrigin = { kind }
  for (const key of ['path', 'url', 'ref', 'subpath', 'commit', 'importedAt'] as const) {
    const text = textValue(source, [key])
    if (text) origin[key] = text
  }
  return origin
}

function permissionLabels(value: unknown): string[] {
  return arrayValue(value).map((entry) => {
    if (typeof entry === 'string') return entry
    return textValue(record(entry), ['capability', 'detail'])
  }).filter(Boolean)
}

export function normalizeSkill(value: unknown, index: number): SkillItem {
  const source = record(value)
  const item: SkillItem = {
    ...source,
    id: idValue(source, 'skill', index),
    name: textValue(source, ['name', 'title'], '未命名 Skill'),
    description: textValue(source, ['description', 'summary'], '暂无描述'),
    enabled: booleanValue(source, ['enabled', 'isEnabled'], true),
  }
  const origin = normalizeSkillOrigin(source.source)
  const location = textValue(source, ['source', 'path', 'directory'])
  const version = textValue(source, ['version'])
  if (origin) item.origin = origin
  else delete item.origin
  if (location) item.source = location
  else delete item.source
  if (version) item.version = version
  if (Array.isArray(source.permissions)) item.permissions = permissionLabels(source.permissions)
  return item
}

export function normalizeSkillPreview(value: unknown): SkillImportPreviewItem | undefined {
  const source = record(value)
  const selectionId = textValue(source, ['selectionId'])
  if (!selectionId) return undefined
  const files = arrayValue(source.files).map((entry): SkillImportFileItem | undefined => {
    const file = record(entry)
    const path = textValue(file, ['path'])
    if (!path) return undefined
    const kind = file.kind === 'entry' || file.kind === 'script' || file.kind === 'reference' ? file.kind : 'asset'
    return { path, size: numberValue(file, ['size']) ?? 0, kind }
  }).filter((file): file is SkillImportFileItem => Boolean(file))
  const replaces = record(source.replaces)
  const preview: SkillImportPreviewItem = {
    selectionId,
    origin: normalizeSkillOrigin(source.source) ?? { kind: 'folder' },
    name: textValue(source, ['name'], '未命名 Skill'),
    description: textValue(source, ['description']),
    version: textValue(source, ['version'], '0.0.0'),
    permissions: permissionLabels(source.permissions),
    instructionsPreview: textValue(source, ['instructionsPreview']),
    files,
    fileCount: numberValue(source, ['fileCount']) ?? files.length,
    totalBytes: numberValue(source, ['totalBytes']) ?? 0,
    scriptFiles: stringList(source.scriptFiles),
    warnings: stringList(source.warnings),
  }
  const expiresAt = textValue(source, ['expiresAt'])
  if (expiresAt) preview.expiresAt = expiresAt
  if (textValue(replaces, ['id'])) preview.replaces = { id: textValue(replaces, ['id']), version: textValue(replaces, ['version']), enabled: booleanValue(replaces, ['enabled'], true) }
  return preview
}

function normalizeAutomation(value: unknown, index: number): AutomationItem {
  const source = record(value)
  const item: AutomationItem = {
    ...source,
    id: idValue(source, 'automation', index),
    name: textValue(source, ['name', 'title'], '未命名自动化'),
    prompt: textValue(source, ['prompt', 'instruction', 'objective']),
    schedule: textValue(source, ['normalizedSchedule', 'cron', 'expression']) || textValue(record(source.schedule), ['expression', 'runAt']),
    enabled: booleanValue(source, ['enabled', 'isEnabled'], true),
  }
  const nextRunAt = textValue(source, ['nextRunAt', 'next_run_at'])
  const lastRunAt = textValue(source, ['lastRunAt', 'last_run_at'])
  const timezone = textValue(source, ['timezone', 'timeZone'])
  const status = textValue(source, ['status'])
  if (nextRunAt) item.nextRunAt = nextRunAt
  if (lastRunAt) item.lastRunAt = lastRunAt
  if (timezone) item.timezone = timezone
  if (status) item.status = status
  return item
}

function normalizeChrome(value: unknown): ChromeStatusView {
  const source = record(value)
  const grants = arrayValue(source.grants).map((value, index) => {
    const grant = record(value)
    const item: ChromeStatusView['grants'][number] = { id: idValue(grant, 'grant', index) }
    const runId = textValue(grant, ['runId'])
    const title = textValue(grant, ['title'])
    const url = textValue(grant, ['url'])
    const tabId = numberValue(grant, ['tabId'])
    if (runId) item.runId = runId
    if (title) item.title = title
    if (url) item.url = url
    if (tabId !== undefined) item.tabId = tabId
    return item
  })
  const result: ChromeStatusView = {
    ...source,
    connected: booleanValue(source, ['connected', 'bridgeConnected', 'isConnected']),
    extensionInstalled: booleanValue(source, ['extensionInstalled', 'installed']),
    nativeHostInstalled: booleanValue(source, ['nativeHostInstalled']),
    grants,
  }
  const extensionId = textValue(source, ['extensionId'])
  if (extensionId) result.extensionId = extensionId
  return result
}

function normalizeSettings(value: unknown): SettingsView {
  const source = record(value)
  return source as SettingsView
}

function normalizePersistentGrant(value: unknown, index: number): PersistentGrantItem {
  const source = record(value)
  const approved = record(source.approvedArguments)
  const rawTool = textValue(source, ['toolName'], 'file.write')
  const item: PersistentGrantItem = {
    ...source,
    id: idValue(source, 'persistent-grant', index),
    toolName: rawTool === 'file.edit' ? 'file.edit' : 'file.write',
    workspaceId: textValue(approved, ['workspaceId']),
    path: textValue(approved, ['path']),
  }
  const createdAt = textValue(source, ['createdAt'])
  const expiresAt = textValue(source, ['expiresAt'])
  if (createdAt) item.createdAt = createdAt
  if (expiresAt) item.expiresAt = expiresAt
  return item
}

function normalizeCapabilityPackage(value: unknown, index: number): CapabilityPackageItem {
  const source = record(value)
  const item: CapabilityPackageItem = {
    ...source,
    id: idValue(source, 'capability-package', index),
    name: textValue(source, ['name'], '本地能力包'),
    version: textValue(source, ['version'], '1.0.0'),
    skillIds: arrayValue(source.skillIds).filter((entry): entry is string => typeof entry === 'string'),
    mcpServerIds: arrayValue(source.mcpServerIds).filter((entry): entry is string => typeof entry === 'string'),
    ruleSources: arrayValue(source.ruleSources).filter((entry): entry is string => typeof entry === 'string'),
    templatePaths: arrayValue(source.templatePaths).filter((entry): entry is string => typeof entry === 'string'),
  }
  const workspaceId = textValue(source, ['workspaceId'])
  const installedAt = textValue(source, ['installedAt'])
  if (workspaceId) item.workspaceId = workspaceId
  if (installedAt) item.installedAt = installedAt
  return item
}

function section(snapshot: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (snapshot[key] !== undefined) return snapshot[key]
  }
  return undefined
}

export async function loadWorkbench(): Promise<WorkbenchSnapshot> {
  const rawBootstrap = await call<unknown>([{ path: 'bootstrap' }])
  const bootstrap = record(rawBootstrap)
  const results = await Promise.allSettled([
    optionalCall<unknown>([{ path: 'workspaces.list' }]),
    optionalCall<unknown>([{ path: 'runs.list' }]),
    optionalCall<unknown>([{ path: 'models.list' }]),
    optionalCall<unknown>([{ path: 'memory.list' }, { path: 'listMemory' }]),
    optionalCall<unknown>([{ path: 'mcp.list' }, { path: 'listMcpServers' }]),
    optionalCall<unknown>([{ path: 'skills.list' }, { path: 'listSkills' }]),
    optionalCall<unknown>([{ path: 'automations.list' }, { path: 'listAutomations' }]),
    optionalCall<unknown>([{ path: 'chrome.getStatus' }, { path: 'getChromeStatus' }]),
    optionalCall<unknown>([{ path: 'settings.get' }]),
    optionalCall<unknown>([{ path: 'app.getInfo' }]),
    optionalCall<unknown>([{ path: 'chrome.listGrants' }]),
    optionalCall<unknown>([{ path: 'permissions.listPersistent' }]),
    optionalCall<unknown>([{ path: 'capabilityPackages.list' }]),
  ])
  const settledValue = (index: number): unknown => {
    const result = results[index]
    return result?.status === 'fulfilled' ? result.value : undefined
  }
  const workspaceSource = settledValue(0) ?? section(bootstrap, ['workspaces'])
  const runSource = settledValue(1) ?? section(bootstrap, ['runs', 'recentRuns'])
  const modelSource = settledValue(2) ?? section(bootstrap, ['models', 'modelProfiles'])
  const memorySource = settledValue(3) ?? section(bootstrap, ['memory', 'memories'])
  const mcpSource = settledValue(4) ?? section(bootstrap, ['mcpServers', 'mcp'])
  const skillSource = settledValue(5) ?? section(bootstrap, ['skills'])
  const automationSource = settledValue(6) ?? section(bootstrap, ['automations'])
  const chromeSource = settledValue(7) ?? section(bootstrap, ['chrome', 'chromeStatus'])
  const settingsSource = settledValue(8) ?? section(bootstrap, ['settings'])
  const appInfoSource = settledValue(9) ?? section(bootstrap, ['appInfo', 'app'])
  const grantsSource = settledValue(10)
  const persistentGrantsSource = settledValue(11)
  const capabilityPackagesSource = settledValue(12)
  const normalizedChrome = chromeSource === undefined ? { ...EMPTY_CHROME, grants: [] } : normalizeChrome(chromeSource)
  if (grantsSource !== undefined) normalizedChrome.grants = normalizeChrome({ connected: normalizedChrome.connected, grants: arrayValue(grantsSource) }).grants
  const settings = normalizeSettings(settingsSource)
  if (typeof bootstrap.onboardingComplete === 'boolean') settings.onboardingCompleted = bootstrap.onboardingComplete

  return {
    workspaces: arrayValue(workspaceSource, ['items', 'workspaces']).map(normalizeWorkspace),
    runs: arrayValue(runSource, ['items', 'runs']).map(normalizeRun),
    models: arrayValue(modelSource, ['items', 'profiles', 'models']).map(normalizeModel),
    memory: arrayValue(memorySource, ['items', 'memories']).map(normalizeMemory),
    mcpServers: arrayValue(mcpSource, ['items', 'servers']).map(normalizeMcp),
    skills: arrayValue(skillSource, ['items', 'skills']).map(normalizeSkill),
    automations: arrayValue(automationSource, ['items', 'automations']).map(normalizeAutomation),
    chrome: normalizedChrome,
    settings,
    persistentGrants: arrayValue(persistentGrantsSource, ['items', 'grants']).map(normalizePersistentGrant),
    capabilityPackages: arrayValue(capabilityPackagesSource, ['items', 'packages']).map(normalizeCapabilityPackage),
    appInfo: record(appInfoSource),
  }
}

function normalizeStep(value: unknown, index: number): PlanStepItem {
  const source = record(value)
  const status = textValue(source, ['status'], 'pending')
  const item: PlanStepItem = {
    ...source,
    id: idValue(source, 'step', index),
    title: textValue(source, ['title', 'name', 'description'], `步骤 ${index + 1}`),
    status: status === 'running' || status === 'in_progress' ? 'running' : status === 'completed' ? 'completed' : status === 'failed' || status === 'blocked' ? 'failed' : 'pending',
  }
  const detail = textValue(source, ['detail', 'description'])
  if (detail && detail !== item.title) item.detail = detail
  return item
}

function normalizeEvent(value: unknown, index: number): EventItem {
  const source = record(value)
  const type = textValue(source, ['type', 'eventType'], 'info')
  const item: EventItem = {
    ...source,
    id: idValue(source, 'event', index),
    type,
    title: textValue(source, ['title', 'label'], type),
  }
  const content = textValue(source, ['content', 'message', 'summary', 'text'])
  const createdAt = textValue(source, ['createdAt', 'created_at', 'timestamp'])
  const level = textValue(source, ['level'])
  const actor = textValue(source, ['actor', 'role'])
  if (content) item.content = content
  if (createdAt) item.createdAt = createdAt
  if (level === 'success' || level === 'warning' || level === 'error' || level === 'info') item.level = level
  if (actor === 'assistant') item.actor = 'agent'
  else if (actor === 'user' || actor === 'agent' || actor === 'tool' || actor === 'system') item.actor = actor
  return item
}

function normalizeToolActivity(value: unknown, index: number): ToolActivityItem {
  const source = record(value)
  const rawStatus = textValue(source, ['status', 'state'], 'requested')
  const status: ToolActivityItem['status'] = rawStatus === 'waiting_approval' || rawStatus === 'running' || rawStatus === 'succeeded' || rawStatus === 'failed' || rawStatus === 'cancelled'
    ? rawStatus
    : 'requested'
  const item: ToolActivityItem = {
    ...source,
    id: idValue(source, 'tool', index),
    toolName: textValue(source, ['toolName', 'toolId', 'name'], '工具调用'),
    status,
    sources: arrayValue(source.sources).map(normalizeSource).filter((item): item is SourceItem => Boolean(item)),
  }
  const title = textValue(source, ['title', 'label'])
  const argumentsSummary = source.argumentsSummary ?? source.arguments ?? source.args
  const argumentsValue = record(argumentsSummary)
  const summary = textValue(source, ['summary', 'content', 'resultSummary'])
  const error = typeof source.error === 'string' ? source.error : textValue(record(source.error), ['message'])
  const createdAt = textValue(source, ['createdAt', 'created_at', 'timestamp'])
  const updatedAt = textValue(source, ['updatedAt', 'updated_at', 'finishedAt'])
  if (title) item.title = title
  if (Object.keys(argumentsValue).length) item.arguments = argumentsValue
  if (argumentsSummary !== undefined) item.argumentsSummary = argumentsSummary
  if (summary) item.summary = summary
  if (error) item.error = error
  if (createdAt) item.createdAt = createdAt
  if (updatedAt) item.updatedAt = updatedAt
  return item
}

function normalizeSource(value: unknown, index: number): SourceItem | undefined {
  const source = typeof value === 'string' ? { url: value } : record(value)
  const url = textValue(source, ['url', 'href', 'sourceUrl'])
  if (!/^https?:\/\//i.test(url)) return undefined
  const rawStatus = textValue(source, ['status'], 'found')
  const status: SourceItem['status'] = rawStatus === 'fetched' || rawStatus === 'verified' || rawStatus === 'failed' ? rawStatus : 'found'
  const item: SourceItem = { ...source, id: idValue(source, 'source', index), url, status }
  const title = textValue(source, ['title', 'name'])
  const publisher = textValue(source, ['publisher', 'siteName', 'domain'])
  const createdAt = textValue(source, ['createdAt', 'created_at', 'fetchedAt'])
  if (title) item.title = title
  if (publisher) item.publisher = publisher
  if (createdAt) item.createdAt = createdAt
  return item
}

function normalizeVerification(value: unknown): VerificationView | undefined {
  const source = record(value)
  const rawStatus = textValue(source, ['status', 'result', 'outcome'])
  if (rawStatus !== 'verified' && rawStatus !== 'partial') return undefined
  const checks = arrayValue(source.checks).map((value) => {
    const check = record(value)
    const rawCheckStatus = textValue(check, ['status'], 'not_run')
    const status: VerificationView['checks'][number]['status'] = rawCheckStatus === 'passed' || rawCheckStatus === 'failed' ? rawCheckStatus : 'not_run'
    return {
      ...check,
      name: textValue(check, ['name', 'title'], '验证项'),
      status,
      ...(textValue(check, ['detail', 'summary']) ? { detail: textValue(check, ['detail', 'summary']) } : {}),
    }
  })
  const summary = textValue(source, ['summary', 'detail'])
  return { ...source, status: rawStatus, checks, ...(summary ? { summary } : {}) }
}

function normalizeProgress(value: unknown): RunProgressItem | undefined {
  const source = record(value)
  const phaseValue = textValue(source, ['phase'], 'thinking')
  const phase: RunProgressItem['phase'] = phaseValue === 'composing_tool' || phaseValue === 'executing' || phaseValue === 'verifying'
    ? phaseValue
    : 'thinking'
  const message = textValue(source, ['message', 'summary'])
  if (!message) return undefined
  const item: RunProgressItem = { ...source, phase, message }
  const toolName = textValue(source, ['toolName', 'tool'])
  const generatedChars = numberValue(source, ['generatedChars'])
  const updatedAt = textValue(source, ['updatedAt', 'updated_at'])
  if (toolName) item.toolName = toolName
  if (generatedChars !== undefined) item.generatedChars = generatedChars
  if (updatedAt) item.updatedAt = updatedAt
  return item
}

export function normalizeApprovalDiff(value: unknown): ApprovalDiffView | undefined {
  const source = record(value)
  const path = textValue(source, ['path'])
  const operation = textValue(source, ['operation'])
  if (!path || (operation !== 'create' && operation !== 'modify' && operation !== 'delete')) return undefined
  const hunks = arrayValue(source.hunks, []).map((hunkValue) => {
    const hunk = record(hunkValue)
    return {
      oldStart: numberValue(hunk, ['oldStart']) ?? 0,
      oldLines: numberValue(hunk, ['oldLines']) ?? 0,
      newStart: numberValue(hunk, ['newStart']) ?? 0,
      newLines: numberValue(hunk, ['newLines']) ?? 0,
      lines: arrayValue(hunk.lines, []).map((lineValue) => {
        const line = record(lineValue)
        const kind: ApprovalDiffLineView['kind'] = line.kind === 'add' || line.kind === 'del' ? line.kind : 'context'
        const oldLine = numberValue(line, ['oldLine'])
        const newLine = numberValue(line, ['newLine'])
        return { kind, text: typeof line.text === 'string' ? line.text : '', ...(oldLine !== undefined ? { oldLine } : {}), ...(newLine !== undefined ? { newLine } : {}) }
      }),
    }
  })
  const note = textValue(source, ['note'])
  return {
    path,
    operation,
    additions: numberValue(source, ['additions']) ?? 0,
    deletions: numberValue(source, ['deletions']) ?? 0,
    hunks,
    text: textValue(source, ['text']),
    truncated: booleanValue(source, ['truncated']),
    omittedLines: numberValue(source, ['omittedLines']) ?? 0,
    binary: booleanValue(source, ['binary']),
    tooLarge: booleanValue(source, ['tooLarge']),
    ...(note ? { note } : {}),
  }
}

function normalizeSessionOffer(value: unknown): SessionRuleOffer | undefined {
  const source = record(value)
  if (typeof source.eligible !== 'boolean') return undefined
  const label = textValue(source, ['label'])
  const reason = textValue(source, ['reason'])
  return { eligible: source.eligible, ...(label ? { label } : {}), ...(reason ? { reason } : {}) }
}

export function normalizeSessionRule(value: unknown, index: number): SessionRuleItem {
  const source = record(value)
  const runTitle = textValue(source, ['runTitle'])
  const commandPrefix = textValue(source, ['commandPrefix'])
  const lastUsedAt = textValue(source, ['lastUsedAt'])
  return {
    id: idValue(source, 'session-rule', index),
    runId: textValue(source, ['runId']),
    ...(runTitle ? { runTitle } : {}),
    kind: source.kind === 'shell_prefix' ? 'shell_prefix' : 'tool',
    toolName: textValue(source, ['toolName']),
    riskLevel: textValue(source, ['riskLevel'], 'reversible_write'),
    ...(commandPrefix ? { commandPrefix } : {}),
    label: textValue(source, ['label'], '会话规则'),
    useCount: numberValue(source, ['useCount']) ?? 0,
    createdAt: textValue(source, ['createdAt']),
    ...(lastUsedAt ? { lastUsedAt } : {}),
  }
}

export function normalizeSessionHit(value: unknown): SessionSearchHitItem {
  const source = record(value)
  return {
    runId: textValue(source, ['runId']),
    title: textValue(source, ['title'], '未命名会话'),
    workspaceId: textValue(source, ['workspaceId']),
    status: textValue(source, ['status'], 'completed') as RunStatus,
    updatedAt: textValue(source, ['updatedAt']),
    matchedIn: source.matchedIn === 'title' ? 'title' : 'message',
    snippet: textValue(source, ['snippet']),
  }
}

const KNOWLEDGE_STATES = new Set(['empty', 'indexing', 'ready', 'error'])

export function normalizeKnowledgeStatus(value: unknown): KnowledgeStatusItem {
  const source = record(value)
  const skipped = record(source.skipped)
  const embeddings = record(source.embeddings)
  const lastRun = record(source.lastRun)
  const count = (from: JsonRecord, key: string) => numberValue(from, [key]) ?? 0
  const optionalText = (key: string) => (typeof source[key] === 'string' && source[key] ? { [key]: source[key] as string } : {})
  return {
    workspaceId: textValue(source, ['workspaceId']),
    workspaceName: textValue(source, ['workspaceName'], '工作区'),
    rootPath: textValue(source, ['rootPath']),
    state: (KNOWLEDGE_STATES.has(String(source.state)) ? source.state : 'empty') as KnowledgeStatusItem['state'],
    fileCount: count(source, 'fileCount'),
    chunkCount: count(source, 'chunkCount'),
    indexedBytes: count(source, 'indexedBytes'),
    storageBytes: count(source, 'storageBytes'),
    ...optionalText('indexedAt'), ...optionalText('limitReason'), ...optionalText('error'),
    ...(typeof source.lastDurationMs === 'number' ? { lastDurationMs: source.lastDurationMs } : {}),
    ...(source.lastRun ? { lastRun: { added: count(lastRun, 'added'), updated: count(lastRun, 'updated'), unchanged: count(lastRun, 'unchanged'), removed: count(lastRun, 'removed') } } : {}),
    skipped: { ignored: count(skipped, 'ignored'), symlinks: count(skipped, 'symlinks'), unsupported: count(skipped, 'unsupported'), sensitive: count(skipped, 'sensitive'), tooLarge: count(skipped, 'tooLarge'), binary: count(skipped, 'binary'), unreadable: count(skipped, 'unreadable') },
    truncated: booleanValue(source, ['truncated']),
    embeddings: {
      enabled: booleanValue(embeddings, ['enabled']),
      embeddedChunks: count(embeddings, 'embeddedChunks'),
      ...(textValue(embeddings, ['model']) ? { model: textValue(embeddings, ['model']) } : {}),
      ...(textValue(embeddings, ['error']) ? { error: textValue(embeddings, ['error']) } : {}),
    },
  }
}

export function normalizeKnowledgeSearch(value: unknown): KnowledgeSearchView {
  const source = record(value)
  const note = textValue(source, ['note'])
  return {
    query: textValue(source, ['query']),
    state: (KNOWLEDGE_STATES.has(String(source.state)) ? source.state : 'empty') as KnowledgeSearchView['state'],
    mode: source.mode === 'hybrid' ? 'hybrid' : 'keyword',
    results: arrayValue(source.results, []).map((itemValue) => {
      const item = record(itemValue)
      return {
        path: textValue(item, ['path']),
        startLine: numberValue(item, ['startLine']) ?? 1,
        endLine: numberValue(item, ['endLine']) ?? 1,
        snippet: textValue(item, ['snippet']),
        score: numberValue(item, ['score']) ?? 0,
        matchedBy: item.matchedBy === 'semantic' || item.matchedBy === 'hybrid' ? item.matchedBy : 'keyword',
      }
    }),
    ...(note ? { note } : {}),
  }
}

export function normalizeEmbeddings(value: unknown): EmbeddingsView {
  const source = record(value)
  const preset = ['dashscope-v4', 'dashscope-v3', 'openai-3-small', 'custom'].includes(String(source.preset)) ? source.preset as EmbeddingsView['preset'] : 'dashscope-v4'
  const acknowledgedAt = textValue(source, ['acknowledgedAt'])
  const dimensions = numberValue(source, ['dimensions'])
  return {
    enabled: booleanValue(source, ['enabled']),
    preset,
    baseUrl: textValue(source, ['baseUrl']),
    model: textValue(source, ['model']),
    ...(dimensions ? { dimensions } : {}),
    hasKey: booleanValue(source, ['hasKey']),
    ...(acknowledgedAt ? { acknowledgedAt } : {}),
    secureStorage: booleanValue(source, ['secureStorage'], true),
  }
}

export function normalizeAuditQuery(value: unknown): AuditQueryView {
  const source = record(value)
  const chain = record(source.chain)
  const strings = (input: unknown): string[] => arrayValue(input, []).filter((item): item is string => typeof item === 'string')
  return {
    items: arrayValue(source.items, []).map((itemValue, index) => {
      const item = record(itemValue)
      const chainStatus = item.chain === 'ok' || item.chain === 'broken' || item.chain === 'unlinked' ? item.chain : 'legacy' as const
      const optional = (key: string) => (typeof item[key] === 'string' && item[key] ? { [key]: item[key] as string } : {})
      return {
        id: idValue(item, 'audit', index),
        category: textValue(item, ['category'], 'unknown'),
        action: textValue(item, ['action'], '—'),
        summary: textValue(item, ['summary']),
        payload: item.payload ?? {},
        chain: chainStatus,
        createdAt: textValue(item, ['createdAt']),
        ...optional('runId'), ...optional('actor'), ...optional('outcome'), ...optional('riskLevel'), ...optional('target'),
        ...optional('ruleId'), ...optional('ruleLabel'), ...optional('prevHash'), ...optional('entryHash'),
      }
    }),
    total: numberValue(source, ['total']) ?? 0,
    truncated: booleanValue(source, ['truncated']),
    categories: strings(source.categories),
    runs: arrayValue(source.runs, []).map((runValue) => { const run = record(runValue); return { id: textValue(run, ['id']), title: textValue(run, ['title'], '工作') } }).filter((run) => run.id),
    chain: {
      valid: chain.valid !== false,
      checkedEntries: numberValue(chain, ['checkedEntries']) ?? 0,
      hashedEntries: numberValue(chain, ['hashedEntries']) ?? 0,
      legacyEntries: numberValue(chain, ['legacyEntries']) ?? 0,
      brokenIds: strings(chain.brokenIds),
      linkBreakIds: strings(chain.linkBreakIds),
      checkedAt: textValue(chain, ['checkedAt']),
    },
  }
}

function normalizeApproval(value: unknown, index: number): ApprovalItem {
  const source = record(value)
  const rawRisk = textValue(source, ['risk', 'riskLevel'], 'reversible_write')
  const risk = rawRisk === 'external_effect' || rawRisk === 'external_side_effect'
    ? 'external_effect'
    : rawRisk === 'irreversible' || rawRisk === 'high_risk_irreversible'
      ? 'irreversible'
      : 'reversible_write'
  const item: ApprovalItem = {
    ...source,
    id: idValue(source, 'approval', index),
    title: textValue(source, ['title', 'toolName', 'action'], '需要批准的操作'),
    summary: textValue(source, ['summary', 'description', 'reason', 'target']),
    risk,
    reversible: booleanValue(source, ['reversible'], risk === 'reversible_write'),
  }
  const args = record(source.arguments ?? source.args)
  if (Object.keys(args).length) item.arguments = args
  const sendsData = arrayValue(source.sendsData).filter((entry): entry is string => typeof entry === 'string')
  const dataShared = textValue(source, ['dataShared', 'externalData']) || sendsData.join('、')
  const status = textValue(source, ['status'])
  if (dataShared) item.dataShared = dataShared
  if (status === 'pending' || status === 'approved' || status === 'rejected') item.status = status
  const diff = normalizeApprovalDiff(source.diff)
  if (diff) item.diff = diff
  else delete item.diff
  const sessionRule = normalizeSessionOffer(source.sessionRule)
  if (sessionRule) item.sessionRule = sessionRule
  else delete item.sessionRule
  return item
}

function normalizeApprovalHistory(value: unknown, index: number): ApprovalHistoryItem {
  const source = record(value)
  const rawStatus = textValue(source, ['status'], 'pending')
  const status: ApprovalHistoryItem['status'] = rawStatus === 'approved' || rawStatus === 'rejected' || rawStatus === 'edited' ? rawStatus : 'pending'
  const item: ApprovalHistoryItem = {
    ...source,
    id: idValue(source, 'approval-history', index),
    title: textValue(source, ['title', 'toolName', 'action'], '操作审批'),
    summary: textValue(source, ['summary', 'reason', 'target']),
    status,
  }
  const scope = textValue(source, ['scope'])
  const createdAt = textValue(source, ['createdAt', 'created_at'])
  const resolvedAt = textValue(source, ['resolvedAt', 'resolved_at'])
  if (scope === 'once' || scope === 'run_tool' || scope === 'session') item.scope = scope
  if (createdAt) item.createdAt = createdAt
  if (resolvedAt) item.resolvedAt = resolvedAt
  return item
}

function normalizeArtifact(value: unknown, index: number): ArtifactItem {
  const source = record(value)
  const item: ArtifactItem = {
    ...source,
    id: idValue(source, 'artifact', index),
    name: textValue(source, ['name', 'filename', 'path', 'displayName'], '输出'),
  }
  const kind = textValue(source, ['kind', 'type'])
  const metadata = record(source.metadata)
  const path = textValue(source, ['path']) || textValue(metadata, ['path'])
  const size = numberValue(source, ['size', 'sizeBytes', 'byteLength'])
  if (kind) item.kind = kind
  if (path) item.path = path
  if (size !== undefined) item.size = size
  return item
}

function normalizeDiff(value: unknown, index: number): DiffItem {
  const source = record(value)
  const item: DiffItem = {
    ...source,
    id: idValue(source, 'diff', index),
    path: textValue(source, ['path', 'filePath'], '未知文件'),
  }
  const additions = numberValue(source, ['additions', 'added'])
  const deletions = numberValue(source, ['deletions', 'removed'])
  if (additions !== undefined) item.additions = additions
  if (deletions !== undefined) item.deletions = deletions
  return item
}

const TRACE_STATUSES = new Set<TraceSpanItem['status']>(['running', 'succeeded', 'failed', 'cancelled', 'waiting', 'interrupted'])
const TRACE_KINDS = new Set<TraceSpanItem['kind']>(['run_turn', 'context_stage', 'model_turn', 'tool_call', 'approval_wait', 'checkpoint', 'verification', 'managed_process'])

function normalizeRunTrace(value: unknown, index: number): RunTraceItem {
  const source = record(value)
  const status = textValue(source, ['status']) as RunTraceItem['status']
  const item: RunTraceItem = {
    ...source,
    id: idValue(source, 'trace', index),
    rootSpanId: textValue(source, ['rootSpanId', 'root_span_id']),
    status: TRACE_STATUSES.has(status) ? status : 'interrupted',
    startedAt: textValue(source, ['startedAt', 'started_at']),
    metadata: record(source.metadata),
  }
  const endedAt = textValue(source, ['endedAt', 'ended_at'])
  if (endedAt) item.endedAt = endedAt
  return item
}

function normalizeTraceSpan(value: unknown, index: number): TraceSpanItem {
  const source = record(value)
  const status = textValue(source, ['status']) as TraceSpanItem['status']
  const kind = textValue(source, ['kind']) as TraceSpanItem['kind']
  const item: TraceSpanItem = {
    ...source,
    id: idValue(source, 'span', index),
    traceId: textValue(source, ['traceId', 'trace_id']),
    kind: TRACE_KINDS.has(kind) ? kind : 'tool_call',
    name: textValue(source, ['name'], '执行阶段'),
    status: TRACE_STATUSES.has(status) ? status : 'interrupted',
    startedAt: textValue(source, ['startedAt', 'started_at']),
    attributes: record(source.attributes),
    artifactIds: arrayValue(source.artifactIds, ['items']).filter((item): item is string => typeof item === 'string'),
  }
  const parentSpanId = textValue(source, ['parentSpanId', 'parent_span_id'])
  const endedAt = textValue(source, ['endedAt', 'ended_at'])
  const durationMs = numberValue(source, ['durationMs', 'duration_ms'])
  if (parentSpanId) item.parentSpanId = parentSpanId
  if (endedAt) item.endedAt = endedAt
  if (durationMs !== undefined) item.durationMs = durationMs
  if (source.usage && typeof source.usage === 'object') item.usage = record(source.usage)
  if (source.error && typeof source.error === 'object') item.error = record(source.error)
  return item
}

export async function getRunDetail(runId: string, fallback?: RunItem): Promise<RunDetailView> {
  const raw = await optionalCall<unknown>([
    { path: 'runs.get', args: [{ id: runId }] },
    { path: 'getRun', args: [runId] },
  ])
  const source = record(raw ?? fallback)
  const base = normalizeRun(source.run ?? source, 0)
  const artifacts = arrayValue(section(source, ['artifacts', 'outputs']), ['items', 'artifacts']).map(normalizeArtifact)
  const explicitDiffs = arrayValue(section(source, ['diffs', 'changes']), ['items', 'diffs']).map(normalizeDiff)
  const artifactDiffs = artifacts.filter((artifact) => artifact.kind === 'diff').map((artifact, index) => {
    const metadata = record(artifact.metadata)
    return normalizeDiff({ id: artifact.id, path: artifact.path ?? artifact.name, additions: metadata.additions, deletions: metadata.deletions }, index)
  })
  const directSources = arrayValue(section(source, ['sources', 'evidenceSources']), ['items', 'sources'])
    .map(normalizeSource)
    .filter((item): item is SourceItem => Boolean(item))
  const verification = normalizeVerification(source.verification)
  const progress = normalizeProgress(source.progress)
  return {
    ...base,
    steps: arrayValue(section(source, ['steps', 'plan']), ['items', 'steps']).map(normalizeStep),
    events: arrayValue(section(source, ['events', 'timeline', 'messages']), ['items', 'events']).map(normalizeEvent),
    toolCalls: arrayValue(section(source, ['toolCalls', 'toolActivity']), ['items', 'toolCalls']).map(normalizeToolActivity),
    sources: directSources,
    approvals: arrayValue(section(source, ['approvals', 'pendingApprovals']), ['items', 'approvals']).map(normalizeApproval),
    approvalHistory: arrayValue(section(source, ['approvalHistory']), ['items', 'approvals']).map(normalizeApprovalHistory),
    artifacts,
    diffs: explicitDiffs.length ? explicitDiffs : artifactDiffs,
    context: arrayValue(section(source, ['context', 'contextItems']), ['items']).map(record),
    traces: arrayValue(section(source, ['traces']), ['items']).map(normalizeRunTrace),
    traceSpans: arrayValue(section(source, ['traceSpans']), ['items', 'spans']).map(normalizeTraceSpan),
    ...(verification ? { verification } : {}),
    ...(progress ? { progress } : {}),
  }
}

export const bridge = {
  createRun: (input: JsonRecord) => call<unknown>([
    { path: 'runs.create', args: [input] },
    { path: 'createRun', args: [input] },
  ]),
  sendMessage: (runId: string, content: string, accessMode: RunAccessMode, attachmentIds: string[] = [], permissionMode: RunPermissionMode = 'approval') => call<unknown>([
    { path: 'runs.sendMessage', args: [{ runId, content, accessMode, permissionMode, ...(attachmentIds.length ? { attachmentIds } : {}) }] },
    { path: 'sendMessage', args: [{ runId, content, accessMode, permissionMode, attachmentIds }] },
  ]),
  pauseRun: (runId: string) => call<unknown>([
    { path: 'runs.pause', args: [{ id: runId }] },
    { path: 'pauseRun', args: [runId] },
  ]),
  resumeRun: (runId: string) => call<unknown>([
    { path: 'runs.resume', args: [{ id: runId }] },
    { path: 'resumeRun', args: [runId] },
  ]),
  cancelRun: (runId: string) => call<unknown>([
    { path: 'runs.cancel', args: [{ id: runId }] },
    { path: 'cancelRun', args: [runId] },
  ]),
  removeRun: (runId: string) => call<unknown>([
    { path: 'runs.remove', args: [{ id: runId }] },
    { path: 'removeRun', args: [runId] },
  ]),
  searchRuns: async (query: string, workspaceId?: string) => arrayValue(await call<unknown>([
    { path: 'runs.search', args: [{ query, ...(workspaceId ? { workspaceId } : {}), limit: 30 }] },
  ]), []).map(normalizeSessionHit).filter((hit) => hit.runId),
  renameRun: (runId: string, title: string) => call<unknown>([
    { path: 'runs.rename', args: [{ id: runId, title }] },
  ]),
  exportRunMarkdown: async (runId: string): Promise<SessionExportView | null> => {
    const result = await call<unknown>([{ path: 'runs.exportMarkdown', args: [{ id: runId }] }])
    if (!result) return null
    const source = record(result)
    return { path: textValue(source, ['path']), bytes: numberValue(source, ['bytes']) ?? 0 }
  },
  knowledgeStatus: async () => arrayValue(await call<unknown>([{ path: 'knowledge.listStatus' }]), []).map(normalizeKnowledgeStatus),
  rebuildKnowledge: async (workspaceId: string, mode: 'incremental' | 'full') => normalizeKnowledgeStatus(await call<unknown>([
    { path: 'knowledge.rebuild', args: [{ workspaceId, mode }] },
  ])),
  clearKnowledge: async (workspaceId: string) => normalizeKnowledgeStatus(await call<unknown>([
    { path: 'knowledge.clear', args: [{ workspaceId }] },
  ])),
  searchKnowledge: async (workspaceId: string, query: string) => normalizeKnowledgeSearch(await call<unknown>([
    { path: 'knowledge.search', args: [{ workspaceId, query, limit: 8 }] },
  ])),
  getEmbeddings: async () => normalizeEmbeddings(await call<unknown>([{ path: 'knowledge.getEmbeddings' }])),
  setEmbeddings: async (input: EmbeddingsInput) => normalizeEmbeddings(await call<unknown>([{ path: 'knowledge.setEmbeddings', args: [input] }])),
  testEmbeddings: async () => {
    const source = record(await call<unknown>([{ path: 'knowledge.testEmbeddings' }]))
    const dimensions = numberValue(source, ['dimensions'])
    const error = textValue(source, ['error'])
    return { ok: source.ok === true, latencyMs: numberValue(source, ['latencyMs']) ?? 0, ...(dimensions ? { dimensions } : {}), ...(error ? { error } : {}) }
  },
  respondApproval: (input: JsonRecord) => call<unknown>([
    { path: 'runs.respondToApproval', args: [input] },
    { path: 'respondApproval', args: [input] },
  ]),
  chooseWorkspace: async () => {
    const chosen = await call<unknown>([
      { path: 'app.chooseWorkspace' },
      { path: 'pickWorkspace' },
    ])
    const source = record(chosen)
    return typeof chosen === 'string' ? chosen : textValue(source, ['path', 'rootPath'])
  },
  importAttachments: async (): Promise<ArtifactItem[]> => {
    const result = await call<unknown>([
      { path: 'app.importAttachments' },
      { path: 'importAttachments' },
    ])
    return arrayValue(result, ['items', 'artifacts']).map(normalizeArtifact)
  },
  addWorkspace: (path: string) => call<unknown>([
    { path: 'workspaces.create', args: [{ path }] },
    { path: 'addWorkspace', args: [path] },
  ]),
  selectWorkspace: (id: string) => call<unknown>([
    { path: 'workspaces.select', args: [{ id }] },
    { path: 'selectWorkspace', args: [id] },
  ]),
  updateWorkspace: (input: JsonRecord) => call<unknown>([
    { path: 'workspaces.update', args: [input] },
    { path: 'updateWorkspace', args: [input] },
  ]),
  removeWorkspace: (id: string) => call<unknown>([
    { path: 'workspaces.remove', args: [{ id }] },
    { path: 'removeWorkspace', args: [id] },
  ]),
  saveModel: (input: JsonRecord) => call<unknown>([
    { path: 'models.upsert', args: [input] },
    { path: 'saveModelProfile', args: [input] },
  ]),
  listModelCatalog: (provider: ModelProvider) => call<unknown>([
    { path: 'models.catalog', args: [{ provider }] },
  ]),
  setModelSecret: (input: JsonRecord) => call<unknown>([
    { path: 'models.setSecret', args: [input] },
    { path: 'setModelSecret', args: [input] },
  ]),
  testModel: (input: JsonRecord) => call<unknown>([
    { path: 'models.test', args: [input] },
    { path: 'testModelProfile', args: [input] },
  ]),
  testModelDraft: (input: JsonRecord) => call<unknown>([
    { path: 'models.testDraft', args: [input] },
  ]),
  setDefaultModel: (id: string) => call<unknown>([
    { path: 'models.setDefaults', args: [{ defaultModelProfileId: id }] },
    { path: 'setDefaultModelProfile', args: [id] },
  ]),
  setModelDefaults: (defaultModelProfileId: string, subagentModelProfileId?: string) => {
    const input: JsonRecord = { defaultModelProfileId }
    if (subagentModelProfileId) input.subagentModelProfileId = subagentModelProfileId
    return call<unknown>([
      { path: 'models.setDefaults', args: [input] },
      { path: 'setModelDefaults', args: [input] },
    ])
  },
  removeModel: (id: string) => call<unknown>([
    { path: 'models.remove', args: [{ id }] },
    { path: 'deleteModelProfile', args: [id] },
  ]),
  updateSettings: (input: JsonRecord) => call<unknown>([
    { path: 'settings.update', args: [input] },
    { path: 'updateSettings', args: [input] },
  ]),
  createPersistentGrant: (input: JsonRecord) => call<unknown>([
    { path: 'permissions.createPersistent', args: [input] },
  ]),
  chooseCapabilityPackage: () => call<unknown>([
    { path: 'capabilityPackages.choose' },
  ]),
  installCapabilityPackage: (selectionId: string, workspaceId?: string) => call<unknown>([
    { path: 'capabilityPackages.install', args: [{ selectionId, ...(workspaceId ? { workspaceId } : {}) }] },
  ]),
  removePersistentGrant: (id: string) => call<unknown>([
    { path: 'permissions.removePersistent', args: [{ id }] },
  ]),
  proposeMemory: (input: JsonRecord) => call<unknown>([
    { path: 'memory.propose', args: [input] },
    { path: 'proposeMemory', args: [input] },
  ]),
  updateMemory: (id: string, action: 'confirm' | 'disable' | 'remove') => {
    const grouped = action === 'remove' ? 'memory.remove' : `memory.${action}`
    return call<unknown>([
      { path: grouped, args: [{ id }] },
      { path: 'updateMemory', args: [id, action] },
    ])
  },
  saveMcp: (input: JsonRecord) => call<unknown>([
    { path: 'mcp.upsert', args: [input] },
    { path: 'saveMcpServer', args: [input] },
  ]),
  testMcp: async (input: { id: string; workspaceId?: string }) => normalizeMcpTest(await call<unknown>([
    { path: 'mcp.test', args: [input] },
    { path: 'testMcpServer', args: [input] },
  ])),
  setMcpEnabled: (id: string, enabled: boolean) => call<unknown>([
    { path: 'mcp.setEnabled', args: [{ id, enabled }] },
  ]),
  setMcpToolEnabled: (id: string, toolName: string, enabled: boolean) => call<unknown>([
    { path: 'mcp.setToolEnabled', args: [{ id, toolName, enabled }] },
  ]),
  chooseMcpCwd: async () => {
    const result = await call<unknown>([{ path: 'mcp.chooseCwd' }])
    return typeof result === 'string' && result ? result : undefined
  },
  removeMcp: (id: string) => call<unknown>([
    { path: 'mcp.remove', args: [{ id }] },
    { path: 'removeMcpServer', args: [id] },
  ]),
  authorizeMcp: (id: string) => call<unknown>([
    { path: 'mcp.startOAuth', args: [{ id }] },
    { path: 'startMcpOAuth', args: [id] },
  ]),
  previewSkillFolder: async () => normalizeSkillPreview(await call<unknown>([{ path: 'skills.previewFolder' }])),
  previewSkillGit: async (input: { url: string; ref?: string; subpath?: string }) => normalizeSkillPreview(await call<unknown>([
    { path: 'skills.previewGit', args: [input] },
  ])),
  previewSkillUpdate: async (id: string) => normalizeSkillPreview(await call<unknown>([
    { path: 'skills.previewUpdate', args: [{ id }] },
  ])),
  confirmSkillImport: (selectionId: string) => call<unknown>([
    { path: 'skills.confirmImport', args: [{ selectionId }] },
  ]),
  cancelSkillImport: (selectionId: string) => call<unknown>([
    { path: 'skills.cancelImport', args: [{ selectionId }] },
  ]),
  toggleSkill: (id: string, enabled: boolean) => call<unknown>([
    { path: 'skills.setEnabled', args: [{ id, enabled }] },
    { path: 'toggleSkill', args: [id, enabled] },
  ]),
  removeSkill: (id: string) => call<unknown>([
    { path: 'skills.remove', args: [{ id }] },
    { path: 'removeSkill', args: [id] },
  ]),
  saveAutomation: (input: JsonRecord) => call<unknown>([
    { path: 'automations.upsert', args: [input] },
    { path: 'saveAutomation', args: [input] },
  ]),
  toggleAutomation: (id: string, enabled: boolean) => call<unknown>([
    { path: 'automations.setEnabled', args: [{ id, enabled }] },
    { path: 'toggleAutomation', args: [id, enabled] },
  ]),
  runAutomation: (id: string) => call<unknown>([
    { path: 'automations.runNow', args: [{ id }] },
    { path: 'runAutomation', args: [id] },
  ]),
  removeAutomation: (id: string) => call<unknown>([
    { path: 'automations.remove', args: [{ id }] },
    { path: 'removeAutomation', args: [id] },
  ]),
  requestChromeBinding: (runId: string) => call<unknown>([
    { path: 'chrome.requestBinding', args: [{ runId }] },
    { path: 'requestChromeBinding', args: [runId] },
  ]),
  revokeChromeGrant: (id: string) => call<unknown>([
    { path: 'chrome.revokeGrant', args: [{ id }] },
    { path: 'revokeChromeGrant', args: [id] },
  ]),
  exportAudit: () => call<unknown>([
    { path: 'audit.exportDiagnostics' },
    { path: 'exportAudit' },
  ]),
  queryAudit: async (filters: AuditFilters = {}) => normalizeAuditQuery(await call<unknown>([
    { path: 'audit.query', args: [filters] },
  ])),
  exportAuditLog: (format: AuditExportFormat, filters: AuditFilters = {}) => call<unknown>([
    { path: 'audit.export', args: [{ ...filters, format }] },
  ]),
  listSessionRules: async (runId?: string) => arrayValue(await call<unknown>([
    { path: 'runs.listSessionRules', args: [runId ? { runId } : {}] },
  ]), []).map(normalizeSessionRule),
  revokeSessionRule: (id: string) => call<unknown>([
    { path: 'runs.revokeSessionRule', args: [{ id }] },
  ]),
  listAudit: () => call<unknown>([
    { path: 'audit.list', args: [{ limit: 100 }] },
    { path: 'listAudit', args: [{ limit: 100 }] },
  ]),
  revealArtifact: (id: string) => call<unknown>([
    { path: 'artifacts.reveal', args: [{ id }] },
    { path: 'revealArtifact', args: [id] },
  ]),
  openArtifact: (id: string) => call<{ success: boolean; error?: string }>([
    { path: 'artifacts.open', args: [{ id }] },
    { path: 'openArtifact', args: [id] },
  ]),
  revealPath: (path: string) => call<unknown>([
    { path: 'app.revealPath', args: [{ path }] },
    { path: 'revealPath', args: [path] },
  ]),
  openPath: (path: string) => call<{ success: boolean; error?: string }>([
    { path: 'app.openPath', args: [{ path }] },
    { path: 'openPath', args: [path] },
  ]),
  getArtifactText: (id: string, maxBytes = 2 * 1024 * 1024) => call<unknown>([
    { path: 'artifacts.getText', args: [{ id, maxBytes }] },
    { path: 'getArtifactText', args: [id, maxBytes] },
  ]),
  undoChange: (id: string) => call<unknown>([
    { path: 'artifacts.undoChange', args: [{ id }] },
    { path: 'undoArtifactChange', args: [id] },
  ]),
  subscribe(listener: (event: unknown) => void): () => void {
    try {
      const method = locate('events.subscribe') ?? locate('onEvent')
      if (!method) return () => undefined
      const unsubscribe = method.fn.call(method.owner, listener)
      return typeof unsubscribe === 'function' ? unsubscribe as () => void : () => undefined
    } catch {
      return () => undefined
    }
  },
}

export function resultId(value: unknown): string | undefined {
  const source = record(value)
  return textValue(source, ['id', 'runId']) || textValue(record(source.run), ['id', 'runId']) || undefined
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  const source = record(error)
  return textValue(source, ['message', 'error'], '操作失败，请重试。')
}
