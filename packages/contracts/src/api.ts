import { z } from 'zod'

import {
  AppSettingsSchema,
  ApprovalGrantSchema,
  ApprovalResponseSchema,
  ArtifactRefSchema,
  AuditEntrySchema,
  AutomationScheduleSchema,
  AutomationSpecSchema,
  BootstrapSnapshotSchema,
  ChromeBridgeStatusSchema,
  ChromeTabGrantSchema,
  IdSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  McpServerConfigSchema,
  McpToolSummarySchema,
  McpTransportInputSchema,
  SkillPermissionSchema,
  MemoryEntrySchema,
  ModelConnectionTestSchema,
  ModelConnectionDraftSchema,
  ProviderIdSchema,
  ModelProfileInputSchema,
  ModelProfileSchema,
  PageRequestSchema,
  RunDetailSchema,
  RunEventSchema,
  RunAccessModeSchema,
  RunPermissionModeSchema,
  RunLimitsSchema,
  RunSchema,
  RunStatusSchema,
  RunSummarySchema,
  SessionApprovalRuleSchema,
  SkillManifestSchema,
  WorkspaceSchema,
  WorkspaceFileItemSchema,
} from './schemas'
import type {
  AppSettings,
  ApprovalGrant,
  ApprovalResponse,
  ArtifactRef,
  AuditEntry,
  AutomationSchedule,
  AutomationSpec,
  BootstrapSnapshot,
  ChromeBridgeStatus,
  ChromeTabGrant,
  JsonValue,
  McpServerConfig,
  McpToolSummary,
  McpTransport,
  SkillPermission,
  MemoryEntry,
  MemoryScope,
  MemoryType,
  ModelConnectionTest,
  ModelConnectionDraft,
  ProviderId,
  ModelProfile,
  ModelProfileInput,
  Page,
  PageRequest,
  Run,
  RunAccessMode,
  RunPermissionMode,
  RunDetail,
  RunEvent,
  RunLimits,
  RunSummary,
  SessionApprovalRule,
  SkillManifest,
  Workspace,
  WorkspaceFileItem,
} from './types'

export const DESKTOP_API_VERSION = 1 as const

export interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  locale: string
}

export interface CreateWorkspaceInput {
  path: string
  name?: string
}

export interface UpdateWorkspaceInput {
  id: string
  name?: string
  rules?: string
}

export interface CreateRunInput {
  workspaceId: string
  objective: string
  accessMode?: RunAccessMode
  permissionMode?: RunPermissionMode
  mode?: 'plan' | 'execute'
  title?: string
  modelProfileId?: string
  attachmentIds?: string[]
  limits?: Partial<RunLimits>
}

export interface SendRunMessageInput {
  runId: string
  content: string
  accessMode?: RunAccessMode
  permissionMode?: RunPermissionMode
  attachmentIds?: string[]
}

export interface ModelDefaultsInput {
  defaultModelProfileId: string
  subagentModelProfileId?: string
}

export interface ModelCatalogItem {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  vision: boolean
  reasoning: boolean
}

export interface PersistentGrantInput {
  workspaceId: string
  toolName: 'file.write' | 'file.edit'
  path: string
  expiresAt?: string
}

export interface CapabilityPackagePreview {
  selectionId: string
  name: string
  version: string
  directory: string
  skills: string[]
  mcpConfigs: JsonValue[]
  rules: string[]
  templates: Array<{ path: string; size: number; sha256: string }>
  fileCount: number
  totalBytes: number
}

export interface InstalledCapabilityPackage {
  id: string
  name: string
  version: string
  workspaceId?: string
  skillIds: string[]
  mcpServerIds: string[]
  ruleSources: string[]
  templatePaths: string[]
  installedAt: string
}

export interface MemoryProposalInput {
  workspaceId?: string
  type: MemoryType
  scope: MemoryScope
  content: string
  confidence: number
  source: { kind: 'run' | 'message' | 'file' | 'user'; reference: string; excerpt?: string }
}

/** Transport as submitted by the settings form; `secretConfigured` is derived by the host. */
export type McpTransportInput =
  | Extract<McpTransport, { type: 'stdio' }>
  | (Omit<Extract<McpTransport, { type: 'streamable_http' }>, 'secretConfigured'> & { secretConfigured?: boolean })

export interface McpServerInput {
  id?: string
  name: string
  enabled: boolean
  transport: McpTransportInput
  toolNamespace: string
  disabledTools?: string[]
}

/**
 * Secret values submitted with a save. Keys must be declared in `envKeys` /
 * `secretHeaderKeys`; an empty string keeps the value already stored.
 */
export interface McpSecretInput {
  env?: Record<string, string>
  headers?: Record<string, string>
  bearer?: string
}

export interface McpConnectionTest {
  ok: boolean
  latencyMs: number
  serverVersion?: string
  toolCount?: number
  tools?: McpToolSummary[]
  connectedVia?: 'stdio' | 'streamable_http' | 'sse'
  error?: { code: string; message: string; retryable: boolean }
}

export type SkillImportSource =
  | { kind: 'folder'; path: string }
  | { kind: 'git'; url: string; ref?: string; subpath?: string; commit?: string }

export interface SkillImportFile {
  path: string
  size: number
  kind: 'entry' | 'script' | 'reference' | 'asset'
}

export interface SkillImportPreview {
  selectionId: string
  expiresAt: string
  source: SkillImportSource
  name: string
  description: string
  version: string
  permissions: SkillPermission[]
  instructionsPreview: string
  files: SkillImportFile[]
  fileCount: number
  totalBytes: number
  scriptFiles: string[]
  warnings: string[]
  replaces?: { id: string; version: string; enabled: boolean }
}

export interface SkillGitImportInput {
  url: string
  ref?: string
  subpath?: string
}

export interface SkillDetail {
  manifest: SkillManifest
  instructions: string
  referenceFiles: string[]
  scriptFiles: string[]
}

