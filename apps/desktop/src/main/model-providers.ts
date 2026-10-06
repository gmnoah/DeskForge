import type { ModelCatalogItem, ProviderId } from '@deskforge/contracts'

interface CatalogEntry {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
}

/**
 * Presets follow each provider's OpenAI-compatible docs (checked 2026-10).
 * deepseek-chat / deepseek-reasoner and moonshot-v1-* have been retired upstream.
 */
export const MODEL_PRESETS: Record<ProviderId, {
  baseUrl: string
  defaultModelId: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
  catalog: CatalogEntry[]
}> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModelId: 'deepseek-flash',
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    reasoning: true,
    catalog: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash（思考/非思考混合）', contextWindow: 128_000, maxOutputTokens: 32_768, reasoning: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128_000, maxOutputTokens: 32_768, reasoning: true },
    ],
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModelId: 'kimi-k2.6',
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    reasoning: true,
    catalog: [
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144, maxOutputTokens: 32_768, reasoning: true },
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 262_144, maxOutputTokens: 32_768, reasoning: true },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code（仅思考模式）', contextWindow: 262_144, maxOutputTokens: 32_768, reasoning: true },
    ],
  },
  tongyi: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModelId: 'qwen-plus',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    reasoning: true,
    catalog: [
      { id: 'qwen-plus', name: '通义千问 Plus', contextWindow: 131_072, maxOutputTokens: 8_192, reasoning: true },
      { id: 'qwen3.8-max', name: 'Qwen3.8 Max', contextWindow: 131_072, maxOutputTokens: 8_192, reasoning: true },
      { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', contextWindow: 131_072, maxOutputTokens: 8_192, reasoning: true },
    ],
  },
  custom: {
    baseUrl: '',
    defaultModelId: '',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    reasoning: false,
    catalog: [],
  },
}

export function defaultBaseUrl(provider: string): string {
  if (provider === 'deepseek' || provider === 'kimi' || provider === 'tongyi') return MODEL_PRESETS[provider].baseUrl
  return ''
}

/** Static suggestions only; DeskForge never calls a vendor model list. */
export function getModelCatalog(provider: ProviderId): ModelCatalogItem[] {
  return MODEL_PRESETS[provider].catalog.map((entry) => ({ ...entry, vision: false }))
}
