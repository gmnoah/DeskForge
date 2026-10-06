/** Serializable primitives shared by the renderer, broker and utility processes. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type IsoDateTime = string

export type ProviderId = 'deepseek' | 'kimi' | 'tongyi' | 'custom'

export interface ModelCapabilities {
  contextWindow: number
  maxOutputTokens: number
  toolCalling: boolean
  vision: boolean
  reasoning: boolean
  promptCaching: boolean
}

/** Safe model profile returned to the renderer. API keys are deliberately absent. */
export interface ModelProfile {
  id: string
  name: string
  provider: ProviderId
  modelId: string
  /** OpenAI-compatible Chat Completions endpoint, including /v1 when the provider requires it. */
  baseUrl: string
  capabilities: ModelCapabilities
  keyConfigured: boolean
  isDefault: boolean
  isSubagentDefault: boolean
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

export interface ModelProfileInput {
  id?: string
  name: string
  provider: ProviderId
  modelId: string
  baseUrl: string
  capabilities?: Partial<ModelCapabilities>
}

export interface ModelSelectionSnapshot {
  profileId: string
  provider: ProviderId
  modelId: string
  baseUrl: string
  capabilities: ModelCapabilities
}

export interface ModelConnectionTest {
  ok: boolean
  provider: ProviderId
  modelId: string
  latencyMs: number
  error?: PublicError
  /** Non-fatal hint, e.g. a retired model alias that was rewritten. */
  notice?: string
}

/** Test an unsaved (or edited) model configuration. An empty apiKey reuses the saved key of profileId. */
export interface ModelConnectionDraft {
  provider: ProviderId
  modelId: string
  baseUrl: string
  apiKey?: string
  profileId?: string
}

/** Token usage summed over every model call of a run, when the provider reports usage. */
export interface RunTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  totalTokens: number
  modelCalls: number
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
}

export interface ModelAdapterRequest {
  modelId: string
  messages: ModelMessage[]
  tools: ToolDescriptor[]
  maxOutputTokens?: number
  temperature?: number
}

export type ModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: JsonValue }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'cancelled' }
  | { type: 'error'; error: PublicError }

