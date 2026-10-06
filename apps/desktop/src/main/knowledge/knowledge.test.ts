import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

import { KnowledgeIndexService, snippetForChunk } from './knowledge-index'
import { EMBEDDINGS_SECRET_KEY, EmbeddingsSettingsService, normalizeEmbeddingsBaseUrl } from './embeddings'
import { extractDocxText } from './docx-text'
import { isSensitiveFile, knowledgeFileKind } from './file-policy'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Minimal ZIP writer (deflate) producing a valid-enough .docx for the extractor. */
function makeDocx(paragraphs: string[]): Buffer {
  const xml = `<?xml version="1.0"?><w:document><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`
  const name = Buffer.from('word/document.xml')
  const raw = Buffer.from(xml)
  const data = deflateRawSync(raw)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42)
  const centralOffset = local.length + name.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, name, data, central, name, end])
}

interface Fixture { root: string; outside: string; dataDir: string; service: KnowledgeIndexService }

async function fixture(options: { embeddings?: EmbeddingsSettingsService } = {}): Promise<Fixture> {
  const root = await tempDir('deskforge-kb-ws-')
  const outside = await tempDir('deskforge-kb-outside-')
  const dataDir = await tempDir('deskforge-kb-data-')
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'build'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, '.gitignore'), 'build/\n*.generated.md\n')
  await writeFile(join(root, 'docs', '周报.md'), ['# 第 40 周周报', '', '本周完成了支付服务的灰度发布。', '下周计划：回滚演练和容量评估。'].join('\n'))
  await writeFile(join(root, 'docs', 'deploy.md'), ['# Deployment guide', '', 'Run the canary rollout first.', 'Then promote to production after smoke tests.'].join('\n'))
  await writeFile(join(root, 'src', 'billing.ts'), ['export function computeInvoiceTotal(items: number[]): number {', '  return items.reduce((sum, item) => sum + item, 0)', '}'].join('\n'))
  await writeFile(join(root, 'build', 'out.md'), 'ignored build artifact canary')
  await writeFile(join(root, 'notes.generated.md'), 'ignored generated canary')
  await writeFile(join(root, 'node_modules', 'pkg', 'README.md'), 'dependency canary')
  await writeFile(join(root, '.env'), 'API_KEY=canary-secret-value')
  await writeFile(join(root, 'server.pem'), '-----BEGIN PRIVATE KEY-----')
  await writeFile(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))
  await writeFile(join(root, 'data.txt'), Buffer.from([0x61, 0x00, 0x62]))
  await writeFile(join(root, 'big.txt'), 'x'.repeat(2048))
  await writeFile(join(root, 'docs', '方案.docx'), makeDocx(['项目方案：知识库检索', '采用 trigram 分词支持中文 & English']))
  await writeFile(join(outside, 'secret.md'), 'outside canary should never be indexed')
  await mkdir(join(outside, 'dir'))
  await writeFile(join(outside, 'dir', 'leak.md'), 'outside directory canary')
  await symlink(join(outside, 'secret.md'), join(root, 'docs', 'link.md'))
  await symlink(join(outside, 'dir'), join(root, 'linked-dir'))
  const service = new KnowledgeIndexService({
    directory: dataDir,
    resolveWorkspace: (id) => (id === 'ws-1' ? { id, name: 'Demo', path: root } : undefined),
    limits: { maxTextBytes: 1024 },
    ...(options.embeddings ? { embedder: () => options.embeddings!.embedder(), embeddingsEnabled: () => options.embeddings!.enabled() } : {}),
  })
  cleanups.push(() => service.close())
  return { root, outside, dataDir, service }
}

describe('knowledge file policy', () => {
  it('classifies supported files and refuses credential files', () => {
    expect(knowledgeFileKind('docs/a.md')).toBe('text')
    expect(knowledgeFileKind('src/a.tsx')).toBe('code')
    expect(knowledgeFileKind('Makefile')).toBe('text')
    expect(knowledgeFileKind('x.docx')).toBe('docx')
    expect(knowledgeFileKind('pnpm-lock.yaml')).toBeUndefined()
    expect(knowledgeFileKind('app.min.js')).toBeUndefined()
    expect(knowledgeFileKind('photo.png')).toBeUndefined()
    for (const name of ['.env', '.env.local', 'prod.env', 'id_rsa', 'server.key', '.npmrc', 'credentials.json', 'service-account-prod.json']) expect(isSensitiveFile(name)).toBe(true)
    expect(isSensitiveFile('.env.example')).toBe(false)
    expect(isSensitiveFile('secret-redaction.ts')).toBe(false)
  })

  it('extracts paragraphs from a .docx', () => {
    expect(extractDocxText(makeDocx(['第一段', 'A & B']))).toBe('第一段\nA & B')
    expect(() => extractDocxText(Buffer.from('not a zip'))).toThrow()
  })
})

