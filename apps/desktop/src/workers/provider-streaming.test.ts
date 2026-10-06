import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai'
import { classifyModelError } from '@deskforge/core'
import { createRuntime, prepareRuntimeStreamOptions, resolveRuntimeThinkingLevel, runConnectionTest, type RuntimeProviderName } from './agent-host-runtime'

/**
 * Fixture-driven OpenAI-compatible endpoints. Each test queues the provider's
 * documented response shape and inspects the exact request pi-ai sends.
 */
interface Captured { path: string; auth: string | undefined; body: Record<string, any> }
type Responder = (req: IncomingMessage, res: ServerResponse, body: Record<string, any>) => void

let server: Server
let baseUrl = ''
const captured: Captured[] = []
const queue: Responder[] = []
const FAKE_KEY = 'sk-fixture-not-a-real-key-000000'

function sse(chunks: unknown[]): Responder {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.end('data: [DONE]\n\n')
  }
}

function status(code: number, body: string, contentType = 'application/json'): Responder {
  return (_req, res) => { res.writeHead(code, { 'content-type': contentType }); res.end(body) }
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
  choices: [{ index: 0, delta, finish_reason: finish, ...extra }],
})

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (part) => { raw += part })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, any> : {}
      captured.push({ path: req.url ?? '', auth: req.headers.authorization, body })
      const responder = queue.shift()
      if (responder) responder(req, res, body)
      else status(500, '{"error":{"message":"no fixture queued"}}')(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { captured.length = 0; queue.length = 0 })

const readTool = {
  name: 'read_file',
  description: 'Read a workspace file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
} as any

async function stream(provider: RuntimeProviderName, modelId: string, context: Context, options: { reasoning?: string; toolChoice?: unknown; url?: string } = {}) {
  const url = options.url ?? baseUrl
  const { models, model } = await createRuntime(provider, modelId, FAKE_KEY, url)
  const level = resolveRuntimeThinkingLevel(provider, modelId, options.reasoning as any, url)
  const adjustments: string[] = []
  const result = await models.completeSimple(model, context, prepareRuntimeStreamOptions(provider, modelId, {
    maxRetries: 0,
    timeoutMs: 5_000,
    ...(level !== 'off' ? { reasoning: level } : {}),
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
  } as any, 'run-1', { baseUrl: url, onAdjust: (items) => adjustments.push(...items) }))
  return { result, adjustments, request: captured.at(-1)! }
}

const userTurn = (text: string): Message => ({ role: 'user', content: text, timestamp: Date.now() })

describe('DeepSeek (thinking mode + tool calls)', () => {
  it('streams reasoning_content and tool calls, downgrades forced tool_choice and parses cache usage', async () => {
    queue.push(sse([
      chunk({ role: 'assistant', reasoning_content: '需要先读取' }),
      chunk({ reasoning_content: '文件。' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] }),
      chunk({}, 'tool_calls'),
      { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } } },
    ]))
    const { result, adjustments, request } = await stream('deepseek', 'deepseek-flash', { systemPrompt: 'sys', messages: [userTurn('读 README')], tools: [readTool] }, { reasoning: 'medium', toolChoice: 'required' })

    expect(request.path).toBe('/v1/chat/completions')
    expect(request.auth).toBe(`Bearer ${FAKE_KEY}`)
    expect(request.body).toMatchObject({ model: 'deepseek-flash', stream: true, stream_options: { include_usage: true }, thinking: { type: 'enabled' }, reasoning_effort: 'high', tool_choice: 'auto', max_tokens: 32_768 })
    expect(request.body).not.toHaveProperty('store')
    expect(adjustments).toContain('deepseek:tool_choice_downgraded')

    expect(result.stopReason).toBe('toolUse')
    expect(result.content.find((block) => block.type === 'thinking')).toMatchObject({ thinking: '需要先读取文件。' })
    expect(result.content.find((block) => block.type === 'toolCall')).toMatchObject({ id: 'call_1', name: 'read_file', arguments: { path: 'README.md' } })
    expect(result.usage).toMatchObject({ input: 20, cacheRead: 100, output: 30, reasoning: 12, totalTokens: 150 })
  })

  it('echoes reasoning_content for tool turns and adds the empty placeholder for older assistant turns', async () => {
    const thinkingTurn: AssistantMessage = {
      role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', stopReason: 'toolUse', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [
        { type: 'thinking', thinking: '需要先读取文件。', thinkingSignature: 'reasoning_content' },
        { type: 'toolCall', id: 'call_1', name: 'read_file', arguments: { path: 'README.md' } },
      ],
    }
    const plainTurn: AssistantMessage = { ...thinkingTurn, stopReason: 'stop', content: [{ type: 'text', text: '早先的回答' }] }
    queue.push(sse([chunk({ role: 'assistant', content: '完成' }), chunk({}, 'stop')]))
    const { result, request } = await stream('deepseek', 'deepseek-flash', {
      messages: [
        userTurn('早先的问题'), plainTurn,
        userTurn('读 README'), thinkingTurn,
        { role: 'toolResult', toolCallId: 'call_1', toolName: 'read_file', content: [{ type: 'text', text: '# DeskForge' }], isError: false, timestamp: Date.now() },
      ],
      tools: [readTool],
    }, { reasoning: 'high' })
    const assistants = request.body.messages.filter((message: any) => message.role === 'assistant')
    expect(assistants[0]).toMatchObject({ content: '早先的回答', reasoning_content: '' })
    expect(assistants[1]).toMatchObject({ reasoning_content: '需要先读取文件。', tool_calls: [{ id: 'call_1', type: 'function' }] })
    expect(result.content).toEqual([{ type: 'text', text: '完成' }])
  })

  it('sends thinking disabled when off and maps insufficient_system_resource to a retryable overload', async () => {
    queue.push(sse([chunk({ role: 'assistant', content: '部分' }), chunk({}, 'insufficient_system_resource')]))
    const { result, request } = await stream('deepseek', 'deepseek-flash', { messages: [userTurn('hi')] })
    expect(request.body.thinking).toEqual({ type: 'disabled' })
    expect(request.body).not.toHaveProperty('reasoning_effort')
    expect(result.stopReason).toBe('error')
    expect(classifyModelError(result.errorMessage, [], { provider: 'deepseek' })).toMatchObject({ code: 'MODEL_OVERLOADED', retryable: true })
  })
})

