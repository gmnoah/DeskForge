import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'

import { callMcpTool, closeAllMcp, listMcpTools, sanitizedEnvironment, shouldFallbackToSse } from './mcp-client'

function mockServer(): Server {
  const server = new Server({ name: 'http-mock', version: '2.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'search', description: '检索', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: `found:${String(request.params.arguments?.q)}` }] }))
  return server
}

type Mode = 'streamable' | 'legacy-sse'

async function startHttp(mode: Mode, seen: Array<Record<string, string | string[] | undefined>>): Promise<{ url: string; close: () => Promise<void> }> {
  const sse = new Map<string, SSEServerTransport>()
  const http: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, 'x-api-key': req.headers['x-api-key'], 'x-team': req.headers['x-team'] })
    if (req.headers.authorization !== 'Bearer tok' || req.headers['x-api-key'] !== 'k') { res.writeHead(401).end(); return }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (mode === 'streamable' && url.pathname === '/mcp') {
      // Stateless mode: no session id generator.
      const transport = new StreamableHTTPServerTransport({} as ConstructorParameters<typeof StreamableHTTPServerTransport>[0])
      await mockServer().connect(transport as unknown as Parameters<Server['connect']>[0])
      await transport.handleRequest(req, res)
      return
    }
    if (mode === 'legacy-sse' && url.pathname === '/mcp' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res)
      sse.set(transport.sessionId, transport)
      await mockServer().connect(transport)
      return
    }
    if (mode === 'legacy-sse' && url.pathname === '/messages' && req.method === 'POST') {
      const transport = sse.get(url.searchParams.get('sessionId') ?? '')
      if (!transport) { res.writeHead(404).end(); return }
      await transport.handlePostMessage(req, res)
      return
    }
    res.writeHead(mode === 'legacy-sse' ? 405 : 404).end()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()) }),
  }
}

const httpServer = (id: string, url: string, sseFallback = true) => ({
  id,
  transport: 'streamable_http',
  config: { type: 'streamable_http', url, auth: 'bearer', headers: { 'x-team': 'office' }, secretHeaderKeys: ['x-api-key'], sseFallback },
  secrets: { bearer: 'tok', headers: { 'x-api-key': 'k' } },
})

describe('MCP HTTP client', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    await closeAllMcp()
    while (closers.length) await closers.pop()!()
  })

  it('connects over Streamable HTTP with plain and encrypted headers', async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = []
    const http = await startHttp('streamable', seen); closers.push(http.close)
    const listed = await listMcpTools(httpServer('http-streamable', http.url))
    expect(listed).toMatchObject({ connectedVia: 'streamable_http', tools: [{ name: 'search' }] })
    expect(await callMcpTool(httpServer('http-streamable', http.url), 'search', { q: '周报' })).toMatchObject({ content: [{ type: 'text', text: 'found:周报' }] })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((request) => request.authorization === 'Bearer tok' && request['x-api-key'] === 'k' && request['x-team'] === 'office')).toBe(true)
  }, 20_000)

  it('falls back to legacy SSE when the server rejects Streamable HTTP, keeping headers', async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = []
    const http = await startHttp('legacy-sse', seen); closers.push(http.close)
    const listed = await listMcpTools(httpServer('http-sse', http.url))
    expect(listed).toMatchObject({ connectedVia: 'sse', tools: [{ name: 'search' }] })
    expect(seen.some((request) => request.method === 'GET' && request.path === '/mcp')).toBe(true)
    expect(seen.filter((request) => String(request.path).startsWith('/messages')).every((request) => request.authorization === 'Bearer tok' && request['x-api-key'] === 'k')).toBe(true)
  }, 20_000)

  it('does not fall back when SSE compatibility is off', async () => {
    const http = await startHttp('legacy-sse', []); closers.push(http.close)
    await expect(listMcpTools(httpServer('http-no-sse', http.url, false))).rejects.toThrow()
  }, 20_000)

  it('classifies fallback-worthy errors and strips credentials from the child environment', () => {
    expect(shouldFallbackToSse(Object.assign(new Error('x'), { code: 405 }))).toBe(true)
    expect(shouldFallbackToSse(Object.assign(new Error('x'), { code: 404 }))).toBe(true)
    expect(shouldFallbackToSse(Object.assign(new Error('x'), { code: 401 }))).toBe(false)
    expect(shouldFallbackToSse(new Error('Error POSTing to endpoint (HTTP 403): Forbidden'))).toBe(false)
    expect(shouldFallbackToSse(new Error('fetch failed: ECONNREFUSED'))).toBe(false)
    expect(sanitizedEnvironment({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'x', GITHUB_TOKEN: 'y', DB_PASSWORD: 'z' })).toEqual({ PATH: '/bin', HOME: '/h' })
  })
})
