import { describe, expect, it } from 'vitest'
import { formatTokenCount } from '../work/run-insights'

describe('Analytics Calculations and Formatting', () => {
  it('formats token count into compact readable strings', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(500)).toBe('500')
    expect(formatTokenCount(9_999)).toBe('9,999')
    expect(formatTokenCount(10_000)).toBe('10.0k')
    expect(formatTokenCount(518_000)).toBe('518k')
    expect(formatTokenCount(1_000_000)).toBe('1.0M')
    expect(formatTokenCount(7_100_000)).toBe('7.1M')
    expect(formatTokenCount(151_000_000)).toBe('151M')
  })

  it('computes cache hit rate safely with zero tokens', () => {
    const calcHitRate = (cacheRead: number, prompt: number) => {
      const totalPrompt = prompt + cacheRead
      return totalPrompt > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0
    }

    expect(calcHitRate(0, 0)).toBe(0)
    expect(calcHitRate(144_000_000, 7_100_000)).toBe(95)
    expect(calcHitRate(50, 50)).toBe(50)
  })

  it('formats currency correctly for USD and CNY with sub-cent precision', () => {
    const formatCost = (val: number, cur: 'USD' | 'CNY') => {
      const symbol = cur === 'USD' ? '$' : '¥'
      if (val < 0.01 && val > 0) return `<${symbol}0.01`
      return `${symbol}${val.toFixed(2)}`
    }

    expect(formatCost(47.79, 'USD')).toBe('$47.79')
    expect(formatCost(342.5, 'CNY')).toBe('¥342.50')
    expect(formatCost(0.0001, 'USD')).toBe('<$0.01')
    expect(formatCost(0, 'USD')).toBe('$0.00')
  })
})
