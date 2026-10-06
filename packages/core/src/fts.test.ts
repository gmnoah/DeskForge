import { describe, expect, it } from 'vitest'
import { excerptAround, likePattern, planFtsQuery, termHits } from './fts'
import { chunkText } from './text-chunks'
import { cosineSimilarity, reciprocalRankFusion, topK } from './hybrid-rank'

describe('FTS query planning (trigram + LIKE fallback)', () => {
  it('quotes long terms for MATCH and routes short CJK terms to LIKE', () => {
    const plan = planFtsQuery('季度报告 周报 "deploy" UI')
    expect(plan.terms).toEqual(['季度报告', '周报', 'deploy', 'UI'])
    expect(plan.match).toBe('"季度报告" AND "deploy"')
    expect(plan.likeTerms).toEqual(['周报', 'UI'])
  })

  it('neutralizes FTS syntax and de-duplicates case-insensitively', () => {
    const plan = planFtsQuery('NEAR(foo* bar) foo* FOO OR -x')
    expect(plan.match).not.toMatch(/[*()]/)
    expect(plan.terms.filter((term) => term.toLowerCase() === 'foo')).toHaveLength(1)
    expect(planFtsQuery('   ').terms).toEqual([])
    expect(planFtsQuery('，。！').match).toBeUndefined()
  })

  it('escapes LIKE wildcards and builds excerpts around the first hit', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%')
    const text = `${'前言'.repeat(50)} 这里讨论了周报模板的结构 ${'尾声'.repeat(50)}`
    const excerpt = excerptAround(text, ['周报'], 10)
    expect(excerpt).toContain('周报')
    expect(excerpt.startsWith('…')).toBe(true)
    expect(termHits('Deploy deploy DEPLOY', ['deploy'])).toBe(3)
  })
})

describe('text chunking', () => {
  it('keeps accurate 1-based line ranges and prefers heading boundaries', () => {
    const text = ['# 标题一', ...Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行内容 ${'x'.repeat(20)}`), '', '## 标题二', 'tail line'].join('\n')
    const chunks = chunkText(text, { maxChars: 600, softChars: 300 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.startLine).toBe(1)
    for (let index = 1; index < chunks.length; index += 1) expect(chunks[index]!.startLine).toBeGreaterThan(chunks[index - 1]!.endLine)
    const lines = text.split('\n')
    for (const chunk of chunks) expect(chunk.text.split('\n')[0]).toBe(lines[chunk.startLine - 1])
    expect(chunks.at(-1)!.endLine).toBe(lines.length)
  })

  it('bounds minified single lines and skips blank-only chunks', () => {
    const chunks = chunkText(`${'a'.repeat(5000)}\n\n\n`, { maxChars: 1000 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text.length).toBeLessThanOrEqual(1001)
    expect(chunkText('\n\n  \n')).toEqual([])
  })
})

describe('hybrid ranking', () => {
  it('computes cosine similarity safely', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('fuses keyword and vector rankings with RRF', () => {
    const fused = reciprocalRankFusion([{ ids: ['a', 'b', 'c'] }, { ids: ['c', 'd', 'a'] }])
    expect(fused[0]!.id).toBe('a')
    expect(fused.map((item) => item.id)).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']))
    expect(fused.find((item) => item.id === 'd')!.sources).toEqual([1])
    expect(topK([3, 1, 4, 1, 5, 9, 2], 3, (value) => value).map((entry) => entry.item)).toEqual([9, 5, 4])
  })
})
