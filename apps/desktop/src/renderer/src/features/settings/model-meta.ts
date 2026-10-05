import type { ModelProvider } from '../../types'

export const MODEL_PROVIDER_META: Record<ModelProvider, {
  name: string
  mark: string
  defaultModelId: string
  defaultBaseUrl: string
  keyPlaceholder: string
  baseUrlEditable: boolean
}> = {
  deepseek: {
    name: 'DeepSeek',
    mark: 'D',
    defaultModelId: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    keyPlaceholder: 'DeepSeek API Key',
    baseUrlEditable: true,
  },
  kimi: {
    name: 'Kimi',
    mark: 'K',
    defaultModelId: 'moonshot-v1-auto',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    keyPlaceholder: 'Moonshot API Key',
    baseUrlEditable: true,
  },
  tongyi: {
    name: '通义',
    mark: '通',
    defaultModelId: 'qwen-plus',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyPlaceholder: 'DashScope API Key',
    baseUrlEditable: true,
  },
  custom: {
    name: '自定义',
    mark: '自',
    defaultModelId: '',
    defaultBaseUrl: '',
    keyPlaceholder: 'API Key',
    baseUrlEditable: true,
  },
}
