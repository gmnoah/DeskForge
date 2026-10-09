export interface ModelPriceRate {
  /** Cost per 1M prompt/input tokens on cache miss */
  inputPerMillionCny: number
  inputPerMillionUsd: number
  /** Cost per 1M prompt/input tokens on cache read/hit */
  cacheHitPerMillionCny: number
  cacheHitPerMillionUsd: number
  /** Cost per 1M completion/output tokens */
  outputPerMillionCny: number
  outputPerMillionUsd: number
}

// Exchange rate approx USD to CNY
export const USD_TO_CNY = 7.20

export const DEFAULT_MODEL_PRICING: Record<string, ModelPriceRate> = {
  // DeepSeek
  'deepseek-flash': {
    inputPerMillionCny: 1.0,
    inputPerMillionUsd: 0.14,
    cacheHitPerMillionCny: 0.1,
    cacheHitPerMillionUsd: 0.014,
    outputPerMillionCny: 2.0,
    outputPerMillionUsd: 0.28,
  },
  'deepseek-chat': {
    inputPerMillionCny: 1.0,
    inputPerMillionUsd: 0.14,
    cacheHitPerMillionCny: 0.1,
    cacheHitPerMillionUsd: 0.014,
    outputPerMillionCny: 2.0,
    outputPerMillionUsd: 0.28,
  },
  'deepseek-v4-pro': {
    inputPerMillionCny: 4.0,
    inputPerMillionUsd: 0.55,
    cacheHitPerMillionCny: 1.0,
    cacheHitPerMillionUsd: 0.14,
    outputPerMillionCny: 16.0,
    outputPerMillionUsd: 2.19,
  },
  'deepseek-reasoner': {
    inputPerMillionCny: 4.0,
    inputPerMillionUsd: 0.55,
    cacheHitPerMillionCny: 1.0,
    cacheHitPerMillionUsd: 0.14,
    outputPerMillionCny: 16.0,
    outputPerMillionUsd: 2.19,
  },
  'deepseek-r1': {
    inputPerMillionCny: 4.0,
    inputPerMillionUsd: 0.55,
    cacheHitPerMillionCny: 1.0,
    cacheHitPerMillionUsd: 0.14,
    outputPerMillionCny: 16.0,
    outputPerMillionUsd: 2.19,
  },

  // Moonshot Kimi
  'kimi-k2.6': {
    inputPerMillionCny: 12.0,
    inputPerMillionUsd: 1.65,
    cacheHitPerMillionCny: 3.0,
    cacheHitPerMillionUsd: 0.41,
    outputPerMillionCny: 30.0,
    outputPerMillionUsd: 4.10,
  },
  'kimi-k3': {
    inputPerMillionCny: 12.0,
    inputPerMillionUsd: 1.65,
    cacheHitPerMillionCny: 3.0,
    cacheHitPerMillionUsd: 0.41,
    outputPerMillionCny: 30.0,
    outputPerMillionUsd: 4.10,
  },
  'kimi-k2.7-code': {
    inputPerMillionCny: 12.0,
    inputPerMillionUsd: 1.65,
    cacheHitPerMillionCny: 3.0,
    cacheHitPerMillionUsd: 0.41,
    outputPerMillionCny: 30.0,
    outputPerMillionUsd: 4.10,
  },
  'moonshot-v1-8k': {
    inputPerMillionCny: 12.0,
    inputPerMillionUsd: 1.65,
    cacheHitPerMillionCny: 3.0,
    cacheHitPerMillionUsd: 0.41,
    outputPerMillionCny: 12.0,
    outputPerMillionUsd: 1.65,
  },
  'moonshot-v1-32k': {
    inputPerMillionCny: 24.0,
    inputPerMillionUsd: 3.30,
    cacheHitPerMillionCny: 6.0,
    cacheHitPerMillionUsd: 0.82,
    outputPerMillionCny: 24.0,
    outputPerMillionUsd: 3.30,
  },
  'moonshot-v1-128k': {
    inputPerMillionCny: 60.0,
    inputPerMillionUsd: 8.25,
    cacheHitPerMillionCny: 15.0,
    cacheHitPerMillionUsd: 2.06,
    outputPerMillionCny: 60.0,
    outputPerMillionUsd: 8.25,
  },

  // Tongyi / DashScope / Qwen
  'qwen-plus': {
    inputPerMillionCny: 0.8,
    inputPerMillionUsd: 0.11,
    cacheHitPerMillionCny: 0.2,
    cacheHitPerMillionUsd: 0.028,
    outputPerMillionCny: 2.0,
    outputPerMillionUsd: 0.28,
  },
  'qwen3.8-max': {
    inputPerMillionCny: 20.0,
    inputPerMillionUsd: 2.75,
    cacheHitPerMillionCny: 5.0,
    cacheHitPerMillionUsd: 0.69,
    outputPerMillionCny: 60.0,
    outputPerMillionUsd: 8.25,
  },
  'qwen-max': {
    inputPerMillionCny: 20.0,
    inputPerMillionUsd: 2.75,
    cacheHitPerMillionCny: 5.0,
    cacheHitPerMillionUsd: 0.69,
    outputPerMillionCny: 60.0,
    outputPerMillionUsd: 8.25,
  },
  'qwen3.8-flash': {
    inputPerMillionCny: 0.3,
    inputPerMillionUsd: 0.041,
    cacheHitPerMillionCny: 0.1,
    cacheHitPerMillionUsd: 0.014,
    outputPerMillionCny: 0.6,
    outputPerMillionUsd: 0.082,
  },
  'qwen-turbo': {
    inputPerMillionCny: 0.3,
    inputPerMillionUsd: 0.041,
    cacheHitPerMillionCny: 0.1,
    cacheHitPerMillionUsd: 0.014,
    outputPerMillionCny: 0.6,
    outputPerMillionUsd: 0.082,
  },

  // Claude models (common custom profiles)
  'claude-3-5-sonnet': {
    inputPerMillionCny: 21.6,
    inputPerMillionUsd: 3.0,
    cacheHitPerMillionCny: 2.16,
    cacheHitPerMillionUsd: 0.3,
    outputPerMillionCny: 108.0,
    outputPerMillionUsd: 15.0,
  },
  'claude-3-7-sonnet': {
    inputPerMillionCny: 21.6,
    inputPerMillionUsd: 3.0,
    cacheHitPerMillionCny: 2.16,
    cacheHitPerMillionUsd: 0.3,
    outputPerMillionCny: 108.0,
    outputPerMillionUsd: 15.0,
  },
  'claude-3-5-haiku': {
    inputPerMillionCny: 5.76,
    inputPerMillionUsd: 0.8,
    cacheHitPerMillionCny: 0.58,
    cacheHitPerMillionUsd: 0.08,
    outputPerMillionCny: 28.8,
    outputPerMillionUsd: 4.0,
  },

  // OpenAI models (common custom profiles)
  'gpt-4o': {
    inputPerMillionCny: 18.0,
    inputPerMillionUsd: 2.5,
    cacheHitPerMillionCny: 9.0,
    cacheHitPerMillionUsd: 1.25,
    outputPerMillionCny: 72.0,
    outputPerMillionUsd: 10.0,
  },
  'gpt-4o-mini': {
    inputPerMillionCny: 1.08,
    inputPerMillionUsd: 0.15,
    cacheHitPerMillionCny: 0.54,
    cacheHitPerMillionUsd: 0.075,
    outputPerMillionCny: 4.32,
    outputPerMillionUsd: 0.6,
  },
}