describe('Kimi (Moonshot)', () => {
  it('reads usage from choice.usage and strips fixed sampling params on kimi-k2.6', async () => {
    queue.push(sse([
      chunk({ role: 'assistant', reasoning_content: '想一想' }),
      chunk({ content: '你好' }),
      chunk({}, 'stop', { usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50, cached_tokens: 0 } }),
    ]))
    const { models, model } = await createRuntime('kimi', 'kimi-k2.6', FAKE_KEY, baseUrl)
    const adjustments: string[] = []
    const result = await models.completeSimple(model, { messages: [userTurn('hi')], tools: [readTool] }, prepareRuntimeStreamOptions('kimi', 'kimi-k2.6', {
      maxRetries: 0, temperature: 0.2, reasoning: 'medium', toolChoice: 'required',
    } as any, 'run-1', { baseUrl, onAdjust: (items) => adjustments.push(...items) }))
    const request = captured.at(-1)!
    expect(request.body).toMatchObject({ model: 'kimi-k2.6', thinking: { type: 'enabled' }, tool_choice: 'auto' })
    expect(request.body).not.toHaveProperty('temperature')
    expect(request.body).not.toHaveProperty('reasoning_effort')
    expect(adjustments).toEqual(expect.arrayContaining(['kimi:temperature_removed', 'kimi:tool_choice_required_unsupported']))
    expect(result.usage).toMatchObject({ input: 40, output: 10, totalTokens: 50 })
    expect(result.content.map((block) => block.type)).toEqual(['thinking', 'text'])
  })

  it('uses reasoning_effort (never thinking) for kimi-k3, mapping off to low', async () => {
    queue.push(sse([chunk({ role: 'assistant', content: 'OK' }), chunk({}, 'stop')]))
    const { request } = await stream('kimi', 'kimi-k3', { messages: [userTurn('hi')] })
    expect(request.body.reasoning_effort).toBe('low')
    expect(request.body).not.toHaveProperty('thinking')
  })

  it('never sends an explicit thinking object to kimi-k2.7-code', async () => {
    queue.push(sse([chunk({ role: 'assistant', content: 'OK' }), chunk({}, 'stop')]))
    const { request } = await stream('kimi', 'kimi-k2.7-code', { messages: [userTurn('hi')] }, { reasoning: 'high' })
    expect(request.body).not.toHaveProperty('thinking')
    expect(request.body).not.toHaveProperty('reasoning_effort')
    expect(request.body.prompt_cache_key).toBe('run-1')
  })
})

describe('DashScope compatible-mode (通义)', () => {
  it('sends enable_thinking, enables parallel tool calls and reads usage from the trailing empty-choices chunk', async () => {
    queue.push(sse([
      chunk({ role: 'assistant', content: '' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.md"}' } }] }),
      chunk({}, 'tool_calls'),
      { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'qwen-plus', choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } } },
    ]))
    const { result, request } = await stream('tongyi', 'qwen-plus', { messages: [userTurn('读两个文件')], tools: [readTool] }, { toolChoice: 'required' })
    expect(request.body).toMatchObject({ model: 'qwen-plus', enable_thinking: false, parallel_tool_calls: true, tool_choice: 'auto', stream_options: { include_usage: true } })
    expect(result.content.filter((block) => block.type === 'toolCall')).toHaveLength(2)
    expect(result.usage).toMatchObject({ input: 16, cacheRead: 64, output: 20, totalTokens: 100 })
  })

  it('enables thinking for hybrid Qwen3 models when requested', async () => {
    queue.push(sse([chunk({ role: 'assistant', reasoning_content: '思考' }), chunk({ content: '答' }), chunk({}, 'stop')]))
    const { result, request } = await stream('tongyi', 'qwen3.8-flash', { messages: [userTurn('hi')] }, { reasoning: 'medium' })
    expect(request.body.enable_thinking).toBe(true)
    expect(result.content.map((block) => block.type)).toEqual(['thinking', 'text'])
  })
})

