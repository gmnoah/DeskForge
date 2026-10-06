import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ApprovalDiffPreview, ApprovalRequest, ApprovalResponse, ApprovalSessionRuleOffer, JsonValue, MemoryEntry, RunEvent, TaskStep, ToolCall, ToolDescriptor, VerificationSummary } from '@deskforge/contracts'
import {
  createApprovalRequest,
  createFileDiff,
  evaluateCompletionGate,
  evaluateToolPolicy,
  findDestructiveShellOutsideWorkspace,
  matchSessionRule,
  redactSecrets,
  resolveApproval,
  sessionRuleEligibility,
  type SessionRule,
  type SessionRuleCandidate,
  type SessionRuleSpec,
} from '@deskforge/core'
import type { AppDatabase } from './database'
import type { ArtifactStore } from './artifact-store'
import type { ChromeBridge } from './chrome-bridge'
import type { SecretStore } from './secret-store'
import { effectiveRisk, TOOL_DEFINITIONS, type ToolDefinition } from './tool-registry'
import { assertToolArguments } from './tool-argument-validator'
import type { ToolRunnerBridge } from './worker-bridge'
import type { DocumentRenderService } from './document-render-service'

interface PendingApproval {
  approval: ApprovalRequest
  receiptId: string
  tool: ToolDefinition
  args: Record<string, unknown>
  resolve: (args: Record<string, unknown>) => void
  reject: (error: Error) => void
  onceOnly: boolean
  sessionSpec?: SessionRuleSpec
}

/** Tools whose approval card shows a diff of the pending file change. */
const DIFF_PREVIEW_TOOLS = new Set(['file_write', 'file_replace', 'file_draft_commit', 'file_delete'])
const APPROVAL_DIFF_MAX_LINES = 400
const ARTIFACT_DIFF_MAX_LINES = 20_000

/** The slice of McpService the broker needs; optional so tests can omit MCP. */
export interface McpBrokerBridge {
  blockedReason(serverId: unknown, toolName?: unknown): string | undefined
  runtimeServer(id: string, context: { workspaceRoot?: string }): Promise<Record<string, any>>
  disabledTools(serverId: string): string[]
}

const sourceFor = (id: string): ToolDescriptor['source'] => id.startsWith('chrome_') ? 'chrome' : id.startsWith('mcp_') ? 'mcp' : 'builtin'
const policyName = (id: string): string => ({
  file_list: 'file.list', file_read: 'file.read', file_search: 'file.search', file_find: 'file.glob', attachment_open: 'attachment.open', output_register: 'output.register', file_write: 'file.write', file_draft_start: 'file.stage', file_draft_append: 'file.stage', file_draft_commit: 'file.write', file_replace: 'file.edit', file_delete: 'file.delete',
  document_render: 'document.render',
  shell_run: 'shell.command', process_start: 'shell.process', process_poll: 'process.poll', process_stop: 'process.stop', web_search: 'web.search', web_fetch: 'web.fetch', mcp_list_tools: 'mcp.list', mcp_call_tool: 'mcp.call', skill_read: 'skill.read', memory_propose: 'memory.propose',
  task_plan: 'task.plan', task_complete: 'task.complete', agent_delegate: 'agent.delegate', chrome_tabs: 'chrome.read', chrome_snapshot: 'chrome.read_dom',
  chrome_screenshot: 'chrome.screenshot', chrome_navigate: 'chrome.navigate', chrome_click: 'chrome.click', chrome_type: 'chrome.input_sensitive', chrome_open_tab: 'chrome.navigate',
}[id] ?? id)

function descriptorFor(tool: ToolDefinition): ToolDescriptor {
  const source = sourceFor(tool.id)
  const readonly = tool.risk === 'read'
  return {
    name: policyName(tool.id),
    title: tool.label,
    description: tool.description,
    source,
    inputSchema: tool.parameters as JsonValue,
    annotations: {
      readOnlyHint: readonly,
      destructiveHint: tool.risk === 'high',
      externalSideEffectHint: tool.risk === 'external',
      idempotentHint: readonly,
      sendsDataOffDeviceHint: source === 'chrome' || source === 'mcp' || tool.id === 'web_search' || tool.id === 'web_fetch',
    },
  }
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|credential)/i

function redactValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    const sanitized = value.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET)[A-Za-z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    return sanitized.length > 2_000 ? `${sanitized.slice(0, 2_000)}…[${sanitized.length} chars]` : sanitized
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactValue(child, childKey)]))
}

function loggedArguments(toolId: string, args: Record<string, unknown>): JsonValue {
  const copy = redactValue(args) as Record<string, unknown>
  if (toolId === 'file_write' && typeof args.content === 'string') copy.content = `[FILE CONTENT REDACTED: ${args.content.length} chars]`
  if ((toolId === 'file_draft_start' || toolId === 'file_draft_append') && typeof args.content === 'string') copy.content = `[DRAFT CONTENT REDACTED: ${args.content.length} chars]`
  if (toolId === 'file_replace') {
    if (typeof args.oldText === 'string') copy.oldText = `[OLD TEXT REDACTED: ${args.oldText.length} chars]`
    if (typeof args.newText === 'string') copy.newText = `[NEW TEXT REDACTED: ${args.newText.length} chars]`
  }
  if (toolId === 'chrome_type' && typeof args.text === 'string') copy.text = `[INPUT REDACTED: ${args.text.length} chars]`
  return asJson(copy)
}

function persistedResult(result: unknown): JsonValue {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return asJson(redactValue(result))
  const source = result as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (['content', 'text', 'preview', 'before', 'after', 'data'].includes(key)) {
      safe[key] = `[CONTENT OMITTED${typeof value === 'string' ? `: ${value.length} chars` : ''}]`
      continue
    }
    safe[key] = redactValue(value, key)
  }
  return asJson(safe)
}

const MEMORY_KIND_MAP: Record<string, MemoryEntry['type']> = {
  fact: 'stable_fact',
  stable_fact: 'stable_fact',
  knowledge: 'knowledge_background',
  knowledge_background: 'knowledge_background',
  behavior: 'behavior_signal',
  behavior_signal: 'behavior_signal',
  style: 'style_preference',
  style_preference: 'style_preference',
  continuation: 'continuation',
}

