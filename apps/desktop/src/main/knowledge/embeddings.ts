import { EMBEDDINGS_PRESETS, type EmbeddingsPresetId, type EmbeddingsSettings, type EmbeddingsSettingsInput, type EmbeddingsTestResult } from '@deskforge/contracts'
import { redactSecrets } from '@deskforge/core'
import type { KnowledgeEmbedder } from './knowledge-index'

/**
 * Optional OpenAI-compatible embeddings (M4). Off by default. When enabled,
 * document chunks (during indexing) and search queries are sent to the
 * configured endpoint from the main process only; the key is stored with the
 * OS secure storage and never reaches the renderer or the agent worker.
 */

export const EMBEDDINGS_SETTING_KEY = 'knowledgeEmbeddings'
export const EMBEDDINGS_SECRET_KEY = 'knowledge.embeddings.apiKey'

export interface StoredEmbeddingsConfig {
  enabled: boolean
  preset: EmbeddingsPresetId
  baseUrl: string
  model: string
  dimensions?: number
  acknowledgedAt?: string
}

export const DEFAULT_EMBEDDINGS_CONFIG: StoredEmbeddingsConfig = {
  enabled: false,
  preset: 'dashscope-v4',
  baseUrl: EMBEDDINGS_PRESETS[0]!.baseUrl,
  model: EMBEDDINGS_PRESETS[0]!.model,
  dimensions: 1024,
}

const isLoopback = (hostname: string): boolean => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'

/** HTTPS is required except for loopback endpoints (local model servers, tests). */
export function normalizeEmbeddingsBaseUrl(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('向量接口地址无效') }
  if (url.username || url.password) throw new Error('向量接口地址不能包含账号或密码')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) throw new Error('向量接口必须使用 HTTPS（本机回环地址除外）')
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