describe('knowledge index', () => {
  it('indexes only confined, non-ignored, supported files and stores the DB outside the workspace', async () => {
    const { root, dataDir, service } = await fixture()
    const status = await service.build('ws-1')
    expect(status.state).toBe('ready')
    expect(status.fileCount).toBe(4) // 周报.md, deploy.md, billing.ts, 方案.docx
    expect(status.skipped.sensitive).toBe(2)
    expect(status.skipped.symlinks).toBeGreaterThanOrEqual(2)
    expect(status.skipped.binary).toBe(1)
    expect(status.skipped.tooLarge).toBe(1)
    expect(status.skipped.ignored).toBeGreaterThanOrEqual(3)
    expect(status.lastRun).toEqual({ added: 4, updated: 0, unchanged: 0, removed: 0 })
    expect(service.databasePath('ws-1').startsWith(dataDir)).toBe(true)
    expect((await readdir(root)).some((name) => name.includes('sqlite') || name.includes('deskforge'))).toBe(false)
    for (const canary of ['outside', 'ignored', 'dependency', 'canary-secret-value', 'PRIVATE KEY']) {
      const result = await service.search('ws-1', canary)
      expect(result.results.map((hit) => hit.path)).toEqual([])
    }
  })

  it('answers Chinese and English queries with ranked snippets and line ranges', async () => {
    const { service } = await fixture()
    await service.build('ws-1')
    const chinese = await service.search('ws-1', '回滚演练')
    expect(chinese.mode).toBe('keyword')
    expect(chinese.results[0]).toMatchObject({ path: 'docs/周报.md', matchedBy: 'keyword', startLine: 3, endLine: 4 })
    expect(chinese.results[0]!.snippet).toContain('回滚演练')
    // Two-character Chinese terms fall back to LIKE.
    expect((await service.search('ws-1', '周报')).results[0]!.path).toBe('docs/周报.md')
    const english = await service.search('ws-1', 'canary rollout')
    expect(english.results[0]).toMatchObject({ path: 'docs/deploy.md', startLine: 2 })
    expect((await service.search('ws-1', 'computeInvoiceTotal')).results[0]).toMatchObject({ path: 'src/billing.ts', startLine: 1 })
    expect((await service.search('ws-1', 'trigram 分词')).results[0]!.path).toBe('docs/方案.docx')
    // Natural-language queries fall back to OR ranking when no chunk has every term.
    expect((await service.search('ws-1', 'production 容量评估 nonexistentword')).results.map((hit) => hit.path)).toEqual(expect.arrayContaining(['docs/deploy.md', 'docs/周报.md']))
    expect((await service.search('ws-1', 'rollout', { pathPrefix: 'src/' })).results).toEqual([])
    expect((await service.search('ws-1', 'zzzz-not-present')).note).toContain('没有找到')
  })

  it('re-indexes incrementally by mtime/hash and removes deleted or newly ignored files', async () => {
    const { root, service } = await fixture()
    await service.build('ws-1')
    const second = await service.build('ws-1')
    expect(second.lastRun).toEqual({ added: 0, updated: 0, unchanged: 4, removed: 0 })

    // Touch without content change → hash matches, counted unchanged.
    const future = new Date(Date.now() + 60_000)
    await utimes(join(root, 'docs', 'deploy.md'), future, future)
    await writeFile(join(root, 'src', 'billing.ts'), 'export const currency = "CNY" // 结算币种\n')
    await writeFile(join(root, 'docs', 'new.md'), '新增文档：灰度策略说明')
    await rm(join(root, 'docs', '周报.md'))
    await writeFile(join(root, '.gitignore'), 'build/\n*.generated.md\n*.docx\n')
    const third = await service.build('ws-1')
    expect(third.lastRun).toEqual({ added: 1, updated: 1, unchanged: 1, removed: 2 })
    expect((await service.search('ws-1', '结算币种')).results[0]!.path).toBe('src/billing.ts')
    expect((await service.search('ws-1', 'computeInvoiceTotal')).results).toEqual([])
    expect((await service.search('ws-1', '回滚演练')).results).toEqual([])
    expect((await service.search('ws-1', '灰度策略')).results[0]!.path).toBe('docs/new.md')

    const full = await service.build('ws-1', 'full')
    expect(full.lastRun?.added).toBe(3)
    const cleared = await service.clear('ws-1')
    expect(cleared).toMatchObject({ state: 'empty', fileCount: 0, chunkCount: 0 })
    expect((await service.search('ws-1', '灰度')).note).toContain('尚未建立')
    await expect(service.build('missing')).rejects.toThrow('工作区不存在')
  })

  it('computes snippet line ranges relative to the chunk', () => {
    expect(snippetForChunk({ content: 'a\nb\nneedle here\nc', start_line: 10 }, ['needle'])).toMatchObject({ startLine: 11, endLine: 13 })
  })
})

