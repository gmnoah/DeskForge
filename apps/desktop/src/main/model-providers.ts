import type { ModelCatalogItem, ProviderId } from '@deskforge/contracts'

export const MODEL_PRESETS: Record<ProviderId, {
  baseUrl: string
  defaultModelId: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
}> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModelId: 'deepseek-chat',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    reasoning: false,
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModelId: 'moonshot-v1-auto',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    reasoning: false,
  },
  tongyi: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModelId: 'qwen-plus',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    reasoning: false,
  },
  custom: {
    baseUrl: '',
    defaultModelId: '',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    reasoning: false,
  },
}

export function defaultBaseUrl(provider: string): string {
  if (provider === 'deepseek' || provider === 'kimi' || provider === 'tongyi') return MODEL_PRESETS[provider].baseUrl
  return ''
}

export function getModelCatalog(provider: ProviderId): ModelCatalogItem[] {
  const preset = MODEL_PRESETS[provider]
  if (!preset.defaultModelId) return []
  return [{
    id: preset.defaultModelId,
    name: preset.defaultModelId,
    contextWindow: preset.contextWindow,
    maxOutputTokens: preset.maxOutputTokens,
    vision: false,
    reasoning: preset.reasoning,
  }]
}
