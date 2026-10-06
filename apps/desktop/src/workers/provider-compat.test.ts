import { describe, expect, it } from 'vitest'
import { applyPinnedThinking, detectProviderFamily, guardProviderPayload, resolveModelSpec } from './provider-compat'
import { normalizeRuntimeModel, prepareRuntimeStreamOptions, resolveRuntimeThinkingLevel } from './agent-host-runtime'

const DEEPSEEK = 'https://api.deepseek.com/v1'
const KIMI = 'https://api.moonshot.cn/v1'
const DASHSCOPE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

describe('provider family detection', () => {
  it('keeps preset families and infers custom endpoints from the host', () => {
    expect(detectProviderFamily('deepseek', 'https://my-proxy.example.com/v1')).toBe('deepseek')
    expect(detectProviderFamily('custom', 'https://api.deepseek.com')).toBe('deepseek')
    expect(detectProviderFamily('custom', 'https://api.moonshot.ai/v1')).toBe('kimi')
    expect(detectProviderFamily('custom', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')).toBe('tongyi')
    expect(detectProviderFamily('custom', 'https://evil-deepseek.com.example.org/v1')).toBe('generic')
    expect(detectProviderFamily('custom', 'http://localhost:11434/v1')).toBe('generic')
  })
})

describe('DeepSeek retired aliases', () => {
  it('rewrites deepseek-chat / deepseek-reasoner to deepseek-flash with pinned thinking on the official host', () => {
    const chat = resolveModelSpec('deepseek', 'deepseek-chat', DEEPSEEK)
    expect(chat).toMatchObject({ requestModelId: 'deepseek-flash', pinnedThinking: 'disabled' })
    expect(chat.notice).toContain('2026-07-24')
    expect(applyPinnedThinking(chat, 'high')).toBe('off')

    const reasoner = resolveModelSpec('deepseek', 'deepseek-reasoner', DEEPSEEK)
    expect(reasoner).toMatchObject({ requestModelId: 'deepseek-flash', pinnedThinking: 'enabled' })
    expect(applyPinnedThinking(reasoner, 'off')).toBe('high')
    expect(resolveRuntimeThinkingLevel('deepseek', 'deepseek-reasoner', 'off', DEEPSEEK)).toBe('high')
    expect(normalizeRuntimeModel('deepseek', 'deepseek-chat', DEEPSEEK).id).toBe('deepseek-flash')
  })

  it('leaves aliases alone behind proxies that may still serve them', () => {
    expect(resolveModelSpec('deepseek', 'deepseek-chat', 'https://proxy.example.com/v1').requestModelId).toBe('deepseek-chat')
  })

  it('declares DeepSeek models hybrid with reasoning_content echo and effort mapping', () => {
    const model = normalizeRuntimeModel('deepseek', 'deepseek-v4-pro', DEEPSEEK)
    expect(model.reasoning).toBe(true)
    expect(model.compat).toMatchObject({ thinkingFormat: 'deepseek', supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true, maxTokensField: 'max_tokens' })
    expect(model.thinkingLevelMap).toMatchObject({ medium: 'high', xhigh: 'max' })
  })
})

describe('Kimi model specs', () => {
  it('distinguishes K3, K2.7 Code and hybrid K2.6', () => {
    expect(resolveModelSpec('kimi', 'kimi-k3', KIMI)).toMatchObject({ thinkingFormat: 'openai', supportsReasoningEffort: true })
    expect(resolveModelSpec('kimi', 'kimi-k2.7-code-highspeed', KIMI)).toMatchObject({ thinkingFormat: 'deepseek', thinkingLevelMap: { off: null } })
    expect(resolveModelSpec('kimi', 'kimi-k2.6', KIMI)).toMatchObject({ reasoning: true, thinkingFormat: 'deepseek', contextWindow: 262_144 })
    expect(resolveModelSpec('kimi', 'moonshot-v1-8k', KIMI)).toMatchObject({ reasoning: false })
  })
})

describe('DashScope model specs', () => {
  it('uses enable_thinking only for hybrid models', () => {
    expect(resolveModelSpec('tongyi', 'qwen-plus', DASHSCOPE)).toMatchObject({ reasoning: true, thinkingFormat: 'qwen' })
    expect(resolveModelSpec('tongyi', 'qwen3.8-max', DASHSCOPE)).toMatchObject({ reasoning: true, thinkingFormat: 'qwen' })
    expect(resolveModelSpec('tongyi', 'qwen3-235b-a22b-instruct-2507', DASHSCOPE)).toMatchObject({ reasoning: false })
    expect(resolveModelSpec('tongyi', 'qwen-max', DASHSCOPE)).toMatchObject({ reasoning: false })
  })
})

describe('guardProviderPayload', () => {
  it('downgrades forced tool_choice in DeepSeek thinking mode but not when thinking is disabled', () => {
    const spec = resolveModelSpec('deepseek', 'deepseek-flash', DEEPSEEK)
    const named = { type: 'function', function: { name: 'read_file' } }
    expect(guardProviderPayload(spec, { thinking: { type: 'enabled' }, tool_choice: named }).payload.tool_choice).toBe('auto')
    expect(guardProviderPayload(spec, { thinking: { type: 'disabled' }, tool_choice: named }).payload.tool_choice).toEqual(named)
  })

  it('raises tiny Kimi thinking budgets but keeps connection probes small', () => {
    const spec = resolveModelSpec('kimi', 'kimi-k2.6', KIMI)
    expect(guardProviderPayload(spec, { thinking: { type: 'enabled' }, max_tokens: 4_096 }).payload.max_tokens).toBe(16_384)
    expect(guardProviderPayload(spec, { thinking: { type: 'enabled' }, max_tokens: 16 }).payload.max_tokens).toBe(16)
    expect(guardProviderPayload(spec, { thinking: { type: 'disabled' }, max_tokens: 4_096 }).payload.max_tokens).toBe(4_096)
  })

  it('keeps DashScope parallel_tool_calls when explicitly set and only adds it with tools', () => {
    const spec = resolveModelSpec('tongyi', 'qwen-plus', DASHSCOPE)
    expect(guardProviderPayload(spec, { tools: [{}], parallel_tool_calls: false }).payload.parallel_tool_calls).toBe(false)
    expect(guardProviderPayload(spec, { messages: [] }).payload).not.toHaveProperty('parallel_tool_calls')
  })

  it('never throws on non-object payloads', () => {
    const spec = resolveModelSpec('custom', 'x', 'https://example.com/v1')
    expect(guardProviderPayload(spec, null)).toEqual({ payload: {}, adjustments: [] })
  })

  it('chains after upstream hooks for every provider', async () => {
    const options = prepareRuntimeStreamOptions('tongyi', 'qwen-plus', {
      onPayload: (payload) => ({ ...(payload as object), tool_choice: 'required' }),
    }, undefined, { baseUrl: DASHSCOPE })
    const payload = await options.onPayload?.({ tools: [{}] }, {} as any) as Record<string, unknown>
    expect(payload).toMatchObject({ tool_choice: 'auto', parallel_tool_calls: true })
  })
})
