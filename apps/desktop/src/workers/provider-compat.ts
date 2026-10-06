import type { ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'

/**
 * Provider quirks for the OpenAI-compatible Chat Completions endpoints that
 * DeskForge ships presets for. Sources (checked 2026-10):
 * - DeepSeek: https://api-docs.deepseek.com/guides/thinking_mode and /api/create-chat-completion
 * - Kimi: https://platform.kimi.ai/docs/api/models-overview and /docs/guide/use-thinking-models
 * - DashScope: https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
 */
export type ProviderFamily = 'deepseek' | 'kimi' | 'tongyi' | 'generic'

export type ThinkingFormat = 'deepseek' | 'qwen' | 'openai'

export interface RuntimeModelSpec {
  family: ProviderFamily
  /** Model id sent on the wire after resolving retired aliases. */
  requestModelId: string
  reasoning: boolean
  thinkingFormat: ThinkingFormat
  supportsReasoningEffort: boolean
  thinkingLevelMap?: ThinkingLevelMap
  contextWindow: number
  maxTokens: number
  /** DeepSeek rejects tool requests whose assistant history lacks reasoning_content. */
  requiresReasoningContentOnAssistantMessages: boolean
  /** Thinking mode pinned by a legacy alias (deepseek-chat / deepseek-reasoner). */
  pinnedThinking?: 'enabled' | 'disabled'
  /** Chinese note shown in diagnostics when an alias was rewritten. */
  notice?: string
}

const KIMI_HOSTS = /(^|\.)(moonshot\.cn|moonshot\.ai|kimi\.ai|kimi\.com)$/i
const DEEPSEEK_HOSTS = /(^|\.)deepseek\.com$/i
const DASHSCOPE_HOSTS = /(^|\.)(dashscope(-intl|-us)?\.aliyuncs\.com|maas\.aliyuncs\.com)$/i

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).hostname } catch { return '' }
}

/** Presets keep their family even behind a proxy; custom endpoints are inferred from the host. */
export function detectProviderFamily(provider: string, baseUrl: string): ProviderFamily {
  if (provider === 'deepseek') return 'deepseek'
  if (provider === 'kimi') return 'kimi'
  if (provider === 'tongyi') return 'tongyi'
  const host = hostOf(baseUrl)
  if (DEEPSEEK_HOSTS.test(host)) return 'deepseek'
  if (KIMI_HOSTS.test(host)) return 'kimi'
  if (DASHSCOPE_HOSTS.test(host)) return 'tongyi'
  return 'generic'
}

/** DeepSeek retired these names on 2026-07-24; they were aliases of the Flash model's two modes. */
export const DEEPSEEK_RETIRED_ALIASES: Record<string, { modelId: string; thinking: 'enabled' | 'disabled' }> = {
  'deepseek-chat': { modelId: 'deepseek-flash', thinking: 'disabled' },
  'deepseek-reasoner': { modelId: 'deepseek-flash', thinking: 'enabled' },
}

/** Kimi retired moonshot-v1-*, kimi-k2-* (non 2.6/2.7) and kimi-latest. */
export function isRetiredKimiModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return /^moonshot-v1-/.test(id) || id === 'kimi-latest' || id === 'kimi-thinking-preview' || id === 'kimi-k2.5'
    || /^kimi-k2-(?:\d{4}-preview|turbo-preview|thinking(?:-turbo)?)$/.test(id)
}

export function isKimiK27Code(modelId: string): boolean {
  return /^kimi-k2\.7-code(?:-highspeed)?$/i.test(modelId)
}

export function isKimiK3(modelId: string): boolean {
  return /^kimi-k3(?:$|[-.])/i.test(modelId)
}

function isOfficialDeepSeek(baseUrl: string): boolean {
  return hostOf(baseUrl).toLowerCase() === 'api.deepseek.com'
}