export interface EmbeddingsClientOptions {
  baseUrl: string
  model: string
  apiKey: string
  dimensions?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class OpenAiCompatibleEmbedder implements KnowledgeEmbedder {
  readonly modelKey: string
  readonly host: string
  private readonly endpoint: string

  constructor(private options: EmbeddingsClientOptions) {
    const base = normalizeEmbeddingsBaseUrl(options.baseUrl)
    this.endpoint = `${base}/embeddings`
    this.host = new URL(base).host
    this.modelKey = `${this.host}/${options.model}${options.dimensions ? `@${options.dimensions}` : ''}`
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000)
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model: this.options.model, input: texts, encoding_format: 'float', ...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}) }),
        signal: controller.signal,
        redirect: 'error',
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 300)}`)
      let payload: { data?: Array<{ index?: number; embedding?: unknown }> }
      try { payload = JSON.parse(text) } catch { throw new Error('向量接口返回的不是 JSON') }
      const data = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      if (data.length !== texts.length) throw new Error(`向量接口返回 ${data.length} 条，期望 ${texts.length} 条`)
      return data.map((item) => {
        if (!Array.isArray(item.embedding) || !item.embedding.length || !item.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
          throw new Error('向量接口返回的 embedding 格式无效')
        }
        return Float32Array.from(item.embedding as number[])
      })
    } catch (error) {
      const message = controller.signal.aborted ? '向量接口请求超时' : error instanceof Error ? error.message : String(error)
      throw new Error(redactSecrets(message, [this.options.apiKey]))
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface EmbeddingsSettingsStore {
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  getAppSecret(key: string): Buffer | undefined
  setAppSecret(key: string, value: Buffer | null): void
}

export interface EmbeddingsSecretCodec {
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
  available(): Promise<boolean>
}

export class EmbeddingsSettingsService {
  constructor(
    private store: EmbeddingsSettingsStore,
    private secrets: EmbeddingsSecretCodec,
    private audit: (action: string, summary: string, payload: Record<string, unknown>) => void = () => undefined,
    private fetchImpl?: typeof fetch,
  ) {}

  config(): StoredEmbeddingsConfig {
    return { ...DEFAULT_EMBEDDINGS_CONFIG, ...this.store.getSetting<Partial<StoredEmbeddingsConfig>>(EMBEDDINGS_SETTING_KEY, {}) }
  }

  enabled(): boolean {
    return this.config().enabled && Boolean(this.store.getAppSecret(EMBEDDINGS_SECRET_KEY))
  }

  async view(): Promise<EmbeddingsSettings> {
    const config = this.config()
    return {
      enabled: config.enabled,
      preset: config.preset,
      baseUrl: config.baseUrl,
      model: config.model,
      ...(config.dimensions ? { dimensions: config.dimensions } : {}),
      hasKey: Boolean(this.store.getAppSecret(EMBEDDINGS_SECRET_KEY)),
      ...(config.acknowledgedAt ? { acknowledgedAt: config.acknowledgedAt } : {}),
      secureStorage: await this.secrets.available().catch(() => false),
    }
  }

  async update(input: EmbeddingsSettingsInput): Promise<EmbeddingsSettings> {
    const previous = this.config()
    const model = input.model.trim()
    const baseUrl = input.baseUrl.trim() ? normalizeEmbeddingsBaseUrl(input.baseUrl) : ''
    if (input.enabled) {
      if (!baseUrl || !model) throw new Error('启用向量检索前请填写接口地址和模型')
      if (!input.acknowledgeEgress && !(previous.acknowledgedAt && previous.baseUrl === baseUrl)) {
        throw new Error('启用前需要确认：文档片段和搜索词会发送到所配置的向量接口')
      }
    }
    if (input.apiKey) this.store.setAppSecret(EMBEDDINGS_SECRET_KEY, await this.secrets.encrypt(input.apiKey))
    else if (input.clearKey) this.store.setAppSecret(EMBEDDINGS_SECRET_KEY, null)
    if (input.enabled && !this.store.getAppSecret(EMBEDDINGS_SECRET_KEY)) throw new Error('启用向量检索前请填写 API Key')
    const next: StoredEmbeddingsConfig = {
      enabled: input.enabled,
      preset: input.preset,
      baseUrl,
      model,
      ...(input.dimensions ? { dimensions: input.dimensions } : {}),
      ...(input.enabled && input.acknowledgeEgress ? { acknowledgedAt: new Date().toISOString() } : previous.acknowledgedAt && previous.baseUrl === baseUrl ? { acknowledgedAt: previous.acknowledgedAt } : {}),
    }
    this.store.setSetting(EMBEDDINGS_SETTING_KEY, next)
    const host = baseUrl ? new URL(baseUrl).host : ''
    this.audit('embeddings_config', next.enabled ? `已启用向量检索（${host} · ${model}）` : '向量检索已关闭', { enabled: next.enabled, host, model, keyUpdated: Boolean(input.apiKey), keyCleared: Boolean(input.clearKey) })
    return this.view()
  }

  /** Embedder for indexing/search, or undefined when disabled or not configured. */
  async embedder(): Promise<OpenAiCompatibleEmbedder | undefined> {
    const config = this.config()
    if (!config.enabled || !config.baseUrl || !config.model) return undefined
    const blob = this.store.getAppSecret(EMBEDDINGS_SECRET_KEY)
    if (!blob) return undefined
    const apiKey = await this.secrets.decrypt(blob)
    return new OpenAiCompatibleEmbedder({ baseUrl: config.baseUrl, model: config.model, apiKey, ...(config.dimensions ? { dimensions: config.dimensions } : {}), ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) })
  }

  async apiKey(): Promise<string | undefined> {
    const blob = this.store.getAppSecret(EMBEDDINGS_SECRET_KEY)
    return blob ? this.secrets.decrypt(blob).catch(() => undefined) : undefined
  }

  /** Sends one short fixed probe string; never document content. */
  async test(): Promise<EmbeddingsTestResult> {
    const started = Date.now()
    const config = this.config()
    try {
      if (!config.baseUrl || !config.model) throw new Error('请先填写接口地址和模型')
      const blob = this.store.getAppSecret(EMBEDDINGS_SECRET_KEY)
      if (!blob) throw new Error('请先保存 API Key')
      const apiKey = await this.secrets.decrypt(blob)
      const client = new OpenAiCompatibleEmbedder({ baseUrl: config.baseUrl, model: config.model, apiKey, ...(config.dimensions ? { dimensions: config.dimensions } : {}), ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), timeoutMs: 15_000 })
      const [vector] = await client.embed(['DeskForge 连接测试'])
      return { ok: true, latencyMs: Date.now() - started, dimensions: vector!.length }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
