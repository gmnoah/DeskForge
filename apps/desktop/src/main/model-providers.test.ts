import { describe, expect, it } from 'vitest'
import { defaultBaseUrl, getModelCatalog, MODEL_PRESETS } from './model-providers'
import { inferCapabilities } from './presenters'

describe('model provider presets', () => {
  it('uses OpenAI-compatible base URLs for DeepSeek, Kimi and Tongyi', () => {
    expect(MODEL_PRESETS.deepseek.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(MODEL_PRESETS.kimi.baseUrl).toBe('https://api.moonshot.cn/v1')
    expect(MODEL_PRESETS.tongyi.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(defaultBaseUrl('custom')).toBe('')
  })

  it('defaults to models that are still served (no retired aliases)', () => {
    expect(MODEL_PRESETS.deepseek.defaultModelId).toBe('deepseek-flash')
    expect(MODEL_PRESETS.kimi.defaultModelId).toBe('kimi-k2.6')
    expect(MODEL_PRESETS.tongyi.defaultModelId).toBe('qwen-plus')
    for (const provider of ['deepseek', 'kimi', 'tongyi'] as const) {
      const ids = getModelCatalog(provider).map((item) => item.id)
      expect(ids[0]).toBe(MODEL_PRESETS[provider].defaultModelId)
      expect(ids.some((id) => /^(deepseek-chat|deepseek-reasoner|moonshot-v1)/.test(id))).toBe(false)
    }
  })

  it('offers static catalog suggestions without calling a vendor catalog', () => {
    expect(getModelCatalog('kimi')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'kimi-k2.7-code', reasoning: true, vision: false }),
    ]))
    expect(getModelCatalog('custom')).toEqual([])
  })

  it('infers reasoning and limits for current model families', () => {
    expect(inferCapabilities('deepseek', 'deepseek-flash')).toMatchObject({ reasoning: true, maxOutputTokens: 32_768, promptCaching: true })
    expect(inferCapabilities('deepseek', 'deepseek-chat').reasoning).toBe(false)
    expect(inferCapabilities('kimi', 'kimi-k3')).toMatchObject({ reasoning: true, contextWindow: 262_144 })
    expect(inferCapabilities('kimi', 'moonshot-v1-8k').reasoning).toBe(false)
    expect(inferCapabilities('tongyi', 'qwen-plus').reasoning).toBe(true)
    expect(inferCapabilities('tongyi', 'qwen3-coder-plus-instruct').reasoning).toBe(false)
    expect(inferCapabilities('custom', 'my-r1-distill').reasoning).toBe(false)
    expect(inferCapabilities('custom', 'qwq-32b').reasoning).toBe(true)
  })
})
