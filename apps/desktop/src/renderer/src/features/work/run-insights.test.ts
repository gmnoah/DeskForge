import { describe, expect, it } from 'vitest'
import { failureMessage, failureTechnicalDetail, formatTokenCount, readTokenUsage, tokenUsageLines } from './run-insights'

describe('token usage view', () => {
  it('ignores missing or empty usage', () => {
    expect(readTokenUsage(undefined)).toBeUndefined()
    expect(readTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBeUndefined()
  })

  it('formats cache hits and reasoning tokens in Chinese', () => {
    const usage = readTokenUsage({ inputTokens: 2_000, cacheReadTokens: 10_000, outputTokens: 800, reasoningTokens: 300, totalTokens: 12_800, modelCalls: 3 })!
    expect(tokenUsageLines(usage)).toEqual([
      { label: '合计', value: '12.8k tokens' },
      { label: '输入', value: '12.0k（缓存命中 10.0k）' },
      { label: '输出', value: '800（含思考 300）' },
      { label: '模型调用', value: '3 次' },
    ])
    expect(formatTokenCount(1_234)).toBe('1,234')
    expect(formatTokenCount(2_500_000)).toBe('2.5M')
  })
})

describe('failure message', () => {
  it('shows classified model errors with their guidance', () => {
    const error = { code: 'MODEL_AUTH_FAILED', message: 'DeepSeek拒绝了 API Key（认证失败）。', suggestedAction: '请更新 Key。', details: { raw: '401 Authentication Fails' } }
    expect(failureMessage(error)).toBe('DeepSeek拒绝了 API Key（认证失败）。请更新 Key。')
    expect(failureTechnicalDetail(error)).toBe('401 Authentication Fails')
  })

  it('hides internal noise behind a generic message', () => {
    expect(failureMessage({ code: 'RUN_ERROR', message: 'SQLITE_CONSTRAINT failed' })).toContain('这次操作没有完成')
    expect(failureMessage({ code: 'RUN_ERROR', message: '模型配置尚未设置 API Key' })).toBe('模型配置尚未设置 API Key')
    expect(failureMessage(undefined)).toContain('这次操作没有完成')
  })
})
