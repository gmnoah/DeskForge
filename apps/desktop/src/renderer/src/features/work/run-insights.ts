import type { JsonRecord } from '../../types'

export interface TokenUsageView {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  totalTokens: number
  modelCalls: number
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** Read the run's aggregated usage; undefined when the provider never reported usage. */
export function readTokenUsage(value: unknown): TokenUsageView | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as JsonRecord
  const usage: TokenUsageView = {
    inputTokens: count(source.inputTokens),
    outputTokens: count(source.outputTokens),
    cacheReadTokens: count(source.cacheReadTokens),
    reasoningTokens: count(source.reasoningTokens),
    totalTokens: count(source.totalTokens),
    modelCalls: count(source.modelCalls),
  }
  if (!usage.totalTokens && !usage.inputTokens && !usage.outputTokens) return undefined
  if (!usage.totalTokens) usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens
  return usage
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 10_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return value.toLocaleString('zh-CN')
}

/** Lines shown under "Token 用量". Input includes cache hits so it matches provider bills. */
export function tokenUsageLines(usage: TokenUsageView): { label: string; value: string }[] {
  const input = usage.inputTokens + usage.cacheReadTokens
  const lines = [
    { label: '合计', value: `${formatTokenCount(usage.totalTokens)} tokens` },
    { label: '输入', value: usage.cacheReadTokens ? `${formatTokenCount(input)}（缓存命中 ${formatTokenCount(usage.cacheReadTokens)}）` : formatTokenCount(input) },
    { label: '输出', value: usage.reasoningTokens ? `${formatTokenCount(usage.outputTokens)}（含思考 ${formatTokenCount(usage.reasoningTokens)}）` : formatTokenCount(usage.outputTokens) },
  ]
  if (usage.modelCalls) lines.push({ label: '模型调用', value: `${usage.modelCalls} 次` })
  return lines
}

export function tokenUsageSummary(usage: TokenUsageView): string {
  return `本次工作共用 ${formatTokenCount(usage.totalTokens)} tokens`
}

const TECHNICAL_NOISE = /constraint|sqlite|stack|tool_calls|\bid\b/i

/** Failure text for the chat timeline: classified model errors carry their own Chinese guidance. */
export function failureMessage(lastError: unknown): string {
  const fallback = '这次操作没有完成。你可以重试，或打开右侧诊断查看技术信息。'
  if (!lastError || typeof lastError !== 'object') return fallback
  const error = lastError as JsonRecord
  const message = typeof error.message === 'string' ? error.message.trim() : ''
  const suggestion = typeof error.suggestedAction === 'string' ? error.suggestedAction.trim() : ''
  if (typeof error.code === 'string' && error.code.startsWith('MODEL_') && message) {
    return suggestion ? `${message}${suggestion}` : message
  }
  if (!message || TECHNICAL_NOISE.test(message)) return fallback
  return message.length > 180 ? `${message.slice(0, 179)}…` : message
}

/** Redacted provider text kept for troubleshooting, if any. */
export function failureTechnicalDetail(lastError: unknown): string | undefined {
  if (!lastError || typeof lastError !== 'object') return undefined
  const details = (lastError as JsonRecord).details
  if (!details || typeof details !== 'object') return undefined
  const raw = (details as JsonRecord).raw
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}