const TOOL_STATUSES = new Set<ToolCall['status']>(['requested', 'waiting_approval', 'running', 'succeeded', 'failed', 'cancelled'])
const STEP_STATUSES = new Set<TaskStep['status']>(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'skipped'])
const FILE_MUTATION_TOOLS = new Set(['file_write', 'file_draft_commit', 'file_replace', 'file_delete', 'document_render'])
const MAX_FILE_DRAFT_CHARS = 2 * 1024 * 1024
const MAX_UNIQUE_SEARCHES_PER_TURN = 10
const PUBLIC_SKILL_ROOT_FILES = new Set(['SKILL.md', 'README.md', 'LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md'])
const PUBLIC_SKILL_DIRECTORIES = new Set(['scripts', 'references', 'reference', 'docs', 'examples', 'templates', 'assets'])
const SENSITIVE_SKILL_RESOURCE = /^(?:\.env(?:\..+)?|(?:config|secrets?|credentials?|tokens?|auth|api[-_]?keys?|private[-_]?keys?)(?:\.[a-z0-9_-]+)*\.(?:json|ya?ml|toml|ini|conf|env)|(?:secret|secrets|credential|credentials|token|tokens|auth)|.+\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i
const SENSITIVE_OUTPUT_FILE = /^(?:\.env(?:\..+)?|.*(?:secret|credential|token|api[-_]?key|private[-_]?key).*(?:json|ya?ml|toml|ini|conf|env)?|.+\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i
const MAX_OUTPUT_FILES = 100
const MAX_OUTPUT_FILE_BYTES = 50 * 1024 * 1024
const MAX_OUTPUT_TOTAL_BYTES = 250 * 1024 * 1024
const HARD_PROTECTED_TARGET = /(?:Library\/Keychains|Library\/Application Support\/(?:Google\/Chrome|DeskForge)\/(?:Cookies|Login Data|deskforge\.sqlite3)|\.ssh\/(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\s|$|["']))/i
const SENSITIVE_TARGET = /(?:^|[\s/"'])(?:\.env(?:\.[^\s/"']+)?|\.npmrc|\.aws\/credentials|\.config\/gcloud|\.azure|\.kube\/config)(?:$|[\s/"'])/i

function parseJson(value: unknown, fallback: JsonValue = {}): JsonValue {
  if (typeof value !== 'string') return fallback
  try { return asJson(JSON.parse(value)) } catch { return fallback }
}

function validationCommand(command: string): boolean {
  return /(?:^|\s)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b|\b(?:vitest|jest|pytest|eslint|xcodebuild|tsc\s+--noEmit|cargo\s+(?:test|check|build)|go\s+test|swift\s+test|git\s+diff\s+--check)\b/i.test(command)
}

function toolTargetFingerprint(row: any): string {
  const args = parseJson(row.arguments_json)
  if (!args || Array.isArray(args) || typeof args !== 'object') return String(row.tool_id)
  const record = args as Record<string, unknown>
  const target = record.path ?? record.url ?? record.serverId ?? record.tabId ?? record.command ?? ''
  const action = record.toolName ?? record.selector ?? ''
  return `${String(row.tool_id)}:${String(target).normalize('NFKC').trim()}:${String(action).normalize('NFKC').trim()}`
}

function readOnlyRun(raw: any): boolean {
  return Boolean(raw?.readOnly ?? raw?.read_only ?? raw?.permissions?.readOnly)
}

function evaluateRunAccessPolicy(
  call: ToolCall,
  descriptor: ToolDescriptor,
): ReturnType<typeof evaluateToolPolicy> {
  const decision = evaluateToolPolicy({ call, descriptor })
  const serialized = JSON.stringify(call.arguments)
  if (HARD_PROTECTED_TARGET.test(serialized)) return { ...decision, effect: 'deny', reason: '应用密钥库、浏览器凭据和 SSH 私钥属于不可委派边界。', ruleId: 'security.protected-credential-store', sendsDataOffDevice: false }
  // Skill packages and final-output registration have stricter, purpose-built
  // secret filters. Let those tools reject with their stable diagnostic codes
  // instead of turning a guaranteed denial into a dangling approval wait.
  if (SENSITIVE_TARGET.test(serialized) && descriptor.name !== 'skill.read' && descriptor.name !== 'output.register') {
    return { ...decision, effect: 'require_approval', reason: '操作涉及环境变量或凭据配置，必须逐次确认。', ruleId: 'security.sensitive-file-once' }
  }
  return decision
}

function assertWorkspaceRoot(root: string): string {
  const normalized = root.replace(/\/+$/, '') || root
  if (normalized === '' || normalized === '/' || normalized === '\\') {
    throw Object.assign(new Error('工作区不能是磁盘根目录 /。请选择一个具体目录。'), { code: 'WORKSPACE_ROOT_FORBIDDEN' })
  }
  return root
}

export class ToolBroker {
  private pendingApprovals = new Map<string, PendingApproval>()
  private fileLeaseTails = new Map<string, Promise<void>>()
  private fileDrafts = new Map<string, { runId: string; path: string; content: string; expectedSha256?: string }>()
  private lastToolProgressAt = new Map<string, number>()

  constructor(
    private database: AppDatabase,
    private runner: ToolRunnerBridge,
    private artifacts: ArtifactStore,
    private chrome: ChromeBridge,
    private secrets: SecretStore,
    private emit: (event: RunEvent) => void,
    private delegate: (input: { parentRunId: string; task: string; role: string }) => Promise<unknown>,
    private refreshMcpOAuth?: (serverId: string, serverUrl: string) => Promise<void>,
    private documentRenderer?: DocumentRenderService,
    private mcp?: McpBrokerBridge,
  ) {}

  /**
   * Apply the same deterministic completion gate when a model ends an
   * operational turn without explicitly calling task_complete. Plain chat
   * remains completion-status-free; tool work can no longer silently bypass
   * pending steps, failed mutations, or missing verification.
   */
  finalizeTurn(runId: string, summary: string): ReturnType<ToolBroker['completeTask']> {
    return this.completeTask(runId, { summary, evidence: [], unverified: [] })
  }

  async handle(input: { runId: string; requestId: string; toolCallId: string; toolId: string; args: Record<string, unknown> }): Promise<unknown> {
    const definition = TOOL_DEFINITIONS.find((candidate) => candidate.id === input.toolId)
    if (!definition) throw new Error(`未知工具：${input.toolId}`)
    // Arguments cross a trust boundary from the model worker. Validate before
    // policy classification, persistence or any execution side effect.
    assertToolArguments(definition.id, definition.parameters, input.args)
    const tool: ToolDefinition = { ...definition, risk: effectiveRisk(definition, input.args) }
    let rawRun = this.database.getRun(input.runId)
    if (!rawRun) throw new Error('任务不存在')
    if (rawRun.status === 'verifying' && input.toolId !== 'task_complete') {
      this.database.transitionRun(input.runId, 'running', { outcome: null, summary: '', finishedAt: null })
      rawRun = this.database.getRun(input.runId)
    }
    const descriptor = descriptorFor(tool)
    const call: ToolCall = {
      id: input.toolCallId,
      runId: input.runId,
      toolName: descriptor.name,
      source: descriptor.source,
      arguments: asJson(input.args),
      status: 'requested',
      idempotent: tool.risk === 'read',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    // The composer owns this run's durable authority. Ask mode uses the
    // conservative base policy. Full-disk mode widens the filesystem root and
    // auto-executes ordinary local work plus public reads. Destructive,
    // publishing, uploading and other high-risk external effects still need a
    // one-shot approval; TCC and product-level app-control denials also win.
    const baseDecision = evaluateRunAccessPolicy(call, descriptor)
    const memoryDisabled = tool.id === 'memory_propose' && this.database.getSetting<any>('appSettings', {}).memoryEnabled === false
    const readOnlyViolation = readOnlyRun(rawRun) && (
      tool.risk !== 'read' ||
      tool.id === 'memory_propose' ||
      (tool.id === 'agent_delegate' && input.args.role === 'general')
    )
    const destructiveEscape = this.destructiveShellEscape(rawRun, tool, input.args)
    const mcpBlocked = tool.id.startsWith('mcp_') && this.mcp
      ? this.mcp.blockedReason(input.args.serverId, tool.id === 'mcp_call_tool' ? input.args.toolName : undefined)
      : undefined
    const decision = memoryDisabled
      ? { ...baseDecision, effect: 'deny' as const, reason: 'Memory 已在设置中关闭。', ruleId: 'memory.disabled' }
      : mcpBlocked
        ? { ...baseDecision, effect: 'deny' as const, reason: mcpBlocked, ruleId: 'mcp.disabled' }
      : readOnlyViolation
        ? { ...baseDecision, effect: 'deny' as const, reason: '只读子 Agent 不允许执行该操作。', ruleId: 'run.readonly-capability' }
        : destructiveEscape
          ? { ...baseDecision, effect: 'deny' as const, riskLevel: 'high_risk_irreversible' as const, reason: `已阻止：${destructiveEscape.executable} 的${destructiveEscape.reason}（${destructiveEscape.target}）。删除类命令只能作用于授权工作区内的路径。`, ruleId: 'security.destructive-outside-workspace' }
          : baseDecision
    call.idempotent = decision.idempotent
    const providerCall: ToolCall = { ...call, arguments: loggedArguments(input.toolId, input.args) }
    // Provider call ids are scoped to a provider response and are routinely
    // reused across new runs/resumed turns. Persist under an application-owned
    // receipt id while keeping the original id for model and approval semantics.
    const receiptId = this.database.createToolCall({ providerCallId: call.id, runId: call.runId, toolId: input.toolId, risk: decision.riskLevel, arguments: providerCall.arguments })
    const receiptCall: ToolCall = { ...providerCall, id: receiptId }
    const rawTarget = String(input.args.path ?? input.args.outputPath ?? input.args.inputPath ?? input.args.url ?? input.args.query ?? input.args.command ?? input.toolId)
    const searchShortcut = input.toolId === 'web_search' ? this.searchShortcut(input.runId, input.args) : undefined
    if (searchShortcut) {
      this.database.audit('tool', input.toolId, `Agent 请求 ${tool.label}`, { actor: 'agent', outcome: 'allow', riskLevel: 'readonly', target: redactValue(rawTarget, 'target') as string, shortcut: searchShortcut.kind }, input.runId)
      this.database.updateToolCall(receiptId, 'running')
      this.emitTool(input.runId, receiptCall, 'running', 'readonly')
      this.database.updateToolCall(receiptId, 'succeeded', persistedResult(searchShortcut.result))
      this.database.audit('tool', input.toolId, searchShortcut.kind === 'cached' ? '复用已有搜索结果' : '搜索预算已收敛', { actor: 'tool', outcome: 'succeeded', riskLevel: 'readonly' }, input.runId)
      this.emitTool(input.runId, receiptCall, 'succeeded', 'readonly')
      return searchShortcut.result
    }
    this.database.audit('tool', input.toolId, `Agent 请求 ${tool.label}`, { actor: 'agent', outcome: decision.effect, riskLevel: decision.riskLevel, target: redactValue(rawTarget, 'target') as string }, input.runId)

    let args = input.args
    const onceOnly = decision.riskLevel === 'external_side_effect' || decision.riskLevel === 'high_risk_irreversible' || decision.ruleId === 'security.sensitive-file-once'
    const hasGrant = !onceOnly && this.database.hasRunGrant(input.runId, descriptor.name, asJson(input.args))
    if (decision.effect === 'deny') {
      const error = Object.assign(new Error(decision.reason), { code: decision.ruleId })
      this.database.updateToolCall(receiptId, 'failed', undefined, error.message)
      this.emitTool(input.runId, { ...receiptCall, error: { code: decision.ruleId, message: error.message, retryable: false } }, 'failed', decision.riskLevel)
      throw error
    }
    if (decision.effect === 'require_approval' && !hasGrant) {
      const candidate = this.sessionCandidate(input.runId, tool, decision, input.args)
      const sessionRule = matchSessionRule(this.activeSessionRules(input.runId), candidate)
      if (sessionRule) {
        // Auto-approved by 「本会话总是允许此类操作」; still fully audited.
        this.database.touchSessionRule(sessionRule.id)
        this.database.audit('approval', input.toolId, `会话规则自动批准 ${tool.label}`, {
          actor: 'system', outcome: 'auto_approved', riskLevel: decision.riskLevel, target: redactValue(rawTarget, 'target') as string,
          sessionRule: { id: sessionRule.id, kind: sessionRule.kind, label: sessionRule.label, ...(sessionRule.commandPrefix ? { commandPrefix: sessionRule.commandPrefix } : {}) },
        }, input.runId)
        this.database.appendRunEvent(input.runId, 'approval.auto_approved', `已按会话规则自动允许：${tool.label}`, { ruleId: sessionRule.id, label: sessionRule.label, toolId: input.toolId })
      } else {
        args = await this.waitForApproval(input.runId, providerCall, receiptId, tool, decision, input.args, candidate)
      }
    }

    this.database.updateToolCall(receiptId, 'running')
    this.emitTool(input.runId, receiptCall, 'running', decision.riskLevel)
    const releaseLease = await this.acquireFileLease(rawRun, tool, args)
    try {
      const result = await this.execute(input.runId, input.requestId, tool, args)
      this.database.updateToolCall(receiptId, 'succeeded', persistedResult(result))
      this.database.audit('tool', input.toolId, `${tool.label}完成`, { actor: 'tool', outcome: 'succeeded', riskLevel: decision.riskLevel }, input.runId)
      this.emitTool(input.runId, receiptCall, 'succeeded', decision.riskLevel)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const safeMessage = String(redactValue(message))
      this.database.updateToolCall(receiptId, 'failed', undefined, safeMessage)
      this.database.audit('tool', input.toolId, `${tool.label}失败`, { actor: 'tool', outcome: 'failed', riskLevel: decision.riskLevel }, input.runId)
      this.emitTool(input.runId, { ...receiptCall, error: { code: (error as any)?.code ?? 'TOOL_FAILED', message: safeMessage, retryable: decision.idempotent } }, 'failed', decision.riskLevel)
      throw error
    } finally {
      this.lastToolProgressAt.delete(input.requestId)
      releaseLease()
    }
  }

  private searchShortcut(runId: string, args: Record<string, unknown>): { kind: 'cached' | 'budget'; result: JsonValue } | undefined {
    const normalizedQuery = String(args.query ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
    if (!normalizedQuery) return undefined
    const turnStartedAt = this.database.getCurrentRunTurnStartedAt(runId)
    const rows = (turnStartedAt
      ? this.database.db.prepare(`SELECT tool_id,state,arguments_json,result_json,created_at FROM tool_calls
          WHERE run_id=? AND tool_id='web_search' AND created_at>=? ORDER BY created_at`).all(runId, turnStartedAt)
      : this.database.db.prepare(`SELECT tool_id,state,arguments_json,result_json,created_at FROM tool_calls
          WHERE run_id=? AND tool_id='web_search' ORDER BY created_at`).all(runId)) as any[]
    const prior = rows.filter((row) => String(row.tool_id) === 'web_search' && ['succeeded', 'failed', 'cancelled'].includes(String(row.state))).map((row) => {
      const previousArgs = parseJson(row.arguments_json) as Record<string, unknown>
      const query = String(previousArgs.query ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
      return { row, query }
    }).filter(({ query }) => Boolean(query))
    const cached = [...prior].reverse().find(({ row, query }) => query === normalizedQuery && row.state === 'succeeded' && row.result_json)
    if (cached) {
      const result = parseJson(cached.row.result_json)
      if (result && typeof result === 'object') return { kind: 'cached', result }
    }
    const uniqueQueries = new Set(prior.map(({ query }) => query))
    if (uniqueQueries.size < MAX_UNIQUE_SEARCHES_PER_TURN) return undefined
    return {
      kind: 'budget',
      result: asJson({
        engine: 'local-budget',
        query: String(args.query),
        resultCount: 0,
        results: [],
        budgetExhausted: true,
        uniqueSearches: uniqueQueries.size,
        message: `本轮已使用 ${MAX_UNIQUE_SEARCHES_PER_TURN} 个不同搜索词。请基于已有来源收敛、读取已发现的原文并完成任务，不要用同义词继续搜索。`,
      }),
    }
  }

  private async acquireFileLease(run: any, tool: ToolDefinition, args: Record<string, unknown>): Promise<() => void> {
    if (!FILE_MUTATION_TOOLS.has(tool.id)) return () => undefined
    const workspace = this.database.getWorkspace(run.workspaceId ?? run.workspace_id)
    if (!workspace?.root_path) throw Object.assign(new Error('任务工作区不存在或已被移除'), { code: 'WORKSPACE_REQUIRED' })
    const root = String(workspace.root_path)
    const requestedPath = tool.id === 'document_render'
      ? String(args.outputPath ?? `${String(args.inputPath).replace(/\.md$/i, '')}.pdf`)
      : typeof args.path === 'string' ? args.path : undefined
    if (!requestedPath) return () => undefined
    const absolute = resolve(root, requestedPath).normalize('NFC')
    const key = process.platform === 'darwin' ? absolute.toLocaleLowerCase('en-US') : absolute
    const previous = this.fileLeaseTails.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const current = new Promise<void>((resolveCurrent) => { unlock = resolveCurrent })
    const tail = previous.then(() => current)
    this.fileLeaseTails.set(key, tail)
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      unlock()
      if (this.fileLeaseTails.get(key) === tail) this.fileLeaseTails.delete(key)
    }
  }

  private async waitForApproval(runId: string, call: ToolCall, receiptId: string, tool: ToolDefinition, decision: ReturnType<typeof evaluateToolPolicy>, args: Record<string, unknown>, candidate: SessionRuleCandidate): Promise<Record<string, unknown>> {
    const id = randomUUID()
    const created = createApprovalRequest({
      id, call, decision, title: tool.label,
      target: tool.id === 'mcp_call_tool'
        ? `${String(this.database.getMcpServer(String(args.serverId))?.name ?? args.serverId)} · ${String(args.toolName)}`
        : String(args.path ?? args.url ?? args.query ?? args.command ?? args.selector ?? tool.id),
      sendsData: decision.sendsDataOffDevice ? [tool.id === 'mcp_call_tool' ? '工具参数会交给 MCP Server，可能发送到外部系统' : '工具参数可能发送到外部系统'] : [],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    const eligibility = sessionRuleEligibility(candidate)
    const sessionRule: ApprovalSessionRuleOffer = eligibility.eligible ? { eligible: true, label: eligibility.spec.label } : { eligible: false, reason: eligibility.reason }
    const diff = await this.buildDiffPreview(runId, receiptId, tool, args, decision.ruleId === 'security.sensitive-file-once')
    const approval: ApprovalRequest = { ...created, sessionRule, ...(diff ? { diff } : {}) }
    // The FK targets the durable receipt, while the public approval keeps the
    // provider id produced by the model. This separation survives reloads.
    this.database.createApproval({ id, runId, toolCallId: receiptId, reason: approval.reason, preview: { ...approval, toolCallId: call.id, arguments: loggedArguments(tool.id, args) } })
    this.database.updateToolCall(receiptId, 'waiting_approval')
    this.database.transitionRun(runId, 'waiting_approval', { outcome: null, finishedAt: null })
    this.emit({ id: randomUUID(), runId, sequence: Date.now(), at: new Date().toISOString(), kind: 'approval.requested', approval })
    const onceOnly = decision.riskLevel === 'external_side_effect' || decision.riskLevel === 'high_risk_irreversible' || decision.ruleId === 'security.sensitive-file-once'
    return new Promise((resolve, reject) => this.pendingApprovals.set(id, { approval, receiptId, tool, args, resolve, reject, onceOnly, ...(eligibility.eligible ? { sessionSpec: eligibility.spec } : {}) }))
  }

  private sessionCandidate(runId: string, tool: ToolDefinition, decision: ReturnType<typeof evaluateToolPolicy>, args: Record<string, unknown>): SessionRuleCandidate {
    return {
      runId,
      toolId: tool.id,
      toolLabel: tool.label,
      effect: decision.effect,
      riskLevel: decision.riskLevel,
      ruleId: decision.ruleId,
      sendsDataOffDevice: decision.sendsDataOffDevice,
      ...(typeof args.command === 'string' ? { command: args.command } : {}),
    }
  }

  private activeSessionRules(runId: string): SessionRule[] {
    return this.database.listSessionRules(runId).map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      kind: row.kind === 'shell_prefix' ? 'shell_prefix' as const : 'tool' as const,
      toolId: String(row.tool_id),
      riskLevel: row.risk_level,
      label: String(row.label),
      createdAt: String(row.created_at),
      ...(row.command_prefix ? { commandPrefix: String(row.command_prefix) } : {}),
    }))
  }

  revokeSessionRule(id: string): void {
    const rule = this.database.getSessionRule(id)
    if (!rule || rule.revoked_at) throw Object.assign(new Error('会话规则不存在或已撤销'), { code: 'SESSION_RULE_NOT_FOUND' })
    this.database.revokeSessionRule(id, 'user')
    this.database.audit('approval', 'session_rule_revoked', `撤销会话规则：${String(rule.label)}`, { actor: 'user', outcome: 'succeeded', sessionRule: { id, label: rule.label, kind: rule.kind } }, rule.run_id)
  }

  /** Blocks destructive shell commands aimed outside the workspace before any approval. */
  private destructiveShellEscape(run: any, tool: ToolDefinition, args: Record<string, unknown>): ReturnType<typeof findDestructiveShellOutsideWorkspace> {
    if ((tool.id !== 'shell_run' && tool.id !== 'process_start') || typeof args.command !== 'string') return undefined
    const workspace = this.database.getWorkspace(run?.workspaceId ?? run?.workspace_id)
    const root = workspace?.root_path ? String(workspace.root_path) : undefined
    if (!root) return undefined
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? resolve(root, args.cwd) : root
    return findDestructiveShellOutsideWorkspace(args.command, root, cwd)
  }

  /** Reads the current file through the confined runner and simulates the pending change. */
  private async buildDiffPreview(runId: string, receiptId: string, tool: ToolDefinition, args: Record<string, unknown>, sensitive: boolean): Promise<ApprovalDiffPreview | undefined> {
    if (!DIFF_PREVIEW_TOOLS.has(tool.id)) return undefined
    const draft = tool.id === 'file_draft_commit' ? this.fileDrafts.get(String(args.draftId)) : undefined
    const path = String(draft?.path ?? args.path ?? '')
    if (!path) return undefined
    const empty = (operation: ApprovalDiffPreview['operation'], note: string): ApprovalDiffPreview => ({ kind: 'file_diff', path, operation, additions: 0, deletions: 0, hunks: [], text: '', truncated: false, omittedLines: 0, binary: false, tooLarge: false, note })
    try {
      const run = this.database.getRun(runId)
      const workspace = run ? this.database.getWorkspace(run.workspaceId) : undefined
      if (!workspace?.root_path) return undefined
      const authorizedRoot = assertWorkspaceRoot(String(workspace.root_path))
      let before: string | null = null
      try {
        const current = await this.runner.execute({ runId, requestId: `${receiptId}-preview`, toolId: 'file.read', args: { path }, workspacePath: workspace.root_path, authorizedRoot })
        before = typeof current?.content === 'string' ? current.content : null
      } catch (error: any) {
        if (error?.code !== 'ENOENT') return empty(tool.id === 'file_delete' ? 'delete' : 'modify', `无法读取当前文件，未生成预览：${String(redactValue(error?.message ?? error)).slice(0, 200)}`)
      }
      let after: string | null
      let note: string | undefined
      if (tool.id === 'file_delete') {
        if (before === null) return empty('delete', '目标文件不存在')
        after = null
      } else if (tool.id === 'file_replace') {
        if (before === null) return empty('modify', '目标文件不存在，替换会失败')
        const oldText = String(args.oldText ?? '')
        const newText = String(args.newText ?? '')
        if (!oldText || !before.includes(oldText)) { after = before; note = '未在当前文件中找到要替换的文本，执行时会失败' } else after = args.replaceAll === true ? before.split(oldText).join(newText) : before.replace(oldText, () => newText)
      } else {
        after = String(draft?.content ?? args.content ?? '')
      }
      const diff = createFileDiff({ path, before, after, maxLines: APPROVAL_DIFF_MAX_LINES })
      if (sensitive) {
        return { kind: 'file_diff', path, operation: diff.operation, additions: diff.additions, deletions: diff.deletions, hunks: [], text: '', truncated: false, omittedLines: 0, binary: diff.binary, tooLarge: diff.tooLarge, note: '敏感配置文件不在审批卡中显示内容，仅显示变更行数' }
      }
      const redactLine = (text: string): string => redactSecrets(text)
      return {
        kind: 'file_diff',
        path,
        operation: diff.operation,
        additions: diff.additions,
        deletions: diff.deletions,
        hunks: diff.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => ({ ...line, text: redactLine(line.text) })) })),
        text: redactSecrets(diff.text),
        truncated: diff.truncated,
        omittedLines: diff.omittedLines,
        binary: diff.binary,
        tooLarge: diff.tooLarge,
        ...(note ?? diff.note ? { note: note ?? diff.note } : {}),
      }
    } catch (error: any) {
      return empty(tool.id === 'file_delete' ? 'delete' : 'modify', `预览生成失败：${String(redactValue(error?.message ?? error)).slice(0, 200)}`)
    }
  }

  respondToApproval(response: ApprovalResponse): void {
    const pending = this.pendingApprovals.get(response.requestId)
    if (!pending) throw new Error('审批不存在或已失效')
    // Session rules require an eligible offer computed when the card was created;
    // otherwise (or for edited arguments) the approval degrades to a one-shot.
    const sessionSpec = response.scope === 'session' && response.decision === 'approve' && !pending.onceOnly ? pending.sessionSpec : undefined
    const effectiveResponse = (pending.onceOnly && response.scope === 'run_tool') || (response.scope === 'session' && !sessionSpec) ? { ...response, scope: 'once' as const } : response
    const resolution = resolveApproval(pending.approval, effectiveResponse, { grantId: randomUUID() })
    if (resolution.executionArguments !== undefined) {
      // An edited approval is a second untrusted argument source. Keep the
      // approval pending if validation fails so the user can correct it.
      assertToolArguments(pending.tool.id, pending.tool.parameters, resolution.executionArguments)
      const editedDecision = evaluateToolPolicy({
        call: {
          id: pending.approval.toolCallId,
          runId: pending.approval.runId,
          toolName: pending.approval.toolName,
          source: descriptorFor(pending.tool).source,
          arguments: resolution.executionArguments,
          status: 'waiting_approval',
          idempotent: pending.tool.risk === 'read',
          createdAt: pending.approval.createdAt,
          updatedAt: new Date().toISOString(),
        },
        descriptor: descriptorFor(pending.tool),
      })
      const riskRank = { readonly: 0, reversible_write: 1, external_side_effect: 2, high_risk_irreversible: 3 } as const
      if (editedDecision.effect === 'deny' || riskRank[editedDecision.riskLevel] > riskRank[pending.approval.riskLevel]) {
        throw Object.assign(new Error('编辑后的参数改变了权限风险，请修改为同级操作后重试'), { code: 'APPROVAL_POLICY_CHANGED' })
      }
    }
    this.pendingApprovals.delete(response.requestId)
    this.database.resolveApproval(response.requestId, effectiveResponse)
    if (resolution.request.status === 'rejected' || !resolution.executionArguments) {
      this.database.audit('approval', pending.tool.id, `用户拒绝 ${pending.tool.label}`, { actor: 'user', outcome: 'rejected', riskLevel: pending.approval.riskLevel }, pending.approval.runId)
      this.database.updateToolCall(pending.receiptId, 'failed', undefined, '用户拒绝了该操作')
      pending.reject(new Error('用户拒绝了该操作'))
      if (!this.database.hasPendingApprovals(pending.approval.runId)) this.database.transitionRun(pending.approval.runId, 'running')
      return
    }
    if (resolution.grant && resolution.grant.scope === 'run_tool') this.database.addGrant(resolution.grant.runId ?? null, resolution.grant.toolName, resolution.grant.scope, resolution.grant.approvedArguments ?? {})
    const createdRule = sessionSpec ? this.database.addSessionRule({ runId: pending.approval.runId, ...sessionSpec, sourceApprovalId: pending.approval.id }) : undefined
    this.database.audit('approval', pending.tool.id, `用户批准 ${pending.tool.label}${createdRule ? '，并在本会话总是允许此类操作' : ''}`, {
      actor: 'user', outcome: 'approved', riskLevel: pending.approval.riskLevel, scope: effectiveResponse.scope ?? 'once',
      ...(createdRule ? { sessionRule: { id: createdRule.id, kind: createdRule.kind, label: createdRule.label, ...(createdRule.command_prefix ? { commandPrefix: createdRule.command_prefix } : {}), created: true } } : {}),
    }, pending.approval.runId)
    if (!this.database.hasPendingApprovals(pending.approval.runId)) this.database.transitionRun(pending.approval.runId, 'running')
    pending.resolve(resolution.executionArguments as Record<string, unknown>)
  }

  rejectRunApprovals(runId: string, reason = '任务已取消'): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.approval.runId !== runId) continue
      this.pendingApprovals.delete(id); pending.reject(new Error(reason))
    }
    for (const [draftId, draft] of this.fileDrafts) if (draft.runId === runId) this.fileDrafts.delete(draftId)
  }

  private async execute(runId: string, requestId: string, tool: ToolDefinition, args: Record<string, unknown>): Promise<any> {
    if (tool.id === 'file_draft_start') {
      const existingDrafts = [...this.fileDrafts.values()].filter((draft) => draft.runId === runId).length
      if (existingDrafts >= 4) throw Object.assign(new Error('当前任务已有 4 个未提交草稿，请先提交或复用现有草稿'), { code: 'FILE_DRAFT_LIMIT' })
      const draftId = randomUUID()
      const content = String(args.content ?? '')
      this.fileDrafts.set(draftId, {
        runId,
        path: String(args.path),
        content,
        ...(typeof args.expectedSha256 === 'string' ? { expectedSha256: args.expectedSha256 } : {}),
      })
      return { draftId, path: String(args.path), totalChars: content.length, committed: false }
    }
    if (tool.id === 'file_draft_append') {
      const draftId = String(args.draftId)
      const draft = this.fileDrafts.get(draftId)
      if (!draft || draft.runId !== runId) throw Object.assign(new Error('长文草稿不存在或不属于当前任务'), { code: 'FILE_DRAFT_NOT_FOUND' })
      const content = String(args.content ?? '')
      if (draft.content.length + content.length > MAX_FILE_DRAFT_CHARS) throw Object.assign(new Error('长文草稿超过 2 MB 上限'), { code: 'FILE_DRAFT_TOO_LARGE' })
      draft.content += content
      return { draftId, path: draft.path, totalChars: draft.content.length, committed: false }
    }
    if (tool.id === 'task_plan') {
      const steps = Array.isArray(args.steps) ? args.steps as Array<{ title: string }> : []
      const persistedSteps = this.database.replaceSteps(runId, steps)
      this.database.transitionRun(runId, 'running', { outcome: null, summary: '', finishedAt: null })
      return { updated: true, steps: persistedSteps }
    }
    if (tool.id === 'task_step_update') {
      const step = this.database.updateTaskStep(runId, String(args.stepId), {
        status: String(args.status) as TaskStep['status'],
        ...(typeof args.evidence === 'string' ? { evidence: args.evidence } : {}),
      }) as TaskStep
      this.emit({ id: randomUUID(), runId, sequence: Date.now(), at: new Date().toISOString(), kind: 'step.updated', step })
      return { updated: true, step }
    }
    if (tool.id === 'task_complete') {
      return this.completeTask(runId, args)
    }
    if (tool.id === 'memory_propose') {
      if (this.database.getSetting<any>('appSettings', {}).memoryEnabled === false) throw Object.assign(new Error('Memory 已在设置中关闭。'), { code: 'MEMORY_DISABLED' })
      const kind = MEMORY_KIND_MAP[String(args.kind)]
      if (!kind) throw Object.assign(new Error(`不支持的 Memory 类型：${String(args.kind)}`), { code: 'INVALID_MEMORY_TYPE' })
      const id = this.database.saveMemory({ workspaceId: args.scope === 'workspace' ? this.database.getRun(runId)?.workspaceId : undefined, scope: args.scope, kind, content: args.content, confidence: args.confidence, status: 'proposed', source: [{ kind: 'run', reference: runId }] })
      return { id, state: 'proposed', message: '记忆候选已保存，等待用户确认后才会生效。' }
    }
    if (tool.id === 'skill_read') {
      const skill = this.database.getSkill(String(args.skillId))
      if (!skill || !skill.enabled) throw new Error('Skill 不存在或未启用')
      const resource = typeof args.resource === 'string' ? args.resource : 'SKILL.md'
      const loaded = await this.readSkillResource(String(skill.path), resource)
      return {
        id: skill.id,
        name: skill.name,
        resource,
        instructions: loaded.content,
        permissions: skill.permissions,
        executionContext: {
          workingDirectory: loaded.skillDirectory,
          scriptsDirectory: resolve(loaded.skillDirectory, 'scripts'),
          resourcePath: loaded.resourcePath,
          resourceDirectory: dirname(loaded.resourcePath),
          note: 'skill_read 只读取说明；执行脚本仍需通过 shell_run 和宿主权限审批。',
        },
      }
    }
    if (tool.id === 'attachment_open') return this.openAttachment(runId, String(args.artifactId))
    if (tool.id === 'agent_delegate') return this.delegate({ parentRunId: runId, task: String(args.task), role: String(args.role) })
    if (tool.id.startsWith('chrome_')) {
      const result = await this.chrome.executeTool(runId, tool.id, args)
      if (tool.id === 'chrome_screenshot' && typeof result?.data === 'string') {
        const artifact = await this.artifacts.putBuffer({ runId, name: `chrome-${Date.now()}.${result.format ?? 'jpeg'}`, kind: 'tool_result', data: Buffer.from(result.data, 'base64'), mime: `image/${result.format ?? 'jpeg'}`, metadata: { tabId: result.tabId } })
        return { ...result, data: undefined, artifact }
      }
      return result
    }

    const run = this.database.getRun(runId)
    if (!run) throw Object.assign(new Error('任务不存在'), { code: 'RUN_NOT_FOUND' })
    const workspace = this.database.getWorkspace(run.workspaceId)
    if (!workspace?.root_path) throw Object.assign(new Error('任务工作区不存在或已被移除'), { code: 'WORKSPACE_REQUIRED' })
    const authorizedRoot = assertWorkspaceRoot(String(workspace.root_path))
    if (tool.id === 'output_register') {
      return this.registerOutputs(runId, workspace.root_path, authorizedRoot, Array.isArray(args.outputs) ? args.outputs as Array<{ path: string; label?: string }> : [])
    }
    if (tool.id === 'document_render') {
      if (!this.documentRenderer) throw Object.assign(new Error('文档渲染服务不可用'), { code: 'DOCUMENT_RENDERER_UNAVAILABLE' })
      const rendered = await this.documentRenderer.render({
        runId,
        inputPath: String(args.inputPath),
        ...(typeof args.outputPath === 'string' && args.outputPath.trim() ? { outputPath: args.outputPath } : {}),
        ...(typeof args.title === 'string' && args.title.trim() ? { title: args.title } : {}),
        workspacePath: workspace.root_path,
        authorizedRoot,
      })
      const outputs = await this.registerOutputs(runId, workspace.root_path, authorizedRoot, [{ path: rendered.outputPath, label: basename(rendered.outputPath) }])
      return { ...rendered, outputs: outputs.outputs }
    }
    if (tool.id === 'process_start') {
      const result = await this.runner.execute({ runId, requestId, toolId: 'process.start', args, workspacePath: workspace.root_path, authorizedRoot })
      const processId = String(result.processId ?? '')
      if (!processId) throw Object.assign(new Error('后台进程未返回进程 ID'), { code: 'PROCESS_START_FAILED' })
      const summary = String(redactValue(String(args.command ?? '').replace(/\s+/g, ' ').trim())).slice(0, 240)
      this.database.createManagedProcess({ id: processId, runId, commandSummary: summary || 'background process', cwd: String(result.cwd ?? args.cwd ?? workspace.root_path), ...(Number.isInteger(result.pid) ? { pid: result.pid } : {}) })
      return result
    }
    if (tool.id === 'process_poll') {
      const processId = String(args.processId)
      const persisted = this.database.getManagedProcess(processId)
      if (!persisted || persisted.runId !== runId) throw Object.assign(new Error('后台进程不存在或不属于当前任务'), { code: 'PROCESS_NOT_FOUND' })
      const result = await this.runner.execute({ runId, requestId, toolId: 'process.poll', args, workspacePath: workspace.root_path, authorizedRoot })
      const status = String(result.status ?? 'running')
      let outputArtifact: any
      if (status !== 'running' && typeof result.fullOutput === 'string' && !persisted.outputArtifactId) {
        outputArtifact = await this.artifacts.putText({ runId, name: `process-${processId}.log`, kind: 'tool_result', content: result.fullOutput, mime: 'text/plain', metadata: { processId, status, commandSummary: persisted.commandSummary } })
      }
      this.database.updateManagedProcess(processId, {
        status,
        ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
        ...(outputArtifact ? { outputArtifactId: outputArtifact.id } : {}),
        ...(typeof result.finishedAt === 'string' ? { finishedAt: result.finishedAt } : {}),
      })
      const safe = { ...result }
      delete safe.fullOutput
      return { ...safe, ...(outputArtifact ? { outputArtifact: this.publicArtifactRef(outputArtifact) } : persisted.outputArtifactId ? { outputArtifactId: persisted.outputArtifactId } : {}) }
    }
    if (tool.id === 'process_stop') {
      const processId = String(args.processId)
      const persisted = this.database.getManagedProcess(processId)
      if (!persisted || persisted.runId !== runId) throw Object.assign(new Error('后台进程不存在或不属于当前任务'), { code: 'PROCESS_NOT_FOUND' })
      const result = await this.runner.execute({ runId, requestId, toolId: 'process.stop', args, workspacePath: workspace.root_path, authorizedRoot })
      this.database.updateManagedProcess(processId, { status: String(result.status ?? 'stopped'), ...(typeof result.stoppedAt === 'string' ? { finishedAt: result.stoppedAt } : {}) })
      return result
    }
    if (tool.id === 'file_draft_commit') {
      const draftId = String(args.draftId)
      const draft = this.fileDrafts.get(draftId)
      if (!draft || draft.runId !== runId) throw Object.assign(new Error('长文草稿不存在或不属于当前任务'), { code: 'FILE_DRAFT_NOT_FOUND' })
      if (String(args.path) !== draft.path) throw Object.assign(new Error('提交路径与草稿目标不一致'), { code: 'FILE_DRAFT_PATH_MISMATCH' })
      const writeArgs = {
        path: draft.path,
        content: draft.content,
        ...(typeof args.expectedSha256 === 'string'
          ? { expectedSha256: args.expectedSha256 }
          : draft.expectedSha256 ? { expectedSha256: draft.expectedSha256 } : {}),
      }
      const snapshot = await this.prepareFileSnapshot(runId, requestId, tool, writeArgs, workspace.root_path, authorizedRoot)
      const result = await this.runner.execute({ runId, requestId, toolId: 'file.write', args: writeArgs, workspacePath: workspace.root_path, authorizedRoot })
      const captured = await this.captureArtifacts(runId, tool, result, snapshot)
      this.fileDrafts.delete(draftId)
      return { ...captured, draftId, totalChars: draft.content.length, committed: true }
    }
    const preMutationSnapshot = tool.id === 'file_write' || tool.id === 'file_replace'
      ? await this.prepareFileSnapshot(runId, requestId, tool, args, workspace.root_path, authorizedRoot)
      : undefined
    let mcpServer: any
    if (tool.id.startsWith('mcp_') && this.mcp) {
      mcpServer = await this.mcp.runtimeServer(String(args.serverId), { workspaceRoot: workspace.root_path })
    } else if (tool.id.startsWith('mcp_')) {
      let raw = this.database.getMcpServer(String(args.serverId))
      if (!raw || !raw.enabled) throw new Error('MCP Server 不存在或未启用')
      if (raw.config?.auth === 'oauth' && typeof raw.config?.url === 'string') {
        await this.refreshMcpOAuth?.(raw.id, raw.config.url)
        raw = this.database.getMcpServer(String(args.serverId))
      }
      let secrets: Record<string, unknown> | string | undefined
      if (raw.encrypted_secret) secrets = this.decodeSecret(await this.secrets.decrypt(raw.encrypted_secret))
      mcpServer = { id: raw.id, transport: raw.transport, config: raw.config, ...(secrets ? { secrets } : {}) }
    }
    const result = await this.runner.execute({ runId, requestId, toolId: tool.runnerId, args, workspacePath: workspace.root_path, authorizedRoot, ...(mcpServer ? { mcpServer } : {}) }, (progress) => {
      const now = Date.now()
      if (now - (this.lastToolProgressAt.get(requestId) ?? 0) < 2_500) return
      this.lastToolProgressAt.set(requestId, now)
      this.database.appendRunEvent(runId, 'tool.progress', `${tool.label}: ${String(progress.text).slice(-500)}`, { channel: progress.channel })
    })
    if (tool.id === 'mcp_list_tools' && this.mcp && Array.isArray(result?.tools)) {
      // Tools disabled in settings are invisible to the Agent.
      const disabled = new Set(this.mcp.disabledTools(String(args.serverId)))
      return this.captureArtifacts(runId, tool, { ...result, tools: result.tools.filter((entry: any) => !disabled.has(String(entry?.name))) }, preMutationSnapshot)
    }
    return this.captureArtifacts(runId, tool, result, preMutationSnapshot)
  }

  private async prepareFileSnapshot(runId: string, requestId: string, tool: ToolDefinition, args: Record<string, unknown>, workspacePath: string, authorizedRoot: string): Promise<any> {
    try {
      const before = await this.runner.execute({ runId, requestId: `${requestId}-snapshot`, toolId: 'file.read', args: { path: args.path }, workspacePath, authorizedRoot })
      if (typeof before?.content !== 'string') throw new Error('写入前快照读取失败')
      if (typeof args.expectedSha256 === 'string' && before.sha256 !== args.expectedSha256) {
        throw Object.assign(new Error(`文件在读取后已变化（当前 sha256: ${String(before.sha256)}）。必须重新读取、合并最新内容并再次写入；写入成功前不得报告完成。`), {
          code: 'STALE_WRITE',
          details: { path: before.path, currentSha256: before.sha256 },
        })
      }
      return this.artifacts.putText({ runId, name: `${String(args.path).split('/').at(-1)}.before`, kind: 'file_snapshot', content: before.content, metadata: { path: before.path, sha256: before.sha256, createdFile: false, capturedBeforeMutation: true } })
    } catch (error: any) {
      if ((tool.id !== 'file_write' && tool.id !== 'file_draft_commit') || error?.code !== 'ENOENT') throw error
      return this.artifacts.putText({ runId, name: `${String(args.path).split('/').at(-1)}.before`, kind: 'file_snapshot', content: '', metadata: { path: args.path, sha256: null, createdFile: true, capturedBeforeMutation: true } })
    }
  }

  private completeTask(runId: string, args: Record<string, unknown>): { accepted: true; verificationRequired: boolean; outcome: VerificationSummary['status'] | null; evidence: string[]; reportedEvidence: string[]; unverified: string[]; verification?: VerificationSummary } {
    const reportedEvidence = Array.isArray(args.evidence) ? args.evidence.filter((item): item is string => typeof item === 'string') : []
    const unverified = Array.isArray(args.unverified) ? args.unverified.filter((item): item is string => typeof item === 'string') : []
    const turnStartedAt = this.database.getCurrentRunTurnStartedAt(runId)
    const rows = (turnStartedAt
      ? this.database.db.prepare(`SELECT id,tool_id,state,arguments_json,result_json,error,created_at,updated_at
          FROM tool_calls WHERE run_id=? AND tool_id<>'task_complete' AND created_at>=? ORDER BY created_at`).all(runId, turnStartedAt)
      : this.database.db.prepare(`SELECT id,tool_id,state,arguments_json,result_json,error,created_at,updated_at
          FROM tool_calls WHERE run_id=? AND tool_id<>'task_complete' ORDER BY created_at`).all(runId)) as any[]
    const toolCalls = rows.map((row): ToolCall => {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.id === row.tool_id)
      const descriptor = definition ? descriptorFor(definition) : undefined
      const status = TOOL_STATUSES.has(row.state as ToolCall['status']) ? row.state as ToolCall['status'] : 'failed'
      return {
        id: String(row.id),
        runId,
        toolName: descriptor?.name ?? String(row.tool_id),
        source: descriptor?.source ?? 'builtin',
        arguments: parseJson(row.arguments_json),
        status,
        idempotent: definition?.risk === 'read',
        ...(row.error ? { error: { code: 'TOOL_FAILED', message: String(row.error), retryable: false } } : {}),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }
    })
    const artifacts = this.database.listArtifacts(runId).filter((artifact: any) => !turnStartedAt || String(artifact.created_at ?? artifact.createdAt) >= turnStartedAt)
    const verificationRelevantTools = rows.filter((row) => !['task_plan', 'task_step_update', 'memory_propose', 'skill_read'].includes(String(row.tool_id)))
    const verificationRelevantArtifacts = artifacts.filter((artifact: any) => ['diff', 'final_output'].includes(String(artifact.kind)))
    if (verificationRelevantTools.length === 0 && verificationRelevantArtifacts.length === 0) {
      // A model may still call task_complete after a greeting or a plain answer.
      // Do not manufacture a partial verdict when there was no operational work
      // for the completion gate to verify.
      this.database.updateRun(runId, { outcome: null, summary: '' })
      for (const [draftId, draft] of this.fileDrafts) if (draft.runId === runId) this.fileDrafts.delete(draftId)
      return { accepted: true, verificationRequired: false, outcome: null, evidence: [], reportedEvidence, unverified }
    }
    const checks: VerificationSummary['checks'] = []
    const observableEvidence: string[] = []

    const diffArtifacts = artifacts.filter((artifact: any) => artifact.kind === 'diff')
    if (diffArtifacts.length > 0) observableEvidence.push(`文件 Diff：${diffArtifacts.length} 个持久化 Diff`)
    const finalArtifacts = artifacts.filter((artifact: any) => artifact.kind === 'final_output')
    if (finalArtifacts.length > 0) observableEvidence.push(`最终产物：${finalArtifacts.length} 个持久化产物`)

    const validationRows: Array<{ row: any; command: string }> = []
    for (const row of rows.filter((candidate) => candidate.tool_id === 'shell_run')) {
      const toolArgs = parseJson(row.arguments_json)
      const command = typeof toolArgs === 'object' && toolArgs !== null && !Array.isArray(toolArgs) && typeof toolArgs.command === 'string' ? toolArgs.command : ''
      if (!validationCommand(command)) continue
      validationRows.push({ row, command })
      checks.push({
        name: `验证命令：${command.slice(0, 120)}`,
        status: row.state === 'succeeded' ? 'passed' : row.state === 'failed' ? 'failed' : 'not_run',
        ...(row.error ? { detail: String(row.error).slice(0, 500) } : {}),
      })
    }

    const succeededMutations = rows.filter((row) => FILE_MUTATION_TOOLS.has(String(row.tool_id)) && row.state === 'succeeded')
    if (succeededMutations.length > 0) {
      const latestMutationAt = Math.max(...succeededMutations.map((row) => Date.parse(String(row.updated_at ?? row.created_at)) || 0))
      const hasPostMutationValidation = validationRows.some(({ row }) =>
        row.state === 'succeeded' && (Date.parse(String(row.updated_at ?? row.created_at)) || 0) >= latestMutationAt,
      )
      const latestMutation = [...succeededMutations].sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0]
      const mutationResult = parseJson(latestMutation?.result_json) as Record<string, unknown>
      const postMutationRead = rows.find((row) => {
        if (row.tool_id !== 'file_read' || row.state !== 'succeeded') return false
        if ((Date.parse(String(row.updated_at ?? row.created_at)) || 0) < latestMutationAt) return false
        const result = parseJson(row.result_json) as Record<string, unknown>
        return typeof mutationResult.sha256 === 'string' && result.sha256 === mutationResult.sha256
      })
      if (postMutationRead) {
        checks.push({ name: '文件写入回读', status: 'passed', detail: '最终文件已重新读取，sha256 与写入回执一致' })
      } else if (!hasPostMutationValidation) {
        checks.push({ name: '文件修改验证', status: 'not_run', detail: '文件修改后没有成功的测试、类型检查、构建或等价验证命令' })
      }
    }

    const receiptChecks: Array<{ name: string; rows: any[] }> = [
      { name: 'Chrome 回执', rows: rows.filter((row) => ['chrome_navigate', 'chrome_click', 'chrome_type', 'chrome_open_tab'].includes(String(row.tool_id))) },
      { name: 'MCP 回执', rows: rows.filter((row) => row.tool_id === 'mcp_call_tool') },
    ]
    for (const receipt of receiptChecks) {
      if (receipt.rows.length === 0) continue
      const failed = receipt.rows.filter((row) => row.state === 'failed').length
      const succeeded = receipt.rows.filter((row) => row.state === 'succeeded' && row.result_json !== null).length
      checks.push({
        name: receipt.name,
        status: failed > 0 ? 'failed' : succeeded > 0 ? 'passed' : 'not_run',
        detail: `${succeeded} 成功，${failed} 失败`,
      })
    }
    const observableReads = rows.filter((row) => ['file_list', 'file_read', 'file_search', 'file_find', 'attachment_open', 'web_search', 'web_fetch', 'skill_read', 'chrome_snapshot'].includes(String(row.tool_id)))
    if (observableReads.length > 0) {
      const failedReads = observableReads.filter((row) => row.state === 'failed').length
      const succeededReads = observableReads.filter((row) => row.state === 'succeeded' && row.result_json !== null).length
      observableEvidence.push(`读取回执：${succeededReads} 个可观察来源读取成功，${failedReads} 个失败`)
    }
    const fetchedSources = rows.filter((row) => row.tool_id === 'web_fetch' && row.state === 'succeeded' && row.result_json !== null)
    if (fetchedSources.length > 0) checks.push({ name: '来源核验', status: 'passed', detail: `成功读取 ${fetchedSources.length} 个原始网页来源` })
    // Durable output existence proves observability, not correctness. Only
    // validation commands and scoped external-system receipts become checks.
    if (checks.length === 0) checks.push({ name: '正确性验证', status: 'not_run', detail: '未发现成功的验证命令或可核验外部系统回执' })

    const raw = this.database.getRun(runId)
    const currentSteps = (raw?.steps ?? []).filter((step: any) => !turnStartedAt || String(step.updatedAt ?? step.updated_at) >= turnStartedAt)
    const steps = currentSteps.map((step: any, index: number): TaskStep => {
      const stepEvidence = Array.isArray(step.evidence) ? step.evidence.filter((item: unknown): item is string => typeof item === 'string') : []
      const verification = typeof step.verification === 'string' ? step.verification : stepEvidence.join('\n')
      return {
        id: String(step.id),
        runId,
        title: String(step.title),
        ordinal: Number(step.ordinal ?? index),
        status: STEP_STATUSES.has(step.status as TaskStep['status']) ? step.status as TaskStep['status'] : 'pending',
        ...(verification ? { verification } : {}),
        createdAt: String(step.createdAt ?? step.created_at),
        updatedAt: String(step.updatedAt ?? step.updated_at),
      }
    })
    const unresolvedFailures = rows.filter((row, index) => {
      if (row.state !== 'failed') return false
      const toolId = String(row.tool_id)
      if (['file_list', 'file_read', 'file_search', 'file_find', 'attachment_open', 'web_search', 'web_fetch', 'skill_read'].includes(toolId)) return false
      const args = parseJson(row.arguments_json) as Record<string, unknown>
      if (toolId === 'shell_run' && !validationCommand(String(args?.command ?? ''))) return false
      const fingerprint = toolTargetFingerprint(row)
      const recovered = rows.slice(index + 1).some((later) => later.state === 'succeeded' && toolTargetFingerprint(later) === fingerprint)
      if (recovered) return false
      if (toolId === 'shell_run' && validationRows.some(({ row: later }) => later.state === 'succeeded' && String(later.created_at) > String(row.created_at))) return false
      return true
    })
    const gateUnverified = unresolvedFailures.length > 0
      ? [...unverified, `${unresolvedFailures.length} 个必要工具操作仍失败，尚未被同目标成功回执或后续验证恢复`]
      : unverified
    const gate = evaluateCompletionGate({ steps, toolCalls, checks, evidence: reportedEvidence, unverified: gateUnverified })
    const submittedSummary = String(args.summary ?? '').trim()
    const verification: VerificationSummary = {
      ...gate,
      summary: gate.status === 'verified'
        ? submittedSummary || gate.summary
        : [submittedSummary, gate.summary].filter(Boolean).join('\n'),
    }
    this.database.transitionRun(runId, 'verifying', { outcome: verification.status, summary: submittedSummary || verification.summary })
    this.emit({ id: randomUUID(), runId, sequence: Date.now(), at: new Date().toISOString(), kind: 'verification.completed', verification })
    const evidence = [
      ...observableEvidence,
      ...checks.filter((check) => check.status === 'passed').map((check) => check.detail ? `${check.name}: ${check.detail}` : check.name),
    ]
    for (const [draftId, draft] of this.fileDrafts) if (draft.runId === runId) this.fileDrafts.delete(draftId)
    return { accepted: true, verificationRequired: true, outcome: verification.status, evidence, reportedEvidence, unverified, verification }
  }

  private async captureArtifacts(runId: string, tool: ToolDefinition, result: any, preMutationSnapshot?: any): Promise<any> {
    if ((tool.id === 'file_write' || tool.id === 'file_draft_commit' || tool.id === 'file_replace') && (typeof result?.before === 'string' || result?.before === null) && typeof result?.after === 'string') {
      const createdFile = result.before === null || result.created === true
      const before = createdFile ? '' : String(result.before)
      const afterSha256 = String(result.sha256 ?? '')
      const snapshot = preMutationSnapshot ?? await this.artifacts.putText({
        runId,
        name: `${String(result.path).split('/').at(-1)}.before`,
        kind: 'file_snapshot',
        content: before,
        metadata: { path: result.path, sha256: result.beforeSha256 ?? null, createdFile, capturedBeforeMutation: false },
      })
      const fileDiff = createFileDiff({ path: String(result.path), before: createdFile ? null : before, after: String(result.after), maxLines: ARTIFACT_DIFF_MAX_LINES })
      const diffText = fileDiff.text
      const diff = await this.artifacts.putText({
        runId,
        name: `${String(result.path).split('/').at(-1)}.diff`,
        kind: 'diff',
        content: diffText,
        mime: 'text/x-diff',
        metadata: {
          path: result.path,
          snapshotArtifactId: snapshot.id,
          afterSha256,
          createdFile,
          accessModeAtMutation: this.database.getRun(runId)?.accessMode ?? 'approval',
          additions: fileDiff.additions,
          deletions: fileDiff.deletions,
          truncated: fileDiff.truncated,
        },
      })
      const safe = { ...result }
      delete safe.before
      delete safe.after
      return { ...safe, snapshotArtifactId: snapshot.id, diffArtifactId: diff.id }
    }
    if (tool.id === 'web_fetch' && result && typeof result === 'object' && typeof result.text === 'string' && Buffer.byteLength(result.text, 'utf8') > 12_000) {
      const text = String(result.text)
      const artifact = await this.artifacts.putText({
        runId,
        name: `web-fetch-${Date.now()}.txt`,
        kind: 'tool_result',
        content: text,
        mime: 'text/plain',
        metadata: { url: result.url, status: result.status, contentType: result.contentType, total: result.total },
      })
      return {
        url: result.url,
        status: result.status,
        contentType: result.contentType,
        charset: result.charset,
        total: result.total ?? Buffer.byteLength(text, 'utf8'),
        truncated: true,
        text: text.slice(0, 12_000),
        artifact: this.publicArtifactRef(artifact),
      }
    }
    const serialized = JSON.stringify(result)
    if (Buffer.byteLength(serialized) > 32 * 1024) {
      const artifact = await this.artifacts.putText({ runId, name: `${tool.id}-${Date.now()}.json`, kind: 'tool_result', content: serialized, mime: 'application/json' })
      const source = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {}
      const metadata = Object.fromEntries(['url', 'status', 'contentType', 'charset', 'total', 'engine', 'query', 'resultCount']
        .filter((key) => key in source)
        .map((key) => [key, source[key]]))
      return { ...metadata, truncated: true, artifact: this.publicArtifactRef(artifact), preview: serialized.slice(0, 8_000) }
    }
    return result
  }

  private publicArtifactRef(artifact: any): Record<string, unknown> {
    return Object.fromEntries(['id', 'runId', 'kind', 'name', 'displayName', 'sha256', 'mime', 'mediaType', 'size', 'byteLength']
      .filter((key) => key in artifact)
      .map((key) => [key, artifact[key]]))
  }

  private async openAttachment(runId: string, artifactId: string): Promise<Record<string, unknown>> {
    const artifact = this.database.getArtifact(artifactId)
    if (!artifact || artifact.kind !== 'attachment' || String(artifact.run_id ?? artifact.runId ?? '') !== runId) {
      throw Object.assign(new Error('附件不存在或不属于当前任务'), { code: 'ATTACHMENT_NOT_AVAILABLE' })
    }
    const size = Number(artifact.size ?? 0)
    const mime = String(artifact.mime ?? 'application/octet-stream')
    const result: Record<string, unknown> = {
      artifactId,
      name: String(artifact.name),
      path: String(artifact.path),
      mime,
      size,
      sha256: String(artifact.sha256),
    }
    const isText = mime.startsWith('text/') || /(?:json|xml|yaml|javascript|csv|tab-separated)/i.test(mime)
    if (isText && size <= 1024 * 1024) {
      const content = await this.artifacts.read(String(artifact.path))
      result.preview = content.toString('utf8').slice(0, 12_000)
      result.truncated = content.byteLength > 12_000
    }
    return result
  }

  private async registerOutputs(
    runId: string,
    workspacePath: string,
    authorizedRoot: string,
    outputs: Array<{ path: string; label?: string }>,
  ): Promise<{ registered: number; outputs: Array<Record<string, unknown>> }> {
    if (outputs.length === 0 || outputs.length > MAX_OUTPUT_FILES) throw Object.assign(new Error(`产物数量必须为 1 到 ${MAX_OUTPUT_FILES}`), { code: 'INVALID_OUTPUT_COUNT' })
    const canonicalRoot = await realpath(authorizedRoot)
    const existing = this.database.listArtifacts(runId).filter((artifact: any) => artifact.kind === 'final_output')
    const registered: Array<Record<string, unknown>> = []
    let totalBytes = 0
    for (const output of outputs) {
      const requested = String(output.path ?? '')
      if (!requested || requested.includes('\0')) throw Object.assign(new Error('产物路径无效'), { code: 'INVALID_OUTPUT_PATH' })
      const target = isAbsolute(requested) ? resolve(requested) : resolve(workspacePath, requested)
      const direct = await lstat(target)
      if (direct.isSymbolicLink()) throw Object.assign(new Error('产物不能是符号链接'), { code: 'OUTPUT_SYMLINK' })
      if (!direct.isFile()) throw Object.assign(new Error('产物必须是普通文件'), { code: 'OUTPUT_NOT_FILE' })
      if (SENSITIVE_OUTPUT_FILE.test(basename(target))) throw Object.assign(new Error('凭据、密钥和隐藏认证文件不能登记为产物'), { code: 'SENSITIVE_OUTPUT' })
      const canonical = await realpath(target)
      const inside = relative(canonicalRoot, canonical)
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw Object.assign(new Error('产物超出当前授权范围'), { code: 'OUTPUT_OUTSIDE_AUTHORIZED_ROOT' })
      if (direct.size > MAX_OUTPUT_FILE_BYTES) throw Object.assign(new Error('单个产物不能超过 50 MB'), { code: 'OUTPUT_TOO_LARGE' })
      totalBytes += direct.size
      if (totalBytes > MAX_OUTPUT_TOTAL_BYTES) throw Object.assign(new Error('本次登记的产物总计不能超过 250 MB'), { code: 'OUTPUT_TOTAL_TOO_LARGE' })
      const data = await readFile(canonical)
      const sha256 = createHash('sha256').update(data).digest('hex')
      const duplicate = existing.find((artifact: any) => artifact.sha256 === sha256 && parseJson(artifact.metadata_json, {}) && String((parseJson(artifact.metadata_json, {}) as any).sourcePath ?? '') === canonical)
      if (duplicate) {
        registered.push({ ...this.publicArtifactRef(duplicate), path: canonical, deduplicated: true })
        continue
      }
      const artifact = await this.artifacts.putBuffer({
        runId,
        name: output.label?.trim() || basename(canonical),
        kind: 'final_output',
        data,
        metadata: { sourcePath: canonical, sha256, registeredBy: 'output_register' },
      })
      registered.push({ ...this.publicArtifactRef(artifact), path: canonical, deduplicated: false })
    }
    return { registered: registered.length, outputs: registered }
  }

  private emitTool(runId: string, call: ToolCall, status: ToolCall['status'], riskLevel: any): void {
    this.emit({
      id: randomUUID(), runId, sequence: Date.now(), at: new Date().toISOString(), kind: 'tool.updated',
      toolCall: { ...call, status, riskLevel, updatedAt: new Date().toISOString() },
    })
  }

  private decodeSecret(value: string): Record<string, unknown> | string {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : value
    } catch {
      return value
    }
  }

  private async readSkillResource(skillPath: string, requestedResource: string): Promise<{ content: string; skillDirectory: string; resourcePath: string }> {
    const resource = requestedResource.replaceAll('\\', '/')
    const segments = resource.split('/')
    if (!resource || resource.includes('\0') || isAbsolute(resource) || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw Object.assign(new Error('Skill 资源必须是包内的规范相对路径'), { code: 'INVALID_SKILL_RESOURCE' })
    }
    if (segments.some((segment) => segment.startsWith('.'))) {
      throw Object.assign(new Error('Skill 资源不允许读取隐藏文件或隐藏目录'), { code: 'PRIVATE_SKILL_RESOURCE' })
    }
    if (segments.some((segment) => SENSITIVE_SKILL_RESOURCE.test(segment))) {
      throw Object.assign(new Error('Skill 的密钥和私有配置不能载入模型上下文'), { code: 'PRIVATE_SKILL_RESOURCE' })
    }
    const rootSegment = segments[0]!
    const publicRootFile = segments.length === 1 && PUBLIC_SKILL_ROOT_FILES.has(rootSegment)
    const publicDirectory = segments.length > 1 && PUBLIC_SKILL_DIRECTORIES.has(rootSegment)
    if (!publicRootFile && !publicDirectory) {
      throw Object.assign(new Error('Skill 资源仅允许公开说明、脚本和引用资料'), { code: 'INVALID_SKILL_RESOURCE' })
    }

    const root = await realpath(skillPath)
    let target = root
    for (const segment of segments) {
      target = resolve(target, segment)
      const entry = await lstat(target)
      if (entry.isSymbolicLink()) throw Object.assign(new Error('Skill 资源不允许使用符号链接'), { code: 'SKILL_RESOURCE_SYMLINK' })
    }
    const canonical = await realpath(target)
    const inside = relative(root, canonical)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw Object.assign(new Error('Skill 资源超出已安装 Skill 目录'), { code: 'SKILL_RESOURCE_ESCAPE' })
    }

    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw Object.assign(new Error('Skill 资源必须是普通文件'), { code: 'INVALID_SKILL_RESOURCE' })
      const limit = 1024 * 1024
      if (metadata.size > limit) throw Object.assign(new Error('Skill 文本资源超过 1 MB 上限'), { code: 'SKILL_RESOURCE_TOO_LARGE' })
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > limit) throw Object.assign(new Error('Skill 文本资源超过 1 MB 上限'), { code: 'SKILL_RESOURCE_TOO_LARGE' })
        chunks.push(chunk.subarray(0, bytesRead))
      }
      const data = Buffer.concat(chunks, total)
      if (data.includes(0)) throw Object.assign(new Error('Skill 资源不是文本文件'), { code: 'INVALID_SKILL_TEXT' })
      try {
        return {
          content: new TextDecoder('utf-8', { fatal: true }).decode(data),
          skillDirectory: root,
          resourcePath: canonical,
        }
      } catch {
        throw Object.assign(new Error('Skill 资源必须是有效 UTF-8 文本'), { code: 'INVALID_SKILL_TEXT' })
      }
    } finally {
      await handle.close()
    }
  }
}