export interface AutomationInput {
  id?: string
  workspaceId: string
  name: string
  enabled: boolean
  objective: string
  modelProfileId: string
  schedule: AutomationSchedule
}

export interface AuditQuery extends PageRequest {
  runId?: string
  outcome?: AuditEntry['outcome']
  since?: string
}

export interface AuditFilterInput {
  runId?: string
  category?: string
  outcome?: string
  from?: string
  to?: string
  text?: string
  limit?: number
}

export interface AuditRecord {
  id: string
  runId?: string
  category: string
  action: string
  summary: string
  actor?: string
  outcome?: string
  riskLevel?: string
  target?: string
  /** Session rule that auto-approved this event, if any. */
  ruleId?: string
  ruleLabel?: string
  payload: JsonValue
  prevHash?: string
  entryHash?: string
  chain: 'ok' | 'broken' | 'unlinked' | 'legacy'
  createdAt: string
}

export interface AuditChainStatus {
  valid: boolean
  checkedEntries: number
  hashedEntries: number
  legacyEntries: number
  brokenIds: string[]
  linkBreakIds: string[]
  checkedAt: string
}

export interface AuditQueryResult {
  items: AuditRecord[]
  total: number
  truncated: boolean
  categories: string[]
  runs: Array<{ id: string; title: string }>
  chain: AuditChainStatus
}

export type AuditExportFormat = 'json' | 'csv' | 'markdown'

export interface AuditExportResult {
  path: string
  format: AuditExportFormat
  entryCount: number
  chainValid: boolean
}

export interface DiagnosticExportResult {
  path: string
  entryCount: number
  redacted: boolean
}

export interface ArtifactText {
  artifact: ArtifactRef
  text: string
  truncated: boolean
}

export interface FileContentResult {
  path: string
  name: string
  size: number
  text: string
  truncated: boolean
}

export interface ArtifactRestoreResult {
  restored: true
  path: string
  createdFileRemoved: boolean
}

/**
 * Public renderer bridge. It intentionally exposes individual methods rather
 * than a generic IPC primitive, and never exposes an API key read method.
 */
export interface SessionSearchHit {
  runId: string
  title: string
  workspaceId: string
  status: Run['status']
  updatedAt: string
  matchedIn: 'title' | 'message'
  messageId?: string
  snippet: string
}

export interface SessionExportResult {
  path: string
  bytes: number
  redacted: true
}

export type KnowledgeIndexState = 'empty' | 'indexing' | 'ready' | 'error'

export interface KnowledgeIndexSkipped {
  ignored: number
  symlinks: number
  unsupported: number
  sensitive: number
  tooLarge: number
  binary: number
  unreadable: number
}

export interface KnowledgeIndexStatus {
  workspaceId: string
  workspaceName: string
  rootPath: string
  state: KnowledgeIndexState
  fileCount: number
  chunkCount: number
  indexedBytes: number
  storageBytes: number
  indexedAt?: string
  lastDurationMs?: number
  lastRun?: { added: number; updated: number; unchanged: number; removed: number }
  skipped: KnowledgeIndexSkipped
  truncated: boolean
  limitReason?: string
  error?: string
  embeddings: { enabled: boolean; model?: string; embeddedChunks: number; error?: string }
}

export interface KnowledgeSearchHit {
  path: string
  /** Line range of the snippet (1-based, inclusive). */
  startLine: number
  endLine: number
  /** Line range of the whole indexed chunk. */
  chunkStartLine: number
  chunkEndLine: number
  snippet: string
  score: number
  matchedBy: 'keyword' | 'semantic' | 'hybrid'
}

export interface KnowledgeSearchResult {
  query: string
  state: KnowledgeIndexState
  mode: 'keyword' | 'hybrid'
  results: KnowledgeSearchHit[]
  indexedAt?: string
  fileCount: number
  note?: string
}

export type EmbeddingsPresetId = 'dashscope-v4' | 'dashscope-v3' | 'openai-3-small' | 'custom'

export interface EmbeddingsPreset {
  id: EmbeddingsPresetId
  label: string
  baseUrl: string
  model: string
  dimensions?: number
}