describe('Custom OpenAI-compatible endpoints', () => {
  it('strips reasoning echo fields that strict servers reject', async () => {
    queue.push(sse([chunk({ role: 'assistant', content: 'OK' }), chunk({}, 'stop')]))
    const prior: AssistantMessage = {
      role: 'assistant', api: 'openai-completions', provider: 'custom', model: 'my-model', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: 'thinking', thinking: 'hidden', thinkingSignature: 'reasoning_content' }, { type: 'text', text: 'prev' }],
    }
    const { request, adjustments } = await stream('custom', 'my-model', { messages: [userTurn('a'), prior, userTurn('b')] })
    const assistant = request.body.messages.find((message: any) => message.role === 'assistant')
    expect(assistant).toEqual({ role: 'assistant', content: 'prev' })
    expect(adjustments).toContain('generic:reasoning_echo_stripped:1')
    expect(request.body).not.toHaveProperty('thinking')
    expect(request.body).not.toHaveProperty('enable_thinking')
  })
})

describe('connection test', () => {
  it('succeeds with a tiny non-thinking probe', async () => {
    queue.push(sse([chunk({ role: 'assistant', content: 'OK' }), chunk({}, 'stop')]))
    const outcome = await runConnectionTest({ provider: 'deepseek', modelId: 'deepseek-flash', baseUrl, apiKey: FAKE_KEY })
    expect(outcome).toEqual({ ok: true, model: 'deepseek-flash' })
    expect(captured[0]!.body).toMatchObject({ max_tokens: 16, thinking: { type: 'disabled' } })
    expect(captured[0]!.body).not.toHaveProperty('tools')
  })

  it('treats a length stop as success (thinking models may spend the whole probe budget)', async () => {
    queue.push(sse([chunk({ role: 'assistant', reasoning_content: '...' }), chunk({}, 'length')]))
    const outcome = await runConnectionTest({ provider: 'kimi', modelId: 'kimi-k2.7-code', baseUrl, apiKey: FAKE_KEY })
    expect(outcome.ok).toBe(true)
  })

  const failures: Array<[string, Responder, string, RuntimeProviderName, string]> = [
    ['401 invalid key', status(401, '{"error":{"message":"Authentication Fails, Your api key is invalid","type":"authentication_error"}}'), 'MODEL_AUTH_FAILED', 'deepseek', 'deepseek-flash'],
    ['404 HTML (wrong baseUrl)', status(404, '<!DOCTYPE html><html><body>Not Found</body></html>', 'text/html'), 'MODEL_ENDPOINT_NOT_FOUND', 'tongyi', 'qwen-plus'],
    ['404 unknown model', status(404, '{"error":{"message":"Not found the model moonshot-v1-auto or Permission denied","type":"resource_not_found_error"}}'), 'MODEL_NOT_FOUND', 'kimi', 'moonshot-v1-auto'],
    ['402 balance', status(402, '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}'), 'MODEL_QUOTA_EXHAUSTED', 'deepseek', 'deepseek-flash'],
    ['400 model not exist', status(400, '{"error":{"message":"Model Not Exist","type":"invalid_request_error"}}'), 'MODEL_NOT_FOUND', 'deepseek', 'deepseek-v9'],
  ]
  for (const [label, responder, code, provider, modelId] of failures) {
    it(`classifies ${label}`, async () => {
      queue.push(responder)
      const outcome = await runConnectionTest({ provider, modelId, baseUrl, apiKey: FAKE_KEY })
      expect(outcome.ok).toBe(false)
      expect(outcome.error).not.toContain(FAKE_KEY)
      expect(classifyModelError(outcome.error, [FAKE_KEY], { provider, modelId }).code).toBe(code)
    })
  }

  it('classifies connection refused and timeouts', async () => {
    const refused = await runConnectionTest({ provider: 'custom', modelId: 'm', baseUrl: 'http://127.0.0.1:9/v1', apiKey: FAKE_KEY })
    expect(classifyModelError(refused.error, [], { provider: 'custom' }).code).toBe('MODEL_NETWORK_UNREACHABLE')

    queue.push((_req, res) => { setTimeout(() => { if (!res.writableEnded) res.end() }, 2_000) })
    const slow = await runConnectionTest({ provider: 'custom', modelId: 'm', baseUrl, apiKey: FAKE_KEY, timeoutMs: 300 })
    expect(classifyModelError(slow.error, [], { provider: 'custom' }).code).toBe('MODEL_TIMEOUT')
  })
})
