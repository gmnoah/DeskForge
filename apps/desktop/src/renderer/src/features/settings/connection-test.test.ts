import { describe, expect, it } from 'vitest'
import { connectionTestFailure, describeConnectionTest } from './connection-test'

describe('describeConnectionTest', () => {
  it('summarises a success with latency and alias notices', () => {
    expect(describeConnectionTest({ ok: true, provider: 'deepseek', modelId: 'deepseek-flash', latencyMs: 412.6 })).toEqual({ tone: 'success', title: '连接成功', detail: '模型 deepseek-flash 可用 · 耗时 413 ms' })
    expect(describeConnectionTest({ ok: true, modelId: 'deepseek-chat', latencyMs: 1, notice: 'deepseek-chat 已于 2026-07-24 下线' }).notice).toContain('下线')
  })

  it('surfaces the classified Chinese message, suggestion and raw detail', () => {
    const view = describeConnectionTest({
      ok: false, provider: 'kimi', modelId: 'kimi-k2.6', latencyMs: 80,
      error: { code: 'MODEL_AUTH_FAILED', message: 'Kimi拒绝了 API Key（认证失败）。', retryable: false, suggestedAction: 'Key 与服务地址必须同属一个平台。', details: { raw: '401 Invalid Authentication', status: 401 } },
    })
    expect(view).toEqual({ tone: 'error', title: 'Kimi拒绝了 API Key（认证失败）。', suggestion: 'Key 与服务地址必须同属一个平台。', technical: '401 Invalid Authentication' })
  })

  it('falls back to a generic failure and strips Electron IPC prefixes', () => {
    expect(describeConnectionTest(undefined).title).toBe('连接测试失败')
    expect(connectionTestFailure(new Error("Error invoking remote method 'deskforge:invoke': Error: 请先填写 API Key 再测试连接")).title).toBe('请先填写 API Key 再测试连接')
  })
})