export const EMBEDDINGS_PRESETS: readonly EmbeddingsPreset[] = [
  { id: 'dashscope-v4', label: '通义 DashScope · text-embedding-v4', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v4', dimensions: 1024 },
  { id: 'dashscope-v3', label: '通义 DashScope · text-embedding-v3', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3', dimensions: 1024 },
  { id: 'openai-3-small', label: 'OpenAI · text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
  { id: 'custom', label: '自定义 OpenAI 兼容接口', baseUrl: '', model: '' },
]

export interface EmbeddingsSettings {
  enabled: boolean
  preset: EmbeddingsPresetId
  baseUrl: string
  model: string
  dimensions?: number
  hasKey: boolean
  /** Set when the user acknowledged that document chunks leave the device. */
  acknowledgedAt?: string
  secureStorage: boolean
}

export interface EmbeddingsSettingsInput {
  enabled: boolean
  preset: EmbeddingsPresetId
  baseUrl: string
  model: string
  dimensions?: number
  apiKey?: string
  clearKey?: boolean
  acknowledgeEgress?: boolean
}

export interface EmbeddingsTestResult {
  ok: boolean
  latencyMs: number
  dimensions?: number
  error?: string
}

export interface DesktopApi {
  readonly apiVersion: typeof DESKTOP_API_VERSION
  bootstrap(): Promise<BootstrapSnapshot>
  app: {
    getInfo(): Promise<AppInfo>
    chooseWorkspace(): Promise<string | null>
    chooseFiles(): Promise<string[]>
    importAttachments(): Promise<ArtifactRef[]>
    revealPath(input: { path: string }): Promise<void>
    openPath(input: { path: string }): Promise<{ success: boolean; error?: string }>
    readFileContent(input: { path: string; maxBytes?: number }): Promise<FileContentResult>
  }
  workspaces: {
    list(): Promise<Workspace[]>
    create(input: CreateWorkspaceInput): Promise<Workspace>
    update(input: UpdateWorkspaceInput): Promise<Workspace>
    remove(input: { id: string }): Promise<void>
    select(input: { id: string }): Promise<Workspace>
    searchFiles(input: { workspaceId: string; query?: string; limit?: number }): Promise<WorkspaceFileItem[]>
  }
  runs: {
    list(input?: PageRequest & { workspaceId?: string; status?: Run['status'] }): Promise<Page<RunSummary>>
    get(input: { id: string }): Promise<RunDetail>
    create(input: CreateRunInput): Promise<RunDetail>
    sendMessage(input: SendRunMessageInput): Promise<void>
    pause(input: { id: string }): Promise<Run>
    resume(input: { id: string }): Promise<Run>
    cancel(input: { id: string }): Promise<Run>
    remove(input: { id: string }): Promise<void>
    respondToApproval(input: ApprovalResponse): Promise<void>
    listSessionRules(input?: { runId?: string }): Promise<SessionApprovalRule[]>
    revokeSessionRule(input: { id: string }): Promise<{ revoked: true }>
    search(input: { query: string; workspaceId?: string; limit?: number }): Promise<SessionSearchHit[]>
    rename(input: { id: string; title: string }): Promise<Run>
    exportMarkdown(input: { id: string }): Promise<SessionExportResult | null>
  }
  knowledge: {
    listStatus(): Promise<KnowledgeIndexStatus[]>
    rebuild(input: { workspaceId: string; mode: 'incremental' | 'full' }): Promise<KnowledgeIndexStatus>
    clear(input: { workspaceId: string }): Promise<KnowledgeIndexStatus>
    search(input: { workspaceId: string; query: string; limit?: number }): Promise<KnowledgeSearchResult>
    getEmbeddings(): Promise<EmbeddingsSettings>
    setEmbeddings(input: EmbeddingsSettingsInput): Promise<EmbeddingsSettings>
    testEmbeddings(): Promise<EmbeddingsTestResult>
  }
  models: {
    list(): Promise<ModelProfile[]>
    catalog(input: { provider: ProviderId }): Promise<ModelCatalogItem[]>
    upsert(input: ModelProfileInput): Promise<ModelProfile>
    remove(input: { id: string }): Promise<void>
    setSecret(input: { profileId: string; apiKey: string }): Promise<void>
    deleteSecret(input: { profileId: string }): Promise<void>
    test(input: { profileId: string }): Promise<ModelConnectionTest>
    testDraft(input: ModelConnectionDraft): Promise<ModelConnectionTest>
    setDefaults(input: ModelDefaultsInput): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    update(input: Partial<AppSettings>): Promise<AppSettings>
  }
  permissions: {
    listPersistent(): Promise<ApprovalGrant[]>
    createPersistent(input: PersistentGrantInput): Promise<ApprovalGrant>
    removePersistent(input: { id: string }): Promise<void>
  }
  capabilityPackages: {
    choose(): Promise<CapabilityPackagePreview | null>
    install(input: { selectionId: string; workspaceId?: string }): Promise<InstalledCapabilityPackage>
    list(): Promise<InstalledCapabilityPackage[]>
  }
  memory: {
    list(input?: { workspaceId?: string; state?: MemoryEntry['state']; scope?: MemoryScope }): Promise<MemoryEntry[]>
    propose(input: MemoryProposalInput): Promise<MemoryEntry>
    confirm(input: { id: string }): Promise<MemoryEntry>
    disable(input: { id: string }): Promise<MemoryEntry>
    remove(input: { id: string }): Promise<void>
  }
  mcp: {
    list(): Promise<McpServerConfig[]>
    upsert(input: McpServerInput & { secrets?: McpSecretInput }): Promise<McpServerConfig>
    remove(input: { id: string }): Promise<void>
    test(input: { id: string; workspaceId?: string }): Promise<McpConnectionTest>
    setEnabled(input: { id: string; enabled: boolean }): Promise<McpServerConfig>
    setToolEnabled(input: { id: string; toolName: string; enabled: boolean }): Promise<McpServerConfig>
    chooseCwd(): Promise<string | null>
    startOAuth(input: { id: string }): Promise<{ authorizationUrl: string; state: string }>
    completeOAuth(input: { id: string; callbackUrl: string; state: string }): Promise<McpServerConfig>
  }
  skills: {
    list(): Promise<SkillManifest[]>
    get(input: { id: string }): Promise<SkillDetail>
    import(input: { directory: string }): Promise<SkillManifest>
    remove(input: { id: string }): Promise<void>
    setEnabled(input: { id: string; enabled: boolean }): Promise<SkillManifest>
    previewFolder(): Promise<SkillImportPreview | null>
    previewGit(input: SkillGitImportInput): Promise<SkillImportPreview>
    previewUpdate(input: { id: string }): Promise<SkillImportPreview>
    confirmImport(input: { selectionId: string }): Promise<SkillManifest>
    cancelImport(input: { selectionId: string }): Promise<void>
  }
  automations: {
    list(input?: { workspaceId?: string }): Promise<AutomationSpec[]>
    upsert(input: AutomationInput): Promise<AutomationSpec>
    remove(input: { id: string }): Promise<void>
    setEnabled(input: { id: string; enabled: boolean }): Promise<AutomationSpec>
    runNow(input: { id: string }): Promise<RunDetail>
  }
  chrome: {
    getStatus(): Promise<ChromeBridgeStatus>
    listGrants(input?: { runId?: string }): Promise<ChromeTabGrant[]>
    requestBinding(input: { runId: string }): Promise<{ requested: true }>
    revokeGrant(input: { id: string }): Promise<void>
  }
  audit: {
    list(input?: AuditQuery): Promise<Page<AuditEntry>>
    exportDiagnostics(input?: { runId?: string }): Promise<DiagnosticExportResult | null>
    query(input?: AuditFilterInput): Promise<AuditQueryResult>
    export(input: AuditFilterInput & { format: AuditExportFormat }): Promise<AuditExportResult | null>
  }
  artifacts: {
    getText(input: { id: string; maxBytes?: number }): Promise<ArtifactText>
    reveal(input: { id: string }): Promise<void>
    open(input: { id: string }): Promise<{ success: boolean; error?: string }>
    undoChange(input: { id: string }): Promise<ArtifactRestoreResult>
  }
  events: {
    subscribe(listener: (event: RunEvent) => void): () => void
  }
}

/** Compile-time channel map used by preload and ipcMain handlers. */
export interface DesktopInvokeMap {
  'bootstrap': { input: undefined; output: BootstrapSnapshot }
  'app:get-info': { input: undefined; output: AppInfo }
  'app:choose-workspace': { input: undefined; output: string | null }
  'app:choose-files': { input: undefined; output: string[] }
  'app:import-attachments': { input: undefined; output: ArtifactRef[] }
  'app:reveal-path': { input: { path: string }; output: undefined }
  'app:open-path': { input: { path: string }; output: { success: boolean; error?: string } }
  'app:read-file-content': { input: { path: string; maxBytes?: number }; output: FileContentResult }
  'workspaces:list': { input: undefined; output: Workspace[] }
  'workspaces:create': { input: CreateWorkspaceInput; output: Workspace }
  'workspaces:update': { input: UpdateWorkspaceInput; output: Workspace }
  'workspaces:remove': { input: { id: string }; output: undefined }
  'workspaces:select': { input: { id: string }; output: Workspace }
  'workspaces:search-files': { input: { workspaceId: string; query?: string; limit?: number }; output: WorkspaceFileItem[] }
  'runs:list': { input: (PageRequest & { workspaceId?: string; status?: Run['status'] }) | undefined; output: Page<RunSummary> }
  'runs:get': { input: { id: string }; output: RunDetail }
  'runs:create': { input: CreateRunInput; output: RunDetail }
  'runs:send-message': { input: SendRunMessageInput; output: undefined }
  'runs:pause': { input: { id: string }; output: Run }
  'runs:resume': { input: { id: string }; output: Run }
  'runs:cancel': { input: { id: string }; output: Run }
  'runs:remove': { input: { id: string }; output: undefined }
  'runs:respond-approval': { input: ApprovalResponse; output: undefined }
  'approvals:list-session-rules': { input: { runId?: string } | undefined; output: SessionApprovalRule[] }
  'approvals:revoke-session-rule': { input: { id: string }; output: { revoked: true } }
  'runs:search': { input: { query: string; workspaceId?: string; limit?: number }; output: SessionSearchHit[] }
  'runs:rename': { input: { id: string; title: string }; output: Run }
  'runs:export-markdown': { input: { id: string }; output: SessionExportResult | null }
  'knowledge:list-status': { input: undefined; output: KnowledgeIndexStatus[] }
  'knowledge:rebuild': { input: { workspaceId: string; mode: 'incremental' | 'full' }; output: KnowledgeIndexStatus }
  'knowledge:clear': { input: { workspaceId: string }; output: KnowledgeIndexStatus }
  'knowledge:search': { input: { workspaceId: string; query: string; limit?: number }; output: KnowledgeSearchResult }
  'knowledge:get-embeddings': { input: undefined; output: EmbeddingsSettings }
  'knowledge:set-embeddings': { input: EmbeddingsSettingsInput; output: EmbeddingsSettings }
  'knowledge:test-embeddings': { input: undefined; output: EmbeddingsTestResult }
  'models:list': { input: undefined; output: ModelProfile[] }
  'models:catalog': { input: { provider: ProviderId }; output: ModelCatalogItem[] }
  'models:upsert': { input: ModelProfileInput; output: ModelProfile }
  'models:remove': { input: { id: string }; output: undefined }
  'models:set-secret': { input: { profileId: string; apiKey: string }; output: undefined }
  'models:delete-secret': { input: { profileId: string }; output: undefined }
  'models:test': { input: { profileId: string }; output: ModelConnectionTest }
  'models:test-draft': { input: ModelConnectionDraft; output: ModelConnectionTest }
  'models:set-defaults': { input: ModelDefaultsInput; output: undefined }
  'settings:get': { input: undefined; output: AppSettings }
  'settings:update': { input: Partial<AppSettings>; output: AppSettings }
  'permissions:list-persistent': { input: undefined; output: ApprovalGrant[] }
  'permissions:create-persistent': { input: PersistentGrantInput; output: ApprovalGrant }
  'permissions:remove-persistent': { input: { id: string }; output: undefined }
  'capability-packages:choose': { input: undefined; output: CapabilityPackagePreview | null }
  'capability-packages:install': { input: { selectionId: string; workspaceId?: string }; output: InstalledCapabilityPackage }
  'capability-packages:list': { input: undefined; output: InstalledCapabilityPackage[] }
  'memory:list': { input: { workspaceId?: string; state?: MemoryEntry['state']; scope?: MemoryScope } | undefined; output: MemoryEntry[] }
  'memory:propose': { input: MemoryProposalInput; output: MemoryEntry }
  'memory:confirm': { input: { id: string }; output: MemoryEntry }
  'memory:disable': { input: { id: string }; output: MemoryEntry }
  'memory:remove': { input: { id: string }; output: undefined }
  'mcp:list': { input: undefined; output: McpServerConfig[] }
  'mcp:upsert': { input: McpServerInput & { secrets?: McpSecretInput }; output: McpServerConfig }
  'mcp:remove': { input: { id: string }; output: undefined }
  'mcp:test': { input: { id: string; workspaceId?: string }; output: McpConnectionTest }
  'mcp:set-enabled': { input: { id: string; enabled: boolean }; output: McpServerConfig }
  'mcp:set-tool-enabled': { input: { id: string; toolName: string; enabled: boolean }; output: McpServerConfig }
  'mcp:choose-cwd': { input: undefined; output: string | null }
  'mcp:start-oauth': { input: { id: string }; output: { authorizationUrl: string; state: string } }
  'mcp:complete-oauth': { input: { id: string; callbackUrl: string; state: string }; output: McpServerConfig }
  'skills:list': { input: undefined; output: SkillManifest[] }
  'skills:get': { input: { id: string }; output: SkillDetail }
  'skills:import': { input: { directory: string }; output: SkillManifest }
  'skills:remove': { input: { id: string }; output: undefined }
  'skills:set-enabled': { input: { id: string; enabled: boolean }; output: SkillManifest }
  'skills:preview-folder': { input: undefined; output: SkillImportPreview | null }
  'skills:preview-git': { input: SkillGitImportInput; output: SkillImportPreview }
  'skills:preview-update': { input: { id: string }; output: SkillImportPreview }
  'skills:confirm-import': { input: { selectionId: string }; output: SkillManifest }
  'skills:cancel-import': { input: { selectionId: string }; output: undefined }
  'automations:list': { input: { workspaceId?: string } | undefined; output: AutomationSpec[] }
  'automations:upsert': { input: AutomationInput; output: AutomationSpec }
  'automations:remove': { input: { id: string }; output: undefined }
  'automations:set-enabled': { input: { id: string; enabled: boolean }; output: AutomationSpec }
  'automations:run-now': { input: { id: string }; output: RunDetail }
  'chrome:get-status': { input: undefined; output: ChromeBridgeStatus }
  'chrome:list-grants': { input: { runId?: string } | undefined; output: ChromeTabGrant[] }
  'chrome:request-binding': { input: { runId: string }; output: { requested: true } }
  'chrome:revoke-grant': { input: { id: string }; output: undefined }
  'audit:list': { input: AuditQuery | undefined; output: Page<AuditEntry> }
  'audit:export-diagnostics': { input: { runId?: string } | undefined; output: DiagnosticExportResult | null }
  'audit:query': { input: AuditFilterInput | undefined; output: AuditQueryResult }
  'audit:export': { input: AuditFilterInput & { format: AuditExportFormat }; output: AuditExportResult | null }
  'artifacts:get-text': { input: { id: string; maxBytes?: number }; output: ArtifactText }
  'artifacts:reveal': { input: { id: string }; output: undefined }
  'artifacts:open': { input: { id: string }; output: { success: boolean; error?: string } }
  'artifacts:undo-change': { input: { id: string }; output: ArtifactRestoreResult }
}

export type DesktopInvokeChannel = keyof DesktopInvokeMap
export type DesktopInvoker = <C extends DesktopInvokeChannel>(
  channel: C,
  input: DesktopInvokeMap[C]['input'],
) => Promise<DesktopInvokeMap[C]['output']>

const VoidSchema = z.undefined()
const ByIdSchema = z.object({ id: IdSchema }).strict()

const McpStringMap = z.record(z.string().max(256), z.string().max(8192))
export const McpSecretInputSchema = z.object({
  env: McpStringMap.optional(),
  headers: McpStringMap.optional(),
  bearer: z.string().max(8192).optional(),
}).strict()

export const McpServerInputSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  transport: McpTransportInputSchema,
  toolNamespace: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/).max(64),
  disabledTools: z.array(z.string().min(1).max(256)).max(512).optional(),
  secrets: McpSecretInputSchema.optional(),
}).strict()

