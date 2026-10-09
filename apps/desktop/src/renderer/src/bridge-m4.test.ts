import { describe, expect, it } from 'vitest'
import { normalizeArtifact, normalizeEmbeddings, normalizeKnowledgeSearch, normalizeKnowledgeStatus, normalizeSessionHit } from './bridge'

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

  it('normalizes artifacts extracting real target filename and workspace sourcePath', () => {
    const item = normalizeArtifact({
      id: 'art-1',
      kind: 'final_output',
      name: '昭山 · 山市晴岚 — 单文件介绍页',
      path: '/Users/mac/Library/Application Support/DeskForge/artifacts/a8/hash',
      metadata: {
        sourcePath: '/Users/mac/NOAH/NOAH知识/网页产出/昭山风景区介绍.html',
        registeredBy: 'output_register',
      },
    }, 0)

    expect(item.name).toBe('昭山风景区介绍.html')
    expect(item.fileName).toBe('昭山风景区介绍.html')
    expect(item.label).toBe('昭山 · 山市晴岚 — 单文件介绍页')
    expect(item.sourcePath).toBe('/Users/mac/NOAH/NOAH知识/网页产出/昭山风景区介绍.html')
    expect(item.path).toBe('/Users/mac/NOAH/NOAH知识/网页产出/昭山风景区介绍.html')
  })

  it('preserves generic artifact name when no workspace sourcePath is available', () => {
    const item = normalizeArtifact({
      id: 'art-2',
      kind: 'diff',
      name: 'app.tsx.diff',
      path: '/Users/mac/Library/Application Support/DeskForge/artifacts/b2/hash',
    }, 1)

    expect(item.name).toBe('app.tsx.diff')
    expect(item.sourcePath).toBeUndefined()
    expect(item.path).toBe('/Users/mac/Library/Application Support/DeskForge/artifacts/b2/hash')
  })
})