export function findModelPricing(modelId?: string, provider?: string): ModelPriceRate | undefined {
  if (!modelId && !provider) return undefined
  const normalizedId = (modelId ?? '').trim().toLowerCase()
  if (DEFAULT_MODEL_PRICING[normalizedId]) return DEFAULT_MODEL_PRICING[normalizedId]

  // Fuzzy match known prefixes
  for (const [key, rate] of Object.entries(DEFAULT_MODEL_PRICING)) {
    if (normalizedId.includes(key) || key.includes(normalizedId)) {
      return rate
    }
  }

  // Provider fallbacks
  const p = (provider ?? '').toLowerCase()
  if (p === 'deepseek') return DEFAULT_MODEL_PRICING['deepseek-flash']
  if (p === 'kimi') return DEFAULT_MODEL_PRICING['kimi-k2.6']
  if (p === 'tongyi') return DEFAULT_MODEL_PRICING['qwen-plus']

  return undefined
}

export function calculateTokenCost(
  modelId: string | undefined,
  provider: string | undefined,
  tokens: { promptTokens: number; completionTokens: number; cacheReadTokens?: number },
): { costUsd: number; costCny: number; hasPricing: boolean } {
  const rate = findModelPricing(modelId, provider)
  if (!rate) {
    return { costUsd: 0, costCny: 0, hasPricing: false }
  }

  const prompt = Math.max(0, tokens.promptTokens)
  const completion = Math.max(0, tokens.completionTokens)
  const cache = Math.max(0, tokens.cacheReadTokens ?? 0)

  // Millions
  const inputMillions = prompt / 1_000_000
  const cacheMillions = cache / 1_000_000
  const outputMillions = completion / 1_000_000

  const costCny =
    inputMillions * rate.inputPerMillionCny +
    cacheMillions * rate.cacheHitPerMillionCny +
    outputMillions * rate.outputPerMillionCny

  const costUsd =
    inputMillions * rate.inputPerMillionUsd +
    cacheMillions * rate.cacheHitPerMillionUsd +
    outputMillions * rate.outputPerMillionUsd

  return {
    costUsd: Math.round(costUsd * 10_000) / 10_000,
    costCny: Math.round(costCny * 10_000) / 10_000,
    hasPricing: true,
  }
}
