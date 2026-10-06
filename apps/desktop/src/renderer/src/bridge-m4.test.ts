import { describe, expect, it } from 'vitest'
import { normalizeEmbeddings, normalizeKnowledgeSearch, normalizeKnowledgeStatus, normalizeSessionHit } from './bridge'

describe('M4 bridge normalizers', () => {
  it('normalizes session hits and knowledge payloads defensively', () => {
    expect(normalizeSessionHit({ runId: 'r1', title: '周报', status: 'completed', matchedIn: 'title', snippet: 'x' })).toMatchObject({ runId: 'r1', matchedIn: 'title' })
    expect(normalizeSessionHit({ runId: 'r2' })).toMatchObject({ title: '未命名会话', matchedIn: 'message' })
    const status = normalizeKnowledgeStatus({ workspaceId: 'w', state: 'bogus', skipped: { ignored: 2 }, embeddings: {} })
    expect(status).toMatchObject({ state: 'empty', fileCount: 0, skipped: { ignored: 2, sensitive: 0 }, embeddings: { enabled: false, embeddedChunks: 0 } })
    const search = normalizeKnowledgeSearch({ query: 'q', mode: 'hybrid', state: 'ready', results: [{ path: 'a.md', startLine: 3, endLine: 5, snippet: 's', matchedBy: 'semantic' }, { path: 'b.md' }] })
    expect(search.mode).toBe('hybrid')
    expect(search.results.map((hit) => hit.matchedBy)).toEqual(['semantic', 'keyword'])
    expect(normalizeEmbeddings({ preset: 'nope', enabled: true, hasKey: true })).toMatchObject({ preset: 'dashscope-v4', enabled: true, hasKey: true, secureStorage: true })
  })
})