/** Provider implementation boundary used inside the Agent Host. */
export interface ModelAdapter {
  readonly provider: ProviderId
  readonly capabilities: ModelCapabilities
  stream(request: ModelAdapterRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>
  testConnection(modelId: string, signal?: AbortSignal): Promise<ModelConnectionTest>
}

export type RunStatus =
  | 'understanding'
  | 'planning'
  | 'running'
  | 'verifying'
  | 'waiting_approval'
  | 'waiting_user'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type CompletionStatus = 'verified' | 'partial'
/** Per-run filesystem authority selected from the composer. */
export type RunAccessMode = 'approval'
export type TaskStepStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'skipped'
export type MessageRole = 'user' | 'assistant' | 'system'

export interface RunLimits {
  maxModelTurnsPerTurn: number
  maxTotalModelTurns: number
  maxDurationMsPerTurn: number
  maxTotalDurationMs: number
  maxSubagents: number
  maxParallelReadTools: number
}

export interface Run {
  id: string
  workspaceId: string
  accessMode: RunAccessMode
  title: string
  objective: string
  status: RunStatus
  completionStatus?: CompletionStatus
  model: ModelSelectionSnapshot
  limits: RunLimits
  modelTurns: number
  tokenUsage?: RunTokenUsage
  startedAt?: IsoDateTime
  completedAt?: IsoDateTime
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
  lastError?: PublicError
}

export interface RunSummary extends Run {
  unreadEventCount: number
}

export interface TaskStep {
  id: string
  runId: string
  parentStepId?: string
  assignedAgentId?: string
  title: string
  detail?: string
  ordinal: number
  status: TaskStepStatus
  verification?: string
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

export interface ConversationMessage {
  id: string
  runId: string
  role: MessageRole
  content: string
  createdAt: IsoDateTime
  artifactIds?: string[]
}

export type ArtifactKind =
  | 'tool_result'
  | 'attachment'
  | 'file_snapshot'
  | 'diff'
  | 'checkpoint'
  | 'final_output'
  | 'diagnostic'

export interface ArtifactRef {
  id: string
  runId?: string
  kind: ArtifactKind
  sha256: string
  mediaType: string
  byteLength: number
  displayName: string
  createdAt: IsoDateTime
  metadata?: JsonValue
}

export type RiskLevel = 'readonly' | 'reversible_write' | 'external_side_effect' | 'high_risk_irreversible'
export type PolicyEffect = 'allow' | 'require_approval' | 'deny'
export type ToolSource = 'builtin' | 'mcp' | 'skill' | 'chrome'

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  externalSideEffectHint?: boolean
  sendsDataOffDeviceHint?: boolean
}

export interface ToolDescriptor {
  name: string
  title: string
  description: string
  source: ToolSource
  serverId?: string
  inputSchema: JsonValue
  annotations?: ToolAnnotations
}

export type ToolCallStatus = 'requested' | 'waiting_approval' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface ToolCall {
  id: string
  runId: string
  agentId?: string
  toolName: string
  source: ToolSource
  arguments: JsonValue
  status: ToolCallStatus
  riskLevel?: RiskLevel
  idempotent: boolean
  resultArtifactId?: string
  error?: PublicError
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

export interface PolicyDecision {
  effect: PolicyEffect
  riskLevel: RiskLevel
  reason: string
  ruleId: string
  reversible: boolean
  idempotent: boolean
  sendsDataOffDevice: boolean
  matchedGrantId?: string
}

export type ApprovalScope = 'once' | 'run_tool' | 'persistent_rule'
/** `session` = 「本会话总是允许此类操作」, stored as a run-scoped session rule. */
export type InteractiveApprovalScope = Exclude<ApprovalScope, 'persistent_rule'> | 'session'

export interface ApprovalDiffLine {
  kind: 'context' | 'add' | 'del'
  text: string
  oldLine?: number
  newLine?: number
}

export interface ApprovalDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ApprovalDiffLine[]
}

/** File change preview shown on an approval card before the user decides. */
export interface ApprovalDiffPreview {
  kind: 'file_diff'
  path: string
  operation: 'create' | 'modify' | 'delete'
  additions: number
  deletions: number
  hunks: ApprovalDiffHunk[]
  text: string
  truncated: boolean
  omittedLines: number
  binary: boolean
  tooLarge: boolean
  note?: string
}

/** Whether 「本会话总是允许此类操作」 is offered, and what it would cover. */
export interface ApprovalSessionRuleOffer {
  eligible: boolean
  label?: string
  reason?: string
}

export type SessionApprovalRuleKind = 'tool' | 'shell_prefix'

export interface SessionApprovalRule {
  id: string
  runId: string
  runTitle?: string
  kind: SessionApprovalRuleKind
  toolName: string
  riskLevel: RiskLevel
  commandPrefix?: string
  label: string
  useCount: number
  createdAt: IsoDateTime
  lastUsedAt?: IsoDateTime
}
export type ApprovalStatus = 'pending' | 'approved' | 'edited' | 'rejected' | 'expired'

export interface ApprovalRequest {
  id: string
  runId: string
  toolCallId: string
  toolName: string
  riskLevel: RiskLevel
  title: string
  reason: string
  target: string
  arguments: JsonValue
  sendsData: string[]
  reversible: boolean
  status: ApprovalStatus
  createdAt: IsoDateTime
  expiresAt?: IsoDateTime
  diff?: ApprovalDiffPreview
  sessionRule?: ApprovalSessionRuleOffer
}

export interface ApprovalGrant {
  id: string
  runId?: string
  toolName: string
  scope: ApprovalScope
  argumentFingerprint?: string
  approvedArguments?: JsonValue
  createdAt: IsoDateTime
  expiresAt?: IsoDateTime
  revokedAt?: IsoDateTime
}

export interface ApprovalResponse {
  requestId: string
  decision: 'approve' | 'edit' | 'reject'
  scope?: InteractiveApprovalScope
  editedArguments?: JsonValue
}

export type ContextKind =
  | 'platform_contract'
  | 'user_preferences'
  | 'workspace_rules'
  | 'skill'
  | 'task'
  | 'environment'
  | 'memory'
  | 'tool_result'
  | 'untrusted_content'
  | 'checkpoint'

export interface ContextItem {
  id: string
  kind: ContextKind
  content: string
  source: string
  trusted: boolean
  priority: number
  stable: boolean
  tokenEstimate?: number
  createdAt?: IsoDateTime
}

export type MemoryState = 'proposed' | 'confirmed' | 'disabled' | 'deleted'
export type MemoryType = 'stable_fact' | 'knowledge_background' | 'behavior_signal' | 'style_preference' | 'continuation'
export type MemoryScope = 'thread' | 'workspace' | 'user' | 'organization'

export interface MemorySource {
  kind: 'run' | 'message' | 'file' | 'user'
  reference: string
  excerpt?: string
}

export interface MemoryEntry {
  id: string
  workspaceId?: string
  type: MemoryType
  scope: MemoryScope
  state: MemoryState
  content: string
  confidence: number
  sources: MemorySource[]
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
  confirmedAt?: IsoDateTime
  disabledAt?: IsoDateTime
}

export interface SkillPermission {
  capability: 'filesystem_read' | 'filesystem_write' | 'shell' | 'network' | 'browser' | 'mcp'
  detail?: string
}

/** Where an installed Skill came from; used for update (re-import). */
export type SkillSource =
  | { kind: 'bundled' }
  | { kind: 'folder'; path: string; importedAt: IsoDateTime }
  | { kind: 'git'; url: string; ref?: string; subpath?: string; commit?: string; importedAt: IsoDateTime }

export interface SkillManifest {
  id: string
  name: string
  description: string
  version: string
  directory: string
  enabled: boolean
  permissions: SkillPermission[]
  entrypoint: string
  loadedAt?: IsoDateTime
  source?: SkillSource
}

/** stdio working directory: an app-owned empty folder, the run's workspace, or a folder the user picked. */
export type McpCwdMode = 'isolated' | 'workspace' | 'custom'

export type McpTransport =
  | {
      type: 'stdio'
      command: string
      args: string[]
      /** Names of environment variables whose values are stored encrypted. */
      envKeys: string[]
      /** Non-secret environment variables (values visible in settings). */
      env?: Record<string, string>
      cwdMode?: McpCwdMode
      cwd?: string
    }
  | {
      type: 'streamable_http'
      url: string
      auth: 'none' | 'bearer' | 'headers' | 'oauth'
      secretConfigured: boolean
      /** Non-secret request headers. */
      headers?: Record<string, string>
      /** Names of request headers whose values are stored encrypted. */
      secretHeaderKeys?: string[]
      /** Retry with the legacy HTTP+SSE transport when Streamable HTTP is not supported. */
      sseFallback?: boolean
    }

export interface McpToolSummary {
  name: string
  title?: string
  description?: string
  enabled: boolean
  readOnlyHint?: boolean
  destructiveHint?: boolean
}

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  toolNamespace: string
  serverVersion?: string
  schemaFingerprint?: string
  health: 'unknown' | 'healthy' | 'unhealthy' | 'authorizing'
  lastCheckedAt?: IsoDateTime
  lastError?: PublicError
  /** Tools discovered by the last successful connection test. */
  tools?: McpToolSummary[]
  disabledTools?: string[]
  /** Transport actually used by the last successful connection (SSE when fallback kicked in). */
  connectedVia?: 'stdio' | 'streamable_http' | 'sse'
}

