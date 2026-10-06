import type { EmbeddingsInput, EmbeddingsPresetId, EmbeddingsView, KnowledgeStatusItem } from '../../types'

/** Mirrors EMBEDDINGS_PRESETS in @deskforge/contracts (kept local so the renderer bundle stays zod-free). */
export const EMBEDDING_PRESETS: Array<{ id: EmbeddingsPresetId; label: string; baseUrl: string; model: string; dimensions?: number }> = [
  { id: 'dashscope-v4', label: '通义 DashScope · text-embedding-v4', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v4', dimensions: 1024 },
  { id: 'dashscope-v3', label: '通义 DashScope · text-embedding-v3', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3', dimensions: 1024 },
  { id: 'openai-3-small', label: 'OpenAI · text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
  { id: 'custom', label: '自定义 OpenAI 兼容接口', baseUrl: '', model: '' },
]

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const KNOWLEDGE_STATE_LABEL: Record<KnowledgeStatusItem['state'], string> = { empty: '未建立', indexing: '索引中', ready: '已就绪', error: '出错' }

export function knowledgeSummary(status: KnowledgeStatusItem): string {
  if (status.state === 'empty') return '尚未建立索引'
  const parts = [`${status.fileCount} 个文件`, `${status.chunkCount} 个片段`, `正文 ${formatBytes(status.indexedBytes)}`, `索引占用 ${formatBytes(status.storageBytes)}`]
  if (status.embeddings.embeddedChunks) parts.push(`${status.embeddings.embeddedChunks} 个向量`)
  return parts.join(' · ')
}

export function skippedSummary(status: KnowledgeStatusItem): string {
  const { skipped } = status
  const parts: string[] = []
  if (skipped.ignored) parts.push(`忽略 ${skipped.ignored}`)
  if (skipped.sensitive) parts.push(`敏感文件 ${skipped.sensitive}`)
  if (skipped.symlinks) parts.push(`符号链接 ${skipped.symlinks}`)
  if (skipped.tooLarge) parts.push(`超大 ${skipped.tooLarge}`)
  if (skipped.binary) parts.push(`二进制 ${skipped.binary}`)
  if (skipped.unsupported) parts.push(`不支持的类型 ${skipped.unsupported}`)
  if (skipped.unreadable) parts.push(`无法读取 ${skipped.unreadable}`)
  return parts.length ? `已跳过：${parts.join('，')}` : ''
}

export function lastRunSummary(status: KnowledgeStatusItem): string {
  if (!status.lastRun) return ''
  const { added, updated, unchanged, removed } = status.lastRun
  const duration = status.lastDurationMs !== undefined ? `，用时 ${(status.lastDurationMs / 1000).toFixed(1)} 秒` : ''
  return `上次：新增 ${added}，更新 ${updated}，未变 ${unchanged}，移除 ${removed}${duration}`
}

export function limitReasonLabel(reason?: string): string {
  if (!reason) return ''
  return ({ max_files: '已达到文件数上限（5000）', max_entries: '目录项过多，扫描已截断', time_budget: '扫描超时，已索引部分文件' } as Record<string, string>)[reason] ?? reason
}

export function endpointHost(baseUrl: string): string {
  try { return new URL(baseUrl).host } catch { return '' }
}

export interface EmbeddingsDraft {
  enabled: boolean
  preset: EmbeddingsPresetId
  baseUrl: string
  model: string
  dimensions: string
  apiKey: string
}

export function draftFromView(view: EmbeddingsView): EmbeddingsDraft {
  return { enabled: view.enabled, preset: view.preset, baseUrl: view.baseUrl, model: view.model, dimensions: view.dimensions ? String(view.dimensions) : '', apiKey: '' }
}

export function applyPreset(draft: EmbeddingsDraft, preset: EmbeddingsPresetId): EmbeddingsDraft {
  const meta = EMBEDDING_PRESETS.find((item) => item.id === preset)
  if (!meta || preset === 'custom') return { ...draft, preset }
  return { ...draft, preset, baseUrl: meta.baseUrl, model: meta.model, dimensions: meta.dimensions ? String(meta.dimensions) : '' }
}

/** Enabling for a new endpoint needs a fresh egress acknowledgement. */
export function needsEgressAck(draft: EmbeddingsDraft, saved: EmbeddingsView | undefined): boolean {
  if (!draft.enabled) return false
  return !saved?.acknowledgedAt || saved.baseUrl.replace(/\/+$/, '') !== draft.baseUrl.trim().replace(/\/+$/, '')
}

export function draftToInput(draft: EmbeddingsDraft, acknowledgeEgress: boolean): EmbeddingsInput {
  const dimensions = Number.parseInt(draft.dimensions, 10)
  return {
    enabled: draft.enabled,
    preset: draft.preset,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    ...(Number.isFinite(dimensions) && dimensions > 0 ? { dimensions } : {}),
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    ...(acknowledgeEgress ? { acknowledgeEgress: true } : {}),
  }
}
