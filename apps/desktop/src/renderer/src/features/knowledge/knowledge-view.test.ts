import { describe, expect, it } from 'vitest'
import type { EmbeddingsView, KnowledgeStatusItem } from '../../types'
import { applyPreset, draftFromView, draftToInput, endpointHost, knowledgeSummary, lastRunSummary, needsEgressAck, skippedSummary } from './knowledge-view'

const status: KnowledgeStatusItem = {
  workspaceId: 'ws', workspaceName: 'Demo', rootPath: '/tmp/demo', state: 'ready', fileCount: 12, chunkCount: 40, indexedBytes: 2048, storageBytes: 4 * 1024 * 1024,
  lastDurationMs: 1500, lastRun: { added: 2, updated: 1, unchanged: 9, removed: 0 },
  skipped: { ignored: 3, symlinks: 1, unsupported: 5, sensitive: 1, tooLarge: 0, binary: 0, unreadable: 0 }, truncated: false,
  embeddings: { enabled: true, embeddedChunks: 40, model: 'x/text-embedding-v4' },
}
const saved: EmbeddingsView = { enabled: true, preset: 'dashscope-v4', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v4', dimensions: 1024, hasKey: true, acknowledgedAt: '2026-10-06T00:00:00.000Z', secureStorage: true }

describe('knowledge settings view helpers', () => {
  it('summarizes index status in Chinese', () => {
    expect(knowledgeSummary(status)).toBe('12 个文件 · 40 个片段 · 正文 2.0 KB · 索引占用 4.0 MB · 40 个向量')
    expect(knowledgeSummary({ ...status, state: 'empty' })).toBe('尚未建立索引')
    expect(skippedSummary(status)).toBe('已跳过：忽略 3，敏感文件 1，符号链接 1，不支持的类型 5')
    expect(lastRunSummary(status)).toBe('上次：新增 2，更新 1，未变 9，移除 0，用时 1.5 秒')
  })

  it('applies presets and requires egress acknowledgement for a new endpoint', () => {
    const draft = applyPreset({ ...draftFromView(saved), preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1' }, 'dashscope-v3')
    expect(draft).toMatchObject({ preset: 'dashscope-v3', model: 'text-embedding-v3', dimensions: '1024' })
    expect(needsEgressAck(draftFromView(saved), saved)).toBe(false)
    expect(needsEgressAck({ ...draftFromView(saved), baseUrl: 'https://api.openai.com/v1' }, saved)).toBe(true)
    expect(needsEgressAck({ ...draftFromView(saved), enabled: false }, undefined)).toBe(false)
    expect(draftToInput({ ...draftFromView(saved), apiKey: ' key ' }, true)).toEqual({ enabled: true, preset: 'dashscope-v4', baseUrl: saved.baseUrl, model: 'text-embedding-v4', dimensions: 1024, apiKey: 'key', acknowledgeEgress: true })
    expect(endpointHost(saved.baseUrl)).toBe('dashscope.aliyuncs.com')
    expect(endpointHost('nope')).toBe('')
  })
})
