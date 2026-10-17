import { t } from '../../i18n'
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
    defaultModelId: 'deepseek-flash',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    keyPlaceholder: 'DeepSeek API Key',
    baseUrlEditable: true,
  },
  kimi: {
    name: 'Kimi',
    mark: 'K',
    defaultModelId: 'kimi-k2.6',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    keyPlaceholder: 'Moonshot API Key',
    baseUrlEditable: true,
  },
  tongyi: {
    get name() { return t('通义') },
    get mark() { return t('通') },
    defaultModelId: 'qwen-plus',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyPlaceholder: 'DashScope API Key',
    baseUrlEditable: true,
  },
  custom: {
    get name() { return t('自定义') },
    get mark() { return t('自') },
    defaultModelId: '',
    defaultBaseUrl: '',
    keyPlaceholder: 'API Key',
    baseUrlEditable: true,
  },
}