// ---------------------------------------------------------------------------
// Embeddings: mock OpenAI-compatible server with deterministic "semantic" vectors.

const TOPICS: Array<[RegExp, number]> = [[/支付|payment|invoice|账单|billing/i, 0], [/部署|deploy|rollout|上线|发布/i, 1], [/周报|weekly|report/i, 2], [/知识库|knowledge|检索/i, 3]]
function topicVector(text: string): number[] {
  const vector = [0, 0, 0, 0, 0]
  for (const [pattern, index] of TOPICS) if (pattern.test(text)) vector[index] = 1
  if (!vector.some(Boolean)) vector[4] = 1
  return vector
}

interface MockServer { url: string; requests: Array<{ auth: string | undefined; body: any }> }
async function mockEmbeddingsServer(): Promise<MockServer> {
  const requests: MockServer['requests'] = []
  const server: Server = createServer(async (request: IncomingMessage, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push({ auth: request.headers.authorization, body })
    if (request.url !== '/v1/embeddings' || request.headers.authorization !== 'Bearer test-embed-key') {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad key test-embed-key' }))
      return
    }
    const inputs: string[] = body.input
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: topicVector(text) })).reverse(), model: body.model }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/v1`, requests }
}

function memoryStore() {
  const settings = new Map<string, unknown>()
  const secrets = new Map<string, Buffer>()
  return {
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? settings.get(key) as T : fallback),
    setSetting: (key: string, value: unknown) => { settings.set(key, value) },
    getAppSecret: (key: string) => secrets.get(key),
    setAppSecret: (key: string, value: Buffer | null) => { if (value) secrets.set(key, value); else secrets.delete(key) },
    settings,
    secrets,
  }
}
const cipher = {
  encrypt: async (value: string) => Buffer.from(value.split('').reverse().join('')),
  decrypt: async (value: Buffer) => value.toString().split('').reverse().join(''),
  available: async () => true,
}

describe('optional embeddings', () => {
  it('is off by default: no network calls and keyword search still works', async () => {
    const server = await mockEmbeddingsServer()
    const store = memoryStore()
    const embeddings = new EmbeddingsSettingsService(store, cipher)
    expect((await embeddings.view())).toMatchObject({ enabled: false, preset: 'dashscope-v4', hasKey: false })
    expect(await embeddings.embedder()).toBeUndefined()
    const { service } = await fixture({ embeddings })
    const status = await service.build('ws-1')
    expect(status.embeddings).toMatchObject({ enabled: false, embeddedChunks: 0 })
    const result = await service.search('ws-1', '回滚演练')
    expect(result.mode).toBe('keyword')
    expect(result.results[0]!.path).toBe('docs/周报.md')
    expect(server.requests).toHaveLength(0)
  })

  it('requires explicit egress acknowledgement and a key; stores the key encrypted', async () => {
    const server = await mockEmbeddingsServer()
    const store = memoryStore()
    const audits: string[] = []
    const embeddings = new EmbeddingsSettingsService(store, cipher, (action) => audits.push(action))
    const base = { enabled: true, preset: 'custom' as const, baseUrl: server.url, model: 'mock-embed' }
    await expect(embeddings.update({ ...base, apiKey: 'test-embed-key' })).rejects.toThrow('需要确认')
    await expect(embeddings.update({ ...base, acknowledgeEgress: true })).rejects.toThrow('API Key')
    const view = await embeddings.update({ ...base, apiKey: 'test-embed-key', acknowledgeEgress: true })
    expect(view).toMatchObject({ enabled: true, hasKey: true, baseUrl: server.url, model: 'mock-embed' })
    expect(view.acknowledgedAt).toBeTruthy()
    expect(JSON.stringify([...store.settings.values()])).not.toContain('test-embed-key')
    expect(store.secrets.get(EMBEDDINGS_SECRET_KEY)!.toString()).not.toBe('test-embed-key')
    expect(audits).toContain('embeddings_config')
    expect(await embeddings.test()).toMatchObject({ ok: true, dimensions: 5 })
    // Re-saving the same endpoint does not need a second acknowledgement.
    await expect(embeddings.update({ ...base })).resolves.toMatchObject({ enabled: true })
    await expect(embeddings.update({ ...base, baseUrl: 'http://example.com/v1', acknowledgeEgress: true })).rejects.toThrow('HTTPS')
    expect(normalizeEmbeddingsBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  it('stores vectors and fuses keyword + semantic rankings (hybrid)', async () => {
    const server = await mockEmbeddingsServer()
    const store = memoryStore()
    const embeddings = new EmbeddingsSettingsService(store, cipher)
    await embeddings.update({ enabled: true, preset: 'custom', baseUrl: server.url, model: 'mock-embed', apiKey: 'test-embed-key', acknowledgeEgress: true })
    const egress: Array<{ purpose: string; items: number }> = []
    const root = await tempDir('deskforge-kb-hybrid-')
    const dataDir = await tempDir('deskforge-kb-hybrid-data-')
    await writeFile(join(root, 'payments.md'), '# Billing\n\nInvoices are generated nightly by the billing job.')
    await writeFile(join(root, 'release.md'), '# 上线流程\n\n先灰度，再全量发布。')
    await writeFile(join(root, 'misc.md'), '# Misc\n\nUnrelated notes about the office plants.')
    const service = new KnowledgeIndexService({
      directory: dataDir,
      resolveWorkspace: (id) => ({ id, name: 'Hybrid', path: root }),
      embedder: () => embeddings.embedder(),
      embeddingsEnabled: () => embeddings.enabled(),
      onEgress: (event) => egress.push(event),
    })
    cleanups.push(() => service.close())
    const status = await service.build('ws-h')
    expect(status.embeddings).toMatchObject({ enabled: true, embeddedChunks: 3 })
    expect(status.embeddings.model).toContain('mock-embed')
    expect(server.requests[0]!.body).toMatchObject({ model: 'mock-embed', encoding_format: 'float' })
    expect(egress).toEqual([expect.objectContaining({ purpose: 'index', items: 3 })])

    // "deploy" has no keyword hit in release.md (Chinese text) but is semantically close.
    const semantic = await service.search('ws-h', 'deploy')
    expect(semantic.mode).toBe('hybrid')
    expect(semantic.results[0]).toMatchObject({ path: 'release.md', matchedBy: 'semantic' })
    // "billing" matches both keyword and vector → hybrid, ranked first.
    const hybrid = await service.search('ws-h', 'billing')
    expect(hybrid.results[0]).toMatchObject({ path: 'payments.md', matchedBy: 'hybrid' })
    expect(hybrid.results.every((hit) => hit.path !== 'misc.md')).toBe(true)
    expect(egress.filter((event) => event.purpose === 'query')).toHaveLength(2)

    // Incremental rebuild does not re-send unchanged chunks.
    const before = server.requests.length
    await service.build('ws-h')
    expect(server.requests.length).toBe(before)

    // Endpoint failure: keyword index still works and the error is reported without the key.
    await embeddings.update({ enabled: true, preset: 'custom', baseUrl: server.url, model: 'mock-embed', apiKey: 'wrong-key' })
    const degraded = await service.search('ws-h', 'billing')
    expect(degraded.mode).toBe('keyword')
    expect(degraded.results[0]!.path).toBe('payments.md')
    expect(degraded.note).toContain('回退')
    expect(degraded.note).not.toContain('wrong-key')

    // Disabling stops all traffic immediately.
    await embeddings.update({ enabled: false, preset: 'custom', baseUrl: server.url, model: 'mock-embed' })
    const count = server.requests.length
    expect((await service.search('ws-h', 'billing')).mode).toBe('keyword')
    expect(server.requests.length).toBe(count)
  })
})
