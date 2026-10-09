import { describe, expect, it } from 'vitest'
import { calculateTokenCost, findModelPricing } from './pricing'

describe('Model Pricing Engine', () => {
  it('finds pricing rates for known models', () => {
    expect(findModelPricing('deepseek-flash', 'deepseek')).toBeDefined()
    expect(findModelPricing('deepseek-chat', 'deepseek')).toBeDefined()
    expect(findModelPricing('kimi-k2.6', 'kimi')).toBeDefined()
    expect(findModelPricing('qwen-plus', 'tongyi')).toBeDefined()
    expect(findModelPricing('claude-3-5-sonnet', 'custom')).toBeDefined()
    expect(findModelPricing('gpt-4o', 'custom')).toBeDefined()
  })

  it('falls back to provider default when modelId is unknown but provider is recognized', () => {
    const rate = findModelPricing('unknown-ds-model', 'deepseek')
    expect(rate).toBeDefined()
    expect(rate?.inputPerMillionCny).toBe(1.0)
  })

  it('returns undefined for truly unknown custom model and provider', () => {
    expect(findModelPricing('my-local-llama', 'custom')).toBeUndefined()
  })

  it('calculates token cost accurately with cache discount and output pricing', () => {
    // DeepSeek Flash:
    // Input miss: 1 CNY / 1M => 1,000,000 tokens = 1 CNY
    // Cache hit: 0.1 CNY / 1M => 10,000,000 tokens = 1 CNY
    // Output: 2 CNY / 1M => 500,000 tokens = 1 CNY
    const result = calculateTokenCost('deepseek-flash', 'deepseek', {
      promptTokens: 1_000_000,
      cacheReadTokens: 10_000_000,
      completionTokens: 500_000,
    })

    expect(result.hasPricing).toBe(true)
    expect(result.costCny).toBe(3.0) // 1.0 + 1.0 + 1.0
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('handles zero tokens gracefully without NaN or negative values', () => {
    const result = calculateTokenCost('deepseek-flash', 'deepseek', {
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
    })

    expect(result.hasPricing).toBe(true)
    expect(result.costCny).toBe(0)
    expect(result.costUsd).toBe(0)
  })

  it('reports hasPricing: false for unknown models with 0 cost', () => {
    const result = calculateTokenCost('my-custom-model', 'custom', {
      promptTokens: 100_000,
      completionTokens: 10_000,
    })

    expect(result.hasPricing).toBe(false)
    expect(result.costCny).toBe(0)
    expect(result.costUsd).toBe(0)
  })
})