export type AutomationSchedule =
  | { type: 'once'; runAt: IsoDateTime }
  | { type: 'interval'; everyMs: number; startsAt?: IsoDateTime }
  | { type: 'cron'; expression: string; timezone: string }

export interface AutomationSpec {
  id: string
  workspaceId: string
  name: string
  enabled: boolean
  objective: string
  modelProfileId: string
  schedule: AutomationSchedule
  normalizedSchedule: string
  nextRunAt?: IsoDateTime
  lastRunAt?: IsoDateTime
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

export interface ChromeTabGrant {
  id: string
  runId: string
  tabId: number
  windowId: number
  origin: string
  title: string
  grantedAt: IsoDateTime
  childTabIds: number[]
  revokedAt?: IsoDateTime
}

export interface ChromeBridgeStatus {
  extensionInstalled: boolean
  nativeHostInstalled: boolean
  connected: boolean
  version?: string
  lastSeenAt?: IsoDateTime
}

export interface Workspace {
  id: string
  name: string
  path: string
  selected: boolean
  rules?: string
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

export interface AppSettings {
  locale: string
  theme: 'system' | 'light' | 'dark'
  defaultExecutionMode: 'plan' | 'execute'
  defaultAccessMode: RunAccessMode
  permissionMode: PermissionMode
  defaultModelProfileId?: string
  subagentModelProfileId?: string
  launchAtLogin: boolean
  memoryEnabled: boolean
  detailedLogRetentionDays: number
  detailedLogMaxBytes: number
  defaultRunLimits: RunLimits
  timezone: string
}

export type PermissionMode = 'cautious' | 'balanced' | 'autonomous'

export interface PublicError {
  code: string
  message: string
  retryable: boolean
  suggestedAction?: string
  details?: JsonValue
}

export type AuditOutcome = 'started' | 'allowed' | 'blocked' | 'approved' | 'auto_approved' | 'rejected' | 'succeeded' | 'failed'

export interface AuditEntry {
  id: string
  runId?: string
  actor: 'user' | 'agent' | 'system' | 'tool'
  action: string
  target?: string
  outcome: AuditOutcome
  summary: string
  riskLevel?: RiskLevel
  durationMs?: number
  tokenUsage?: { input: number; output: number; cached: number }
  artifactIds?: string[]
  error?: PublicError
  createdAt: IsoDateTime
}

export interface VerificationSummary {
  status: CompletionStatus
  checks: Array<{ name: string; status: 'passed' | 'failed' | 'not_run'; detail?: string }>
  summary: string
}

/** A bounded, renderer-safe reference discovered or fetched by a tool call. */
export interface SourceRef {
  title: string
  url: string
  domain?: string
  snippet?: string
  fetchedAt?: IsoDateTime
  status?: 'discovered' | 'fetched' | 'failed'
}

/**
 * A durable tool receipt. Unlike ToolCall, this never contains full tool
 * output and its arguments have already crossed the public redaction boundary.
 */
export interface ToolReceipt {
  id: string
  runId: string
  toolName: string
  status: ToolCallStatus
  riskLevel: RiskLevel
  argumentsSummary: JsonValue
  resultSummary?: string
  sources: SourceRef[]
  error?: PublicError
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

/** A resolved or pending approval without the submitted decision payload. */
export interface ApprovalHistoryEntry extends ApprovalRequest {
  scope?: InteractiveApprovalScope
  resolvedAt?: IsoDateTime
}

export interface RunProgress {
  phase: 'thinking' | 'composing_tool' | 'executing' | 'verifying'
  message: string
  toolName?: string
  generatedChars?: number
  updatedAt: IsoDateTime
}

export type TraceSpanKind = 'run_turn' | 'context_stage' | 'model_turn' | 'tool_call' | 'approval_wait' | 'checkpoint' | 'verification' | 'managed_process'
export type TraceSpanStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting' | 'interrupted'

export interface RunTrace {
  id: string
  runId: string
  rootSpanId: string
  status: TraceSpanStatus
  startedAt: IsoDateTime
  endedAt?: IsoDateTime
  metadata: JsonValue
}

export interface TraceSpan {
  id: string
  traceId: string
  parentSpanId?: string
  kind: TraceSpanKind
  name: string
  status: TraceSpanStatus
  startedAt: IsoDateTime
  endedAt?: IsoDateTime
  durationMs?: number
  usage?: JsonValue
  error?: JsonValue
  attributes: JsonValue
  artifactIds: string[]
}

export interface RunDetail {
  run: Run
  steps: TaskStep[]
  messages: ConversationMessage[]
  pendingApprovals: ApprovalRequest[]
  toolCalls: ToolReceipt[]
  approvalHistory: ApprovalHistoryEntry[]
  artifacts: ArtifactRef[]
  verification?: VerificationSummary
  progress?: RunProgress
  traces?: RunTrace[]
  traceSpans?: TraceSpan[]
}

export interface BootstrapSnapshot {
  app: { name: string; version: string; platform: string; arch: string; locale: string }
  onboardingComplete: boolean
  settings: AppSettings
  selectedWorkspaceId?: string
  workspaces: Workspace[]
  modelProfiles: ModelProfile[]
  chrome: ChromeBridgeStatus
}

export type RunEvent =
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'run.updated'; run: Run }
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'message.delta'; messageId: string; delta: string }
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'message.completed'; message: ConversationMessage }
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'step.updated'; step: TaskStep }
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'tool.updated'; toolCall: ToolCall }
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'approval.requested'; approval: ApprovalRequest }
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'artifact.created'; artifact: ArtifactRef }
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'verification.completed'; verification: VerificationSummary }
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'progress.updated'; progress: RunProgress }
  | { id: string; runId: string; sequence: number; at: IsoDateTime; kind: 'error'; error: PublicError }

export interface PageRequest {
  cursor?: string
  limit?: number
}

export interface Page<T> {
  items: T[]
  nextCursor?: string
}