export const SkillImportPreviewSchema = z.object({
  selectionId: IdSchema,
  expiresAt: IsoDateTimeSchema,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('folder'), path: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('git'), url: z.string().url(), ref: z.string().optional(), subpath: z.string().optional(), commit: z.string().optional() }).strict(),
  ]),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  permissions: z.array(SkillPermissionSchema),
  instructionsPreview: z.string(),
  files: z.array(z.object({ path: z.string().min(1), size: z.number().int().nonnegative(), kind: z.enum(['entry', 'script', 'reference', 'asset']) }).strict()),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  scriptFiles: z.array(z.string()),
  warnings: z.array(z.string()),
  replaces: z.object({ id: IdSchema, version: z.string(), enabled: z.boolean() }).strict().optional(),
}).strict()
const AuditFilterSchema = z.object({
  runId: IdSchema.optional(),
  category: z.string().min(1).max(64).optional(),
  outcome: z.string().min(1).max(64).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  text: z.string().max(200).optional(),
  limit: z.number().int().positive().max(5_000).optional(),
}).strict()
const AuditChainStatusSchema = z.object({
  valid: z.boolean(),
  checkedEntries: z.number().int().nonnegative(),
  hashedEntries: z.number().int().nonnegative(),
  legacyEntries: z.number().int().nonnegative(),
  brokenIds: z.array(z.string()),
  linkBreakIds: z.array(z.string()),
  checkedAt: IsoDateTimeSchema,
}).strict()
const AuditQueryResultSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    runId: IdSchema.optional(),
    category: z.string(),
    action: z.string(),
    summary: z.string(),
    actor: z.string().optional(),
    outcome: z.string().optional(),
    riskLevel: z.string().optional(),
    target: z.string().optional(),
    ruleId: z.string().optional(),
    ruleLabel: z.string().optional(),
    payload: JsonValueSchema,
    prevHash: z.string().optional(),
    entryHash: z.string().optional(),
    chain: z.enum(['ok', 'broken', 'unlinked', 'legacy']),
    createdAt: z.string(),
  }).strict()),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  categories: z.array(z.string()),
  runs: z.array(z.object({ id: IdSchema, title: z.string() }).strict()),
  chain: AuditChainStatusSchema,
}).strict()
const OptionalByWorkspaceSchema = z.object({ workspaceId: IdSchema.optional() }).strict().optional()
const PageSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().optional() }).strict()
const InstalledCapabilityPackageSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  workspaceId: IdSchema.optional(),
  skillIds: z.array(IdSchema),
  mcpServerIds: z.array(IdSchema),
  ruleSources: z.array(z.string()),
  templatePaths: z.array(z.string()),
  installedAt: IsoDateTimeSchema,
}).strict()
const CapabilityPackagePreviewSchema = z.object({
  selectionId: IdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  directory: z.string().min(1),
  skills: z.array(z.string()),
  mcpConfigs: z.array(JsonValueSchema),
  rules: z.array(z.string()),
  templates: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
}).strict()

