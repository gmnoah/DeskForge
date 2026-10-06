import { createModels, createProvider, envApiKeyAuth, InMemoryCredentialStore, type Model, type ModelThinkingLevel, type ProviderStreams, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { stream as openAICompletionsStream, streamSimple as openAICompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import {
  applyPinnedThinking,
  guardProviderPayload,
  isKimiK27Code as isKimiK27CodeId,
  resolveModelSpec,
  type RuntimeModelSpec,
} from './provider-compat'

export const RUNTIME_PROVIDER_IDS = ['deepseek', 'kimi', 'tongyi', 'custom'] as const
export type RuntimeProviderName = (typeof RUNTIME_PROVIDER_IDS)[number]

export const KIMI_K27_CODE_MODEL_ID = 'kimi-k2.7-code'
export const KIMI_BASE_URL = 'https://api.moonshot.cn/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
export const TONGYI_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const KIMI_K27_CONTEXT_WINDOW = 262_144
export const KIMI_K27_MAX_OUTPUT_TOKENS = 32_768

const PRESET_BASE_URLS: Record<Exclude<RuntimeProviderName, 'custom'>, string> = {
  deepseek: DEEPSEEK_BASE_URL,
  kimi: KIMI_BASE_URL,
  tongyi: TONGYI_BASE_URL,
}

type RuntimeStreamOptions = SimpleStreamOptions & { toolChoice?: unknown }

export interface PublicProviderError {
  message: string
  retryable: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function resolveRuntimeProvider(provider: unknown): RuntimeProviderName {
  if (typeof provider === 'string' && (RUNTIME_PROVIDER_IDS as readonly string[]).includes(provider)) {
    return provider as RuntimeProviderName
  }
  throw new Error(`不支持的模型 Provider：${typeof provider === 'string' ? provider : 'invalid'}`)
}

export function isKimiK27Code(provider: RuntimeProviderName, modelId: string): boolean {
  return provider === 'kimi' && isKimiK27CodeId(modelId)
}

export function resolveRuntimeBaseUrl(provider: RuntimeProviderName, baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, '') ?? ''
  if (provider === 'custom') {
    if (!trimmed) throw new Error('自定义模型必须填写 baseUrl')
    return trimmed
  }
  return trimmed || PRESET_BASE_URLS[provider]
}

export function runtimeModelSpec(provider: RuntimeProviderName, modelId: string, baseUrl?: string): RuntimeModelSpec {
  return resolveModelSpec(provider, modelId, resolveRuntimeBaseUrl(provider, baseUrl))
}

export function fallbackRuntimeModel(provider: RuntimeProviderName, id: string, baseUrl?: string): Model<any> {
  const resolvedBaseUrl = resolveRuntimeBaseUrl(provider, baseUrl)
  const spec = resolveModelSpec(provider, id, resolvedBaseUrl)
  return {
    id: spec.requestModelId,
    name: spec.requestModelId,
    api: 'openai-completions',
    provider,
    baseUrl: resolvedBaseUrl,
    reasoning: spec.reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    ...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: spec.supportsReasoningEffort,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      requiresReasoningContentOnAssistantMessages: spec.requiresReasoningContentOnAssistantMessages,
      thinkingFormat: spec.thinkingFormat,
    },
  }
}

/** Build an OpenAI-compatible Chat Completions model from the saved baseUrl. */
export function normalizeRuntimeModel(
  provider: RuntimeProviderName,
  modelId: string,
  baseUrl?: string,
): Model<any> {
  return fallbackRuntimeModel(provider, modelId, baseUrl)
}

export function resolveRuntimeThinkingLevel(
  provider: RuntimeProviderName,
  modelId: string,
  requested: ModelThinkingLevel | undefined,
  baseUrl?: string,
): ModelThinkingLevel {
  if (!isKimiK27Code(provider, modelId)) {
    const level = requested ?? 'off'
    return provider === 'custom' && !baseUrl ? level : applyPinnedThinking(runtimeModelSpec(provider, modelId, baseUrl), level)
  }
  if (requested === 'off') throw new Error(`${KIMI_K27_CODE_MODEL_ID} 仅支持思考模式，不能关闭思考`)
  return requested ?? 'high'
}

function guardKimiPayload(payload: unknown, promptCacheKey?: string): unknown {
  if (!isRecord(payload)) throw new Error('Moonshot 请求 payload 必须是对象')
  const guarded: Record<string, unknown> = { ...payload }

  // K2.7 Code has a fixed thinking mode. Omit OpenAI-only or unsupported
  // controls rather than relying on a permissive compatible endpoint.
  for (const field of [
    'temperature',
    'reasoning_effort',
    'store',
    'prompt_cache_retention',
    'max_completion_tokens',
    'functions',
    'function_call',
    'parallel_tool_calls',
    'n',
    'top_p',
    'presence_penalty',
    'frequency_penalty',
  ]) delete guarded[field]

  const toolChoice = guarded.tool_choice
  if (toolChoice !== undefined && toolChoice !== null && toolChoice !== 'auto' && toolChoice !== 'none') {
    throw new Error('Moonshot K2.7 Code 不支持 required 或指定函数形式的 tool_choice')
  }

  const thinking = guarded.thinking
  if (isRecord(thinking) && thinking.type !== undefined && thinking.type !== 'enabled') {
    throw new Error('Moonshot K2.7 Code 仅支持 enabled thinking')
  }
  // Thinking is always on. An explicit value must be {type:'enabled',keep:'all'}, so omit it.
  delete guarded.thinking

  const requestedMax = typeof guarded.max_tokens === 'number' && Number.isFinite(guarded.max_tokens)
    ? Math.floor(guarded.max_tokens)
    : KIMI_K27_MAX_OUTPUT_TOKENS
  guarded.max_tokens = Math.max(1, Math.min(requestedMax, KIMI_K27_MAX_OUTPUT_TOKENS))

  if (promptCacheKey) guarded.prompt_cache_key = promptCacheKey
  else delete guarded.prompt_cache_key

  return guarded
}

export interface RuntimeStreamContext {
  baseUrl?: string
  /** Receives provider payload adjustments (diagnostic codes, never payload content). */
  onAdjust?: (adjustments: string[]) => void
}

function withProviderGuard(
  options: RuntimeStreamOptions,
  spec: RuntimeModelSpec | undefined,
  context: RuntimeStreamContext,
): RuntimeStreamOptions {
  if (!spec) return options
  const upstreamOnPayload = options.onPayload
  return {
    ...options,
    onPayload: async (payload, model) => {
      const transformed = await upstreamOnPayload?.(payload, model)
      const guarded = guardProviderPayload(spec, transformed ?? payload)
      if (guarded.adjustments.length) context.onAdjust?.(guarded.adjustments)
      return guarded.payload
    },
  }
}

/**
 * Apply provider-specific request safety after any upstream onPayload hook so
 * no later transform can re-introduce incompatible provider fields.
 */
export function prepareRuntimeStreamOptions(
  provider: RuntimeProviderName,
  modelId: string,
  options: RuntimeStreamOptions,
  promptCacheKey?: string,
  context: RuntimeStreamContext = {},
): RuntimeStreamOptions {
  let spec: RuntimeModelSpec | undefined
  try { spec = runtimeModelSpec(provider, modelId, context.baseUrl) } catch { spec = undefined }
  if (!isKimiK27Code(provider, modelId)) return withProviderGuard(options, spec, context)
  if (options.toolChoice !== undefined && options.toolChoice !== null && options.toolChoice !== 'auto' && options.toolChoice !== 'none') {
    throw new Error('Moonshot K2.7 Code 不支持 required 或指定函数形式的 tool_choice')
  }

  const upstreamOnPayload = options.onPayload
  const safeOptions: RuntimeStreamOptions = { ...options }
  delete safeOptions.temperature
  delete safeOptions.toolChoice
  return withProviderGuard({
    ...safeOptions,
    ...(options.toolChoice === 'auto' || options.toolChoice === 'none' ? { toolChoice: options.toolChoice } : {}),
    maxTokens: Math.max(1, Math.min(options.maxTokens ?? KIMI_K27_MAX_OUTPUT_TOKENS, KIMI_K27_MAX_OUTPUT_TOKENS)),
    cacheRetention: 'none',
    reasoning: options.reasoning ?? 'high',
    onPayload: async (payload, model) => {
      const transformed = await upstreamOnPayload?.(payload, model)
      return guardKimiPayload(transformed ?? payload, promptCacheKey)
    },
  }, spec, context)
}

export interface RuntimeHandle {
  models: ReturnType<typeof createModels>
  model: Model<any>
  provider: RuntimeProviderName
  spec: RuntimeModelSpec
}

/** Create an isolated pi-ai runtime whose only credential is the supplied key. */
export async function createRuntime(providerInput: string, modelId: string, apiKey: string, baseUrl: string): Promise<RuntimeHandle> {
  const provider = resolveRuntimeProvider(providerInput)
  const model = normalizeRuntimeModel(provider, modelId, baseUrl)
  const spec = runtimeModelSpec(provider, modelId, baseUrl)
  const credentials = new InMemoryCredentialStore()
  await credentials.modify(provider, async () => ({ type: 'api_key', key: apiKey }))
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  })
  // createModels starts empty: register a single-model provider bound to the saved baseUrl.
  // No env var names are passed, so only the in-memory credential can authenticate.
  models.setProvider(createProvider({
    id: provider,
    name: provider,
    baseUrl: model.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${provider} API key`, []) },
    models: [model],
    api: { stream: openAICompletionsStream, streamSimple: openAICompletionsStreamSimple } as unknown as ProviderStreams,
  }))
  return { models, model, provider, spec }
}

export interface ConnectionTestOutcome {
  ok: boolean
  model: string
  error?: string
  notice?: string
}

/**
 * Cheapest possible probe: one short streamed completion without tools.
 * Thinking stays off where the provider allows it so the probe costs a few tokens.
 */
export async function runConnectionTest(input: { provider: string; modelId: string; baseUrl: string; apiKey: string; timeoutMs?: number }): Promise<ConnectionTestOutcome> {
  const { models, model, provider, spec } = await createRuntime(input.provider, input.modelId, input.apiKey, input.baseUrl)
  // K2.7 Code cannot turn thinking off; everything else probes without thinking.
  const reasoningLevel = resolveRuntimeThinkingLevel(provider, input.modelId, isKimiK27Code(provider, input.modelId) ? undefined : 'off', input.baseUrl)
  const result = await models.completeSimple(model, {
    systemPrompt: 'Reply with exactly OK.',
    messages: [{ role: 'user', content: 'Connection test', timestamp: Date.now() }],
  }, prepareRuntimeStreamOptions(provider, input.modelId, {
    maxTokens: 16,
    maxRetries: 0,
    timeoutMs: input.timeoutMs ?? 20_000,
    ...(reasoningLevel !== 'off' ? { reasoning: reasoningLevel } : {}),
  }, undefined, { baseUrl: input.baseUrl }))
  const notice = spec.notice
  // "length" is fine here: the probe only proves auth, routing and model id.
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    return { ok: false, model: model.id, error: result.errorMessage ?? '模型连接测试失败', ...(notice ? { notice } : {}) }
  }
  return { ok: true, model: model.id, ...(notice ? { notice } : {}) }
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  if (isRecord(error)) {
    const nested = isRecord(error.error) ? error.error.message : undefined
    if (typeof nested === 'string' && nested) return nested
    if (typeof error.message === 'string' && error.message) return error.message
  }
  return '模型服务请求失败'
}

function secretRepresentations(secret: string): string[] {
  const candidates = new Set<string>([secret, encodeURIComponent(secret)])
  const jsonEscaped = JSON.stringify(secret).slice(1, -1)
  if (jsonEscaped) candidates.add(jsonEscaped)
  return [...candidates].filter(Boolean).sort((a, b) => b.length - a.length)
}

export function redactSecretValues(message: string, secrets: readonly (string | undefined)[]): string {
  let redacted = message
  for (const secret of secrets) {
    if (!secret) continue
    for (const representation of secretRepresentations(secret)) redacted = redacted.split(representation).join('[REDACTED]')
  }

  redacted = redacted
    .replace(/(\b(?:authorization|x-api-key|api[_ -]?key)\b\s*[:=]\s*)(?:bearer\s+)?[^\s,;"'}\]]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|moonshot)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')

  return redacted.slice(0, 4_096)
}

function errorRecords(error: unknown): Record<string, unknown>[] {
  if (!isRecord(error)) return []
  const records = [error]
  if (isRecord(error.cause)) records.push(error.cause)
  if (isRecord(error.response)) records.push(error.response)
  if (isRecord(error.error)) records.push(error.error)
  return records
}

export function isRetryableProviderError(error: unknown): boolean {
  const records = errorRecords(error)
  const statuses = records.flatMap((record) => [record.status, record.statusCode]).filter((value): value is number => typeof value === 'number')
  if (statuses.some((status) => [408, 409, 425, 429, 500, 502, 503, 504].includes(status))) return true
  if (statuses.some((status) => [400, 401, 403, 404, 405, 413, 422].includes(status))) return false

  const codes = records
    .map((record) => record.code)
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETDOWN|ENETUNREACH|UND_ERR_(?:CONNECT_)?TIMEOUT/i.test(codes)) return true
  if (/INVALID|AUTH|PERMISSION|UNAUTHORIZED|FORBIDDEN/i.test(codes)) return false

  const message = rawErrorMessage(error)
  if (/abort(?:ed)?|cancel(?:led)?/i.test(message)) return false
  if (/rate.?limit|too many requests|temporar(?:y|ily) unavailable|service unavailable|gateway timeout|network error|fetch failed|connection reset|timed? ?out/i.test(message)) return true
  if (/invalid (?:request|api.?key)|unauthori[sz]ed|forbidden|permission|unsupported|context length|bad request/i.test(message)) return false
  return false
}

export function toPublicProviderError(error: unknown, secrets: readonly (string | undefined)[] = []): PublicProviderError {
  return {
    message: redactSecretValues(rawErrorMessage(error), secrets),
    retryable: isRetryableProviderError(error),
  }
}
