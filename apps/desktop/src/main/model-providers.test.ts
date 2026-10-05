import { describe, expect, it } from 'vitest'
import { defaultBaseUrl, getModelCatalog, MODEL_PRESETS } from './model-providers'

describe('model provider presets', () => {
  it('uses OpenAI-compatible base URLs for DeepSeek, Kimi and Tongyi', () => {
    expect(MODEL_PRESETS.deepseek.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(MODEL_PRESETS.kimi.baseUrl).toBe('https://api.moonshot.cn/v1')
    expect(MODEL_PRESETS.tongyi.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(defaultBaseUrl('custom')).toBe('')
  })

  it('offers the preset model id without calling a vendor catalog', () => {
    expect(getModelCatalog('kimi')).toEqual([
      expect.objectContaining({ id: 'moonshot-v1-auto', reasoning: false, vision: false }),
    ])
    expect(getModelCatalog('custom')).toEqual([])
  })
})