/** Runtime validators for every renderer-to-main invocation and response. */
const KnowledgeStateSchema = z.enum(['empty', 'indexing', 'ready', 'error'])
const KnowledgeIndexStatusSchema = z.object({
  workspaceId: IdSchema,
  workspaceName: z.string(),
  rootPath: z.string(),
  state: KnowledgeStateSchema,
  fileCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  indexedBytes: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  indexedAt: IsoDateTimeSchema.optional(),
  lastDurationMs: z.number().int().nonnegative().optional(),
  lastRun: z.object({ added: z.number().int().nonnegative(), updated: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }).strict().optional(),
  skipped: z.object({ ignored: z.number().int().nonnegative(), symlinks: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative(), sensitive: z.number().int().nonnegative(), tooLarge: z.number().int().nonnegative(), binary: z.number().int().nonnegative(), unreadable: z.number().int().nonnegative() }).strict(),
  truncated: z.boolean(),
  limitReason: z.string().optional(),
  error: z.string().optional(),
  embeddings: z.object({ enabled: z.boolean(), model: z.string().optional(), embeddedChunks: z.number().int().nonnegative(), error: z.string().optional() }).strict(),
}).strict()
const KnowledgeSearchResultSchema = z.object({
  query: z.string(),
  state: KnowledgeStateSchema,
  mode: z.enum(['keyword', 'hybrid']),
  results: z.array(z.object({
    path: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    chunkStartLine: z.number().int().positive(),
    chunkEndLine: z.number().int().positive(),
    snippet: z.string(),
    score: z.number().finite(),
    matchedBy: z.enum(['keyword', 'semantic', 'hybrid']),
  }).strict()),
  indexedAt: IsoDateTimeSchema.optional(),
  fileCount: z.number().int().nonnegative(),
  note: z.string().optional(),
}).strict()
const EmbeddingsPresetIdSchema = z.enum(['dashscope-v4', 'dashscope-v3', 'openai-3-small', 'custom'])
const EmbeddingsSettingsSchema = z.object({
  enabled: z.boolean(),
  preset: EmbeddingsPresetIdSchema,
  baseUrl: z.string().max(2048),
  model: z.string().max(256),
  dimensions: z.number().int().min(16).max(8192).optional(),
  hasKey: z.boolean(),
  acknowledgedAt: IsoDateTimeSchema.optional(),
  secureStorage: z.boolean(),
}).strict()
const SessionSearchHitSchema = z.object({
  runId: IdSchema,
  title: z.string(),
  workspaceId: z.string(),
  status: RunStatusSchema,
  updatedAt: IsoDateTimeSchema,
  matchedIn: z.enum(['title', 'message']),
  messageId: IdSchema.optional(),
  snippet: z.string(),
}).strict()