const DEEPSEEK_EFFORT: ThinkingLevelMap = { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' }
const KIMI_K3_EFFORT: ThinkingLevelMap = { off: 'low', minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' }

export function resolveModelSpec(provider: string, modelId: string, baseUrl: string): RuntimeModelSpec {
  const family = detectProviderFamily(provider, baseUrl)
  const id = modelId.trim()
  const lower = id.toLowerCase()

  if (family === 'deepseek') {
    const alias = isOfficialDeepSeek(baseUrl) ? DEEPSEEK_RETIRED_ALIASES[lower] : undefined
    return {
      family,
      requestModelId: alias?.modelId ?? id,
      // Every current DeepSeek chat model is hybrid; send the thinking switch explicitly.
      reasoning: true,
      thinkingFormat: 'deepseek',
      supportsReasoningEffort: true,
      thinkingLevelMap: DEEPSEEK_EFFORT,
      contextWindow: 128_000,
      // max_tokens covers reasoning + answer in thinking mode.
      maxTokens: 32_768,
      requiresReasoningContentOnAssistantMessages: true,
      ...(alias ? {
        pinnedThinking: alias.thinking,
        notice: `${id} 已于 2026-07-24 下线，本次按 ${alias.modelId}（思考模式${alias.thinking === 'enabled' ? '开启' : '关闭'}）发送。请在设置中把模型 ID 改为 ${alias.modelId}。`,
      } : {}),
    }
  }

  if (family === 'kimi') {
    if (isKimiK27Code(id)) {
      return { family, requestModelId: id, reasoning: true, thinkingFormat: 'deepseek', supportsReasoningEffort: false, thinkingLevelMap: { off: null }, contextWindow: 262_144, maxTokens: 32_768, requiresReasoningContentOnAssistantMessages: false }
    }
    if (isKimiK3(id)) {
      // K3 always reasons; effort is the only knob and "off" maps to the cheapest level.
      return { family, requestModelId: id, reasoning: true, thinkingFormat: 'openai', supportsReasoningEffort: true, thinkingLevelMap: KIMI_K3_EFFORT, contextWindow: 262_144, maxTokens: 32_768, requiresReasoningContentOnAssistantMessages: false }
    }
    const hybrid = /^kimi-k2\.[5-9]/i.test(id)
    return { family, requestModelId: id, reasoning: hybrid, thinkingFormat: 'deepseek', supportsReasoningEffort: false, contextWindow: hybrid ? 262_144 : 128_000, maxTokens: hybrid ? 32_768 : 8_192, requiresReasoningContentOnAssistantMessages: false }
  }

  if (family === 'tongyi') {
    // enable_thinking applies to hybrid Qwen3.x / qwen-plus|flash|turbo and DashScope-hosted DeepSeek V3/V4.
    const hybrid = /^(qwen3|qwen-(plus|flash|turbo)|deepseek-v[34])/i.test(id) && !/-(instruct|thinking)\b/i.test(id)
    return { family, requestModelId: id, reasoning: hybrid, thinkingFormat: hybrid ? 'qwen' : 'openai', supportsReasoningEffort: false, contextWindow: 131_072, maxTokens: 8_192, requiresReasoningContentOnAssistantMessages: false }
  }

  return {
    family,
    requestModelId: id,
    reasoning: /reason|thinking|\br1\b|qwq/i.test(lower),
    thinkingFormat: 'openai',
    supportsReasoningEffort: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
    requiresReasoningContentOnAssistantMessages: false,
  }
}

/** A legacy alias pins thinking; everything else keeps the requested level. */
export function applyPinnedThinking(spec: RuntimeModelSpec, requested: ModelThinkingLevel): ModelThinkingLevel {
  if (spec.pinnedThinking === 'disabled') return 'off'
  if (spec.pinnedThinking === 'enabled' && requested === 'off') return 'high'
  return requested
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const REASONING_ECHO_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const
const KIMI_FIXED_SAMPLING_FIELDS = ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty'] as const

export interface PayloadGuardResult {
  payload: Record<string, unknown>
  adjustments: string[]
}

function isForcedToolChoice(value: unknown): boolean {
  return value === 'required' || isRecord(value)
}

/**
 * Rewrites a Chat Completions payload so it stays inside each provider's documented contract.
 * Never throws; every change is reported in `adjustments` for diagnostics.
 */
export function guardProviderPayload(spec: RuntimeModelSpec, input: unknown): PayloadGuardResult {
  const payload: Record<string, unknown> = isRecord(input) ? { ...input } : {}
  const adjustments: string[] = []
  const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0

  if (spec.family === 'deepseek') {
    const thinking = isRecord(payload.thinking) ? payload.thinking.type !== 'disabled' : true
    // Thinking mode returns 400 for required / named tool_choice.
    if (thinking && isForcedToolChoice(payload.tool_choice)) {
      payload.tool_choice = 'auto'
      adjustments.push('deepseek:tool_choice_downgraded')
    }
  }

  if (spec.family === 'kimi') {
    const k3 = isKimiK3(spec.requestModelId)
    const k27 = isKimiK27Code(spec.requestModelId)
    if (k3 || k27 || /^kimi-k2\.6/i.test(spec.requestModelId)) {
      // These parameters are fixed server-side; any explicit value is rejected.
      for (const field of KIMI_FIXED_SAMPLING_FIELDS) {
        if (field in payload) { delete payload[field]; adjustments.push(`kimi:${field}_removed`) }
      }
    }
    if (k3 && 'thinking' in payload) { delete payload.thinking; adjustments.push('kimi:thinking_removed_for_k3') }
    const thinking = k3 || k27 || (spec.reasoning && !(isRecord(payload.thinking) && payload.thinking.type === 'disabled'))
    if (payload.tool_choice === 'required' && !k3) { payload.tool_choice = 'auto'; adjustments.push('kimi:tool_choice_required_unsupported') }
    if (isRecord(payload.tool_choice) && thinking) { payload.tool_choice = 'auto'; adjustments.push('kimi:named_tool_choice_incompatible_with_thinking') }
    if (thinking && typeof payload.max_tokens === 'number' && payload.max_tokens < 16_000 && payload.max_tokens > 64) {
      // Kimi asks for >= 16k so reasoning_content does not starve the answer. Tiny probes stay tiny.
      payload.max_tokens = 16_384
      adjustments.push('kimi:max_tokens_raised_for_thinking')
    }
  }

  if (spec.family === 'tongyi') {
    if (payload.tool_choice === 'required') { payload.tool_choice = 'auto'; adjustments.push('tongyi:tool_choice_required_unsupported') }
    if (isRecord(payload.tool_choice) && payload.enable_thinking === true) { payload.tool_choice = 'auto'; adjustments.push('tongyi:named_tool_choice_incompatible_with_thinking') }
    // DashScope defaults parallel_tool_calls to false; DeskForge executes read tools in parallel.
    if (hasTools && payload.parallel_tool_calls === undefined) payload.parallel_tool_calls = true
  }

  if (spec.family === 'generic' && Array.isArray(payload.messages)) {
    // Plain OpenAI-compatible servers do not define reasoning echo fields and strict ones reject them.
    let stripped = 0
    payload.messages = payload.messages.map((message) => {
      if (!isRecord(message) || message.role !== 'assistant') return message
      if (!REASONING_ECHO_FIELDS.some((field) => field in message)) return message
      const copy = { ...message }
      for (const field of REASONING_ECHO_FIELDS) delete copy[field]
      stripped += 1
      return copy
    })
    if (stripped) adjustments.push(`generic:reasoning_echo_stripped:${stripped}`)
  }

  return { payload, adjustments }
}
