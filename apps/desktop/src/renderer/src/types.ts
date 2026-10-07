export type ViewKey =
  | 'tasks'
  | 'memory'
  | 'mcp'
  | 'skills'
  | 'automations'
  | 'settings'
  | 'audit'

export type RunStatus =
  | 'understanding'
  | 'planning'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'waiting_approval'
  | 'waiting_user'
  | 'paused'
  | 'failed'
  | 'cancelled'

export type JsonRecord = Record<string, unknown>

export type RunAccessMode = 'approval'
export type RunPermissionMode = 'approval' | 'workspace_auto'

export interface WorkspaceItem extends JsonRecord {
  id: string
  name: string
  path: string
  selected?: boolean
}

export interface WorkspaceFileItem extends JsonRecord {
  path: string
  name: string
  isDirectory: boolean
  extension?: string | undefined
}

export interface RunItem extends JsonRecord {
  id: string
  title: string
  prompt?: string
  goal?: string
  status: RunStatus
  result?: 'verified' | 'partial'
  workspaceId?: string
  modelProfileId?: string
  accessMode?: RunAccessMode
  permissionMode?: RunPermissionMode
  createdAt?: string
  updatedAt?: string
}

export interface PlanStepItem extends JsonRecord {
  id: string
  title: string
  detail?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

export interface EventItem extends JsonRecord {
  id: string
  type: string
  title: string
  content?: string
  createdAt?: string
  level?: 'info' | 'success' | 'warning' | 'error'
  actor?: 'user' | 'agent' | 'tool' | 'system'
}

export interface ToolActivityItem extends JsonRecord {
  id: string
  toolName: string
  title?: string
  status: 'requested' | 'waiting_approval' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  arguments?: JsonRecord
  argumentsSummary?: unknown
  summary?: string
  error?: string
  sources: SourceItem[]
  createdAt?: string
  updatedAt?: string
}

export interface SourceItem extends JsonRecord {
  id: string
  url: string
  title?: string
  publisher?: string
  status?: 'found' | 'fetched' | 'verified' | 'failed'
  createdAt?: string
}

export interface VerificationCheckItem extends JsonRecord {
  name: string
  status: 'passed' | 'failed' | 'not_run'
  detail?: string
}

export interface VerificationView extends JsonRecord {
  status: 'verified' | 'partial'
  summary?: string
  checks: VerificationCheckItem[]
}

export interface RunProgressItem extends JsonRecord {
  phase: 'thinking' | 'composing_tool' | 'executing' | 'verifying'
  message: string
  toolName?: string
  generatedChars?: number
  updatedAt?: string
}

export type TraceSpanKind = 'run_turn' | 'context_stage' | 'model_turn' | 'tool_call' | 'approval_wait' | 'checkpoint' | 'verification' | 'managed_process'
export type TraceSpanStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting' | 'interrupted'

export interface RunTraceItem extends JsonRecord {
  id: string
  rootSpanId: string
  status: TraceSpanStatus
  startedAt: string
  endedAt?: string
  metadata: JsonRecord
}

export interface TraceSpanItem extends JsonRecord {
  id: string
  traceId: string
  parentSpanId?: string
  kind: TraceSpanKind
  name: string
  status: TraceSpanStatus
  startedAt: string
  endedAt?: string
  durationMs?: number
  usage?: JsonRecord
  error?: JsonRecord
  attributes: JsonRecord
  artifactIds: string[]
}

export interface ApprovalDiffLineView {
  kind: 'context' | 'add' | 'del'
  text: string
  oldLine?: number
  newLine?: number
}

export interface ApprovalDiffHunkView {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ApprovalDiffLineView[]
}

export interface ApprovalDiffView {
  path: string
  operation: 'create' | 'modify' | 'delete'
  additions: number
  deletions: number
  hunks: ApprovalDiffHunkView[]
  text: string
  truncated: boolean
  omittedLines: number
  binary: boolean
  tooLarge: boolean
  note?: string
}

/** 「本会话总是允许此类操作」 offer computed by the main process. */
export interface SessionRuleOffer {
  eligible: boolean
  label?: string
  reason?: string
}

export type ApprovalScopeChoice = 'once' | 'run_tool' | 'session'

export interface ApprovalItem extends JsonRecord {
  id: string
  title: string
  summary: string
  risk: 'reversible_write' | 'external_effect' | 'irreversible'
  arguments?: JsonRecord
  dataShared?: string
  reversible?: boolean
  status?: 'pending' | 'approved' | 'rejected'
  diff?: ApprovalDiffView
  sessionRule?: SessionRuleOffer
}

export interface SessionRuleItem {
  id: string
  runId: string
  runTitle?: string
  kind: 'tool' | 'shell_prefix'
  toolName: string
  riskLevel: string
  commandPrefix?: string
  label: string
  useCount: number
  createdAt: string
  lastUsedAt?: string
}

export interface AuditRecordView {
  id: string
  runId?: string
  category: string
  action: string
  summary: string
  actor?: string
  outcome?: string
  riskLevel?: string
  target?: string
  ruleId?: string
  ruleLabel?: string
  payload: unknown
  prevHash?: string
  entryHash?: string
  chain: 'ok' | 'broken' | 'unlinked' | 'legacy'
  createdAt: string
}

export interface AuditChainView {
  valid: boolean
  checkedEntries: number
  hashedEntries: number
  legacyEntries: number
  brokenIds: string[]
  linkBreakIds: string[]
  checkedAt: string
}

export interface AuditQueryView {
  items: AuditRecordView[]
  total: number
  truncated: boolean
  categories: string[]
  runs: Array<{ id: string; title: string }>
  chain: AuditChainView
}

export interface AuditFilters {
  runId?: string
  category?: string
  outcome?: string
  from?: string
  to?: string
  text?: string
  limit?: number
}

export type AuditExportFormat = 'json' | 'csv' | 'markdown'

export interface ApprovalHistoryItem extends JsonRecord {
  id: string
  title: string
  summary: string
  status: 'pending' | 'approved' | 'rejected' | 'edited'
  scope?: ApprovalScopeChoice
  createdAt?: string
  resolvedAt?: string
}

export interface ArtifactItem extends JsonRecord {
  id: string
  name: string
  kind?: string
  path?: string
  size?: number
}

export interface DocumentPreviewTarget {
  title: string
  path?: string | undefined
  artifactId?: string | undefined
  content?: string | undefined
  truncated?: boolean | undefined
  mime?: string | undefined
}

export interface DiffItem extends JsonRecord {
  id: string
  path: string
  additions?: number
  deletions?: number
}

export interface RunDetailView extends RunItem {
  steps: PlanStepItem[]
  events: EventItem[]
  toolCalls: ToolActivityItem[]
  sources: SourceItem[]
  approvals: ApprovalItem[]
  approvalHistory: ApprovalHistoryItem[]
  artifacts: ArtifactItem[]
  diffs: DiffItem[]
  context: JsonRecord[]
  traces: RunTraceItem[]
  traceSpans: TraceSpanItem[]
  verification?: VerificationView
  progress?: RunProgressItem
}

export type ModelProvider = 'deepseek' | 'kimi' | 'tongyi' | 'custom'

export interface ModelProfileItem extends JsonRecord {
  id: string
  name: string
  provider: ModelProvider
  modelId: string
  baseUrl?: string
  isDefault?: boolean
  isSubagentDefault?: boolean
  hasSecret?: boolean
  status?: 'ready' | 'untested' | 'error'
}

export interface MemoryItem extends JsonRecord {
  id: string
  content: string
  status: 'proposed' | 'confirmed' | 'disabled'
  scope: 'user' | 'workspace' | 'thread'
  kind?: string
  confidence?: number
  source?: string
  createdAt?: string
}

export interface McpToolItem extends JsonRecord {
  name: string
  title?: string
  description?: string
  enabled: boolean
  readOnlyHint?: boolean
  destructiveHint?: boolean
}

export type McpCwdMode = 'isolated' | 'workspace' | 'custom'

export interface McpServerItem extends JsonRecord {
  id: string
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  toolNamespace?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  envKeys?: string[]
  cwdMode?: McpCwdMode
  cwd?: string
  url?: string
  headers?: Record<string, string>
  secretHeaderKeys?: string[]
  sseFallback?: boolean
  status?: 'connected' | 'stopped' | 'error' | 'testing'
  toolCount?: number
  tools?: McpToolItem[]
  connectedVia?: 'stdio' | 'streamable_http' | 'sse'
  serverVersion?: string
  lastError?: string
  lastCheckedAt?: string
  auth?: 'none' | 'bearer' | 'headers' | 'oauth'
  secretConfigured?: boolean
}

export interface McpTestResult {
  ok: boolean
  latencyMs?: number
  toolCount?: number
  tools: McpToolItem[]
  connectedVia?: 'stdio' | 'streamable_http' | 'sse'
  serverVersion?: string
  error?: string
}

export interface SkillOrigin {
  kind: 'bundled' | 'folder' | 'git'
  path?: string
  url?: string
  ref?: string
  subpath?: string
  commit?: string
  importedAt?: string
}

export interface SkillItem extends JsonRecord {
  id: string
  name: string
  description: string
  enabled: boolean
  source?: string
  origin?: SkillOrigin
  version?: string
  permissions?: string[]
}

export interface SkillImportFileItem {
  path: string
  size: number
  kind: 'entry' | 'script' | 'reference' | 'asset'
}

export interface SkillImportPreviewItem {
  selectionId: string
  expiresAt?: string
  origin: SkillOrigin
  name: string
  description: string
  version: string
  permissions: string[]
  instructionsPreview: string
  files: SkillImportFileItem[]
  fileCount: number
  totalBytes: number
  scriptFiles: string[]
  warnings: string[]
  replaces?: { id: string; version: string; enabled: boolean }
}

export interface AutomationItem extends JsonRecord {
  id: string
  name: string
  prompt: string
  schedule: string
  enabled: boolean
  nextRunAt?: string
  lastRunAt?: string
  timezone?: string
  status?: string
}

export interface ChromeStatusView extends JsonRecord {
  connected: boolean
  extensionInstalled?: boolean
  nativeHostInstalled?: boolean
  extensionId?: string
  grants: Array<{
    id: string
    runId?: string
    tabId?: number
    title?: string
    url?: string
  }>
}

export type PermissionMode = 'cautious' | 'balanced' | 'autonomous'

export interface SettingsView extends JsonRecord {
  onboardingCompleted?: boolean
  theme?: 'system' | 'light' | 'dark'
  language?: string
  memoryEnabled?: boolean
  defaultExecutionMode?: 'plan' | 'execute'
  defaultAccessMode?: RunAccessMode
  permissionMode?: PermissionMode
  maxIterations?: number
  maxRunMinutes?: number
  maxSubagents?: number
  maxReadTools?: number
  userPreferences?: string
}

export interface PersistentGrantItem extends JsonRecord {
  id: string
  workspaceId: string
  toolName: 'file.write' | 'file.edit'
  path: string
  createdAt?: string
  expiresAt?: string
}

export interface CapabilityPackageItem extends JsonRecord {
  id: string
  name: string
  version: string
  workspaceId?: string
  skillIds: string[]
  mcpServerIds: string[]
  ruleSources: string[]
  templatePaths: string[]
  installedAt?: string
}

export interface WorkbenchSnapshot {
  workspaces: WorkspaceItem[]
  runs: RunItem[]
  models: ModelProfileItem[]
  memory: MemoryItem[]
  mcpServers: McpServerItem[]
  skills: SkillItem[]
  automations: AutomationItem[]
  chrome: ChromeStatusView
  settings: SettingsView
  persistentGrants: PersistentGrantItem[]
  capabilityPackages: CapabilityPackageItem[]
  appInfo: JsonRecord
}

export interface ToastMessage {
  id: number
  kind: 'success' | 'error' | 'info'
  title: string
  detail?: string
}

export interface SessionSearchHitItem {
  runId: string
  title: string
  workspaceId: string
  status: RunStatus
  updatedAt: string
  matchedIn: 'title' | 'message'
  snippet: string
}

export interface SessionExportView {
  path: string
  bytes: number
}

export type KnowledgeState = 'empty' | 'indexing' | 'ready' | 'error'

export interface KnowledgeStatusItem {
  workspaceId: string
  workspaceName: string
  rootPath: string
  state: KnowledgeState
  fileCount: number
  chunkCount: number
  indexedBytes: number
  storageBytes: number
  indexedAt?: string
  lastDurationMs?: number
  lastRun?: { added: number; updated: number; unchanged: number; removed: number }
  skipped: { ignored: number; symlinks: number; unsupported: number; sensitive: number; tooLarge: number; binary: number; unreadable: number }
  truncated: boolean
  limitReason?: string
  error?: string
  embeddings: { enabled: boolean; model?: string; embeddedChunks: number; error?: string }
}

export interface KnowledgeHitItem {
  path: string
  startLine: number
  endLine: number
  snippet: string
  score: number
  matchedBy: 'keyword' | 'semantic' | 'hybrid'
}

export interface KnowledgeSearchView {
  query: string
  state: KnowledgeState
  mode: 'keyword' | 'hybrid'
  results: KnowledgeHitItem[]
  note?: string
}

export type EmbeddingsPresetId = 'dashscope-v4' | 'dashscope-v3' | 'openai-3-small' | 'custom'

export interface EmbeddingsView {
  enabled: boolean
  preset: EmbeddingsPresetId
  baseUrl: string
  model: string
  dimensions?: number
  hasKey: boolean
  acknowledgedAt?: string
  secureStorage: boolean
}

export interface EmbeddingsInput {
  enabled: boolean
  preset: EmbeddingsPresetId
  baseUrl: string
  model: string
  dimensions?: number
  apiKey?: string
  clearKey?: boolean
  acknowledgeEgress?: boolean
}