export const DesktopInvokeContracts: Record<DesktopInvokeChannel, { input: z.ZodType; output: z.ZodType }> = {
  bootstrap: { input: VoidSchema, output: BootstrapSnapshotSchema },
  'app:get-info': { input: VoidSchema, output: z.object({ name: z.string(), version: z.string(), platform: z.string(), arch: z.string(), locale: z.string() }).strict() },
  'app:choose-workspace': { input: VoidSchema, output: z.string().nullable() },
  'app:choose-files': { input: VoidSchema, output: z.array(z.string()) },
  'app:import-attachments': { input: VoidSchema, output: z.array(ArtifactRefSchema) },
  'app:reveal-path': { input: z.object({ path: z.string().min(1) }).strict(), output: VoidSchema },
  'app:open-path': { input: z.object({ path: z.string().min(1) }).strict(), output: z.object({ success: z.boolean(), error: z.string().optional() }).strict() },
  'app:read-file-content': {
    input: z.object({ path: z.string().min(1), maxBytes: z.number().int().positive().max(16 * 1024 * 1024).optional() }).strict(),
    output: z.object({ path: z.string().min(1), name: z.string().min(1), size: z.number().int().nonnegative(), text: z.string(), truncated: z.boolean() }).strict(),
  },
  'workspaces:list': { input: VoidSchema, output: z.array(WorkspaceSchema) },
  'workspaces:create': { input: z.object({ path: z.string().min(1), name: z.string().min(1).optional() }).strict(), output: WorkspaceSchema },
  'workspaces:update': { input: z.object({ id: IdSchema, name: z.string().min(1).optional(), rules: z.string().optional() }).strict(), output: WorkspaceSchema },
  'workspaces:remove': { input: ByIdSchema, output: VoidSchema },
  'workspaces:select': { input: ByIdSchema, output: WorkspaceSchema },
  'workspaces:search-files': {
    input: z.object({
      workspaceId: IdSchema,
      query: z.string().max(300).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }).strict(),
    output: z.array(WorkspaceFileItemSchema),
  },
  'runs:list': { input: PageRequestSchema.extend({ workspaceId: IdSchema.optional(), status: RunStatusSchema.optional() }).strict().optional(), output: PageSchema(RunSummarySchema) },
  'runs:get': { input: ByIdSchema, output: RunDetailSchema },
  'runs:create': {
    input: z.object({ workspaceId: IdSchema, objective: z.string().min(1), accessMode: RunAccessModeSchema.optional(), permissionMode: RunPermissionModeSchema.optional(), mode: z.enum(['plan', 'execute']).optional(), title: z.string().min(1).optional(), modelProfileId: IdSchema.optional(), attachmentIds: z.array(IdSchema).optional(), limits: RunLimitsSchema.partial().optional() }).strict(),
    output: RunDetailSchema,
  },
  'runs:send-message': { input: z.object({ runId: IdSchema, content: z.string().min(1), accessMode: RunAccessModeSchema.optional(), permissionMode: RunPermissionModeSchema.optional(), attachmentIds: z.array(IdSchema).optional() }).strict(), output: VoidSchema },
  'runs:pause': { input: ByIdSchema, output: RunSchema },
  'runs:resume': { input: ByIdSchema, output: RunSchema },
  'runs:cancel': { input: ByIdSchema, output: RunSchema },
  'runs:remove': { input: ByIdSchema, output: VoidSchema },
  'runs:respond-approval': { input: ApprovalResponseSchema, output: VoidSchema },
  'approvals:list-session-rules': { input: z.object({ runId: IdSchema.optional() }).strict().optional(), output: z.array(SessionApprovalRuleSchema) },
  'approvals:revoke-session-rule': { input: ByIdSchema, output: z.object({ revoked: z.literal(true) }).strict() },
  'runs:search': { input: z.object({ query: z.string().max(500), workspaceId: IdSchema.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), output: z.array(SessionSearchHitSchema) },
  'runs:rename': { input: z.object({ id: IdSchema, title: z.string().trim().min(1).max(500) }).strict(), output: RunSchema },
  'runs:export-markdown': { input: ByIdSchema, output: z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), redacted: z.literal(true) }).strict().nullable() },
  'knowledge:list-status': { input: VoidSchema, output: z.array(KnowledgeIndexStatusSchema) },
  'knowledge:rebuild': { input: z.object({ workspaceId: IdSchema, mode: z.enum(['incremental', 'full']) }).strict(), output: KnowledgeIndexStatusSchema },
  'knowledge:clear': { input: z.object({ workspaceId: IdSchema }).strict(), output: KnowledgeIndexStatusSchema },
  'knowledge:search': { input: z.object({ workspaceId: IdSchema, query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).optional() }).strict(), output: KnowledgeSearchResultSchema },
  'knowledge:get-embeddings': { input: VoidSchema, output: EmbeddingsSettingsSchema },
  'knowledge:set-embeddings': {
    input: z.object({
      enabled: z.boolean(),
      preset: EmbeddingsPresetIdSchema,
      baseUrl: z.string().max(2048),
      model: z.string().max(256),
      dimensions: z.number().int().min(16).max(8192).optional(),
      apiKey: z.string().min(1).max(20_000).optional(),
      clearKey: z.boolean().optional(),
      acknowledgeEgress: z.boolean().optional(),
    }).strict(),
    output: EmbeddingsSettingsSchema,
  },
  'knowledge:test-embeddings': { input: VoidSchema, output: z.object({ ok: z.boolean(), latencyMs: z.number().int().nonnegative(), dimensions: z.number().int().positive().optional(), error: z.string().optional() }).strict() },
  'models:list': { input: VoidSchema, output: z.array(ModelProfileSchema) },
  'models:catalog': {
    input: z.object({ provider: ProviderIdSchema }).strict(),
    output: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), contextWindow: z.number().int().positive(), maxOutputTokens: z.number().int().positive(), vision: z.boolean(), reasoning: z.boolean() }).strict()),
  },
  'models:upsert': { input: ModelProfileInputSchema, output: ModelProfileSchema },
  'models:remove': { input: ByIdSchema, output: VoidSchema },
  'models:set-secret': { input: z.object({ profileId: IdSchema, apiKey: z.string().min(1).max(20_000) }).strict(), output: VoidSchema },
  'models:delete-secret': { input: z.object({ profileId: IdSchema }).strict(), output: VoidSchema },
  'models:test': { input: z.object({ profileId: IdSchema }).strict(), output: ModelConnectionTestSchema },
  'models:test-draft': { input: ModelConnectionDraftSchema, output: ModelConnectionTestSchema },
  'models:set-defaults': { input: z.object({ defaultModelProfileId: IdSchema, subagentModelProfileId: IdSchema.optional() }).strict(), output: VoidSchema },
  'settings:get': { input: VoidSchema, output: AppSettingsSchema },
  'settings:update': { input: AppSettingsSchema.partial().strict(), output: AppSettingsSchema },
  'permissions:list-persistent': { input: VoidSchema, output: z.array(ApprovalGrantSchema) },
  'permissions:create-persistent': {
    input: z.object({
      workspaceId: IdSchema,
      toolName: z.enum(['file.write', 'file.edit']),
      path: z.string().trim().min(1).max(4096),
      expiresAt: IsoDateTimeSchema.optional(),
    }).strict(),
    output: ApprovalGrantSchema,
  },
  'permissions:remove-persistent': { input: ByIdSchema, output: VoidSchema },
  'capability-packages:choose': { input: VoidSchema, output: CapabilityPackagePreviewSchema.nullable() },
  'capability-packages:install': { input: z.object({ selectionId: IdSchema, workspaceId: IdSchema.optional() }).strict(), output: InstalledCapabilityPackageSchema },
  'capability-packages:list': { input: VoidSchema, output: z.array(InstalledCapabilityPackageSchema) },
  'memory:list': { input: z.object({ workspaceId: IdSchema.optional(), state: z.enum(['proposed', 'confirmed', 'disabled', 'deleted']).optional(), scope: z.enum(['thread', 'workspace', 'user', 'organization']).optional() }).strict().optional(), output: z.array(MemoryEntrySchema) },
  'memory:propose': {
    input: z.object({ workspaceId: IdSchema.optional(), type: z.enum(['stable_fact', 'knowledge_background', 'behavior_signal', 'style_preference', 'continuation']), scope: z.enum(['thread', 'workspace', 'user', 'organization']), content: z.string().min(1), confidence: z.number().min(0).max(1), source: z.object({ kind: z.enum(['run', 'message', 'file', 'user']), reference: z.string().min(1), excerpt: z.string().optional() }).strict() }).strict(),
    output: MemoryEntrySchema,
  },
  'memory:confirm': { input: ByIdSchema, output: MemoryEntrySchema },
  'memory:disable': { input: ByIdSchema, output: MemoryEntrySchema },
  'memory:remove': { input: ByIdSchema, output: VoidSchema },
  'mcp:list': { input: VoidSchema, output: z.array(McpServerConfigSchema) },
  'mcp:upsert': { input: McpServerInputSchema, output: McpServerConfigSchema },
  'mcp:remove': { input: ByIdSchema, output: VoidSchema },
  'mcp:test': { input: z.object({ id: IdSchema, workspaceId: IdSchema.optional() }).strict(), output: z.object({ ok: z.boolean(), latencyMs: z.number().int().nonnegative(), serverVersion: z.string().optional(), toolCount: z.number().int().nonnegative().optional(), tools: z.array(McpToolSummarySchema).optional(), connectedVia: z.enum(['stdio', 'streamable_http', 'sse']).optional(), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict().optional() }).strict() },
  'mcp:set-enabled': { input: z.object({ id: IdSchema, enabled: z.boolean() }).strict(), output: McpServerConfigSchema },
  'mcp:set-tool-enabled': { input: z.object({ id: IdSchema, toolName: z.string().min(1).max(256), enabled: z.boolean() }).strict(), output: McpServerConfigSchema },
  'mcp:choose-cwd': { input: VoidSchema, output: z.string().nullable() },
  'mcp:start-oauth': { input: ByIdSchema, output: z.object({ authorizationUrl: z.string().url(), state: z.string().min(1) }).strict() },
  'mcp:complete-oauth': { input: z.object({ id: IdSchema, callbackUrl: z.string().url(), state: z.string().min(1) }).strict(), output: McpServerConfigSchema },
  'skills:list': { input: VoidSchema, output: z.array(SkillManifestSchema) },
  'skills:get': { input: ByIdSchema, output: z.object({ manifest: SkillManifestSchema, instructions: z.string(), referenceFiles: z.array(z.string()), scriptFiles: z.array(z.string()) }).strict() },
  'skills:import': { input: z.object({ directory: z.string().min(1) }).strict(), output: SkillManifestSchema },
  'skills:remove': { input: ByIdSchema, output: VoidSchema },
  'skills:set-enabled': { input: z.object({ id: IdSchema, enabled: z.boolean() }).strict(), output: SkillManifestSchema },
  'skills:preview-folder': { input: VoidSchema, output: SkillImportPreviewSchema.nullable() },
  'skills:preview-git': { input: z.object({ url: z.string().min(1).max(2048), ref: z.string().max(256).optional(), subpath: z.string().max(1024).optional() }).strict(), output: SkillImportPreviewSchema },
  'skills:preview-update': { input: ByIdSchema, output: SkillImportPreviewSchema },
  'skills:confirm-import': { input: z.object({ selectionId: IdSchema }).strict(), output: SkillManifestSchema },
  'skills:cancel-import': { input: z.object({ selectionId: IdSchema }).strict(), output: VoidSchema },
  'automations:list': { input: OptionalByWorkspaceSchema, output: z.array(AutomationSpecSchema) },
  'automations:upsert': { input: z.object({ id: IdSchema.optional(), workspaceId: IdSchema, name: z.string().min(1), enabled: z.boolean(), objective: z.string().min(1), modelProfileId: IdSchema, schedule: AutomationScheduleSchema }).strict(), output: AutomationSpecSchema },
  'automations:remove': { input: ByIdSchema, output: VoidSchema },
  'automations:set-enabled': { input: z.object({ id: IdSchema, enabled: z.boolean() }).strict(), output: AutomationSpecSchema },
  'automations:run-now': { input: ByIdSchema, output: RunDetailSchema },
  'chrome:get-status': { input: VoidSchema, output: ChromeBridgeStatusSchema },
  'chrome:list-grants': { input: z.object({ runId: IdSchema.optional() }).strict().optional(), output: z.array(ChromeTabGrantSchema) },
  'chrome:request-binding': { input: z.object({ runId: IdSchema }).strict(), output: z.object({ requested: z.literal(true) }).strict() },
  'chrome:revoke-grant': { input: ByIdSchema, output: VoidSchema },
  'audit:list': { input: PageRequestSchema.extend({ runId: IdSchema.optional(), outcome: z.enum(['started', 'allowed', 'blocked', 'approved', 'rejected', 'succeeded', 'failed']).optional(), since: z.string().datetime({ offset: true }).optional() }).strict().optional(), output: PageSchema(AuditEntrySchema) },
  'audit:export-diagnostics': { input: z.object({ runId: IdSchema.optional() }).strict().optional(), output: z.object({ path: z.string(), entryCount: z.number().int().nonnegative(), redacted: z.boolean() }).strict().nullable() },
  'audit:query': { input: AuditFilterSchema.optional(), output: AuditQueryResultSchema },
  'audit:export': { input: AuditFilterSchema.extend({ format: z.enum(['json', 'csv', 'markdown']) }).strict(), output: z.object({ path: z.string().min(1), format: z.enum(['json', 'csv', 'markdown']), entryCount: z.number().int().nonnegative(), chainValid: z.boolean() }).strict().nullable() },
  'artifacts:get-text': { input: z.object({ id: IdSchema, maxBytes: z.number().int().positive().max(16 * 1024 * 1024).optional() }).strict(), output: z.object({ artifact: ArtifactRefSchema, text: z.string(), truncated: z.boolean() }).strict() },
  'artifacts:reveal': { input: ByIdSchema, output: VoidSchema },
  'artifacts:open': { input: ByIdSchema, output: z.object({ success: z.boolean(), error: z.string().optional() }).strict() },
  'artifacts:undo-change': { input: ByIdSchema, output: z.object({ restored: z.literal(true), path: z.string().min(1), createdFileRemoved: z.boolean() }).strict() },
}

export const DesktopEventSchema = RunEventSchema
