import process from 'node:process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { FingerprintedConnectionCache, prepareMcpConnection, type PreparedMcpConnection } from './runner-security'

export type McpConnectedVia = 'stdio' | 'streamable_http' | 'sse'

interface CachedMcpConnection {
  client: Client
  via: McpConnectedVia
  fingerprint: string
  stderr: () => string
  close(): Promise<void>
}

const connections = new FingerprintedConnectionCache<CachedMcpConnection>()
const CLIENT_INFO = { name: 'deskforge', version: '0.3.0' }
const STDERR_TAIL_BYTES = 4_096
const CONNECT_TIMEOUT_MS = 30_000

/** Parent environment minus anything that looks like a credential. */
export function sanitizedEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const blocked = /(api[_-]?key|token|secret|password|credential|authorization|cookie)/i
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && !blocked.test(entry[0])))
}

/**
 * Whether a failed Streamable HTTP handshake should be retried over legacy
 * HTTP+SSE. Per the MCP spec, old servers answer the initialize POST with
 * 4xx (typically 404/405); auth failures and network errors are not retried.
 */
export function shouldFallbackToSse(error: unknown): boolean {
  const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined
  if (code === 401 || code === 403) return false
  if (code !== undefined && code >= 400 && code < 500) return true
  const message = error instanceof Error ? error.message : String(error)
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) return false
  return /\b(404|405|406|415)\b|method not allowed|not found|unexpected content type/i.test(message)
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时（${CONNECT_TIMEOUT_MS / 1000} 秒）`)), CONNECT_TIMEOUT_MS) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function connectStdio(prepared: PreparedMcpConnection): Promise<CachedMcpConnection> {
  const stdio = prepared.stdio!
  const client = new Client(CLIENT_INFO)
  const transport = new StdioClientTransport({
    command: stdio.command,
    args: stdio.args,
    ...(stdio.cwd ? { cwd: stdio.cwd } : {}),
    env: { ...sanitizedEnvironment(), ...stdio.environment, ...stdio.secretEnvironment },
    stderr: 'pipe',
  })
  let stderrTail = ''
  transport.stderr?.on('data', (chunk: Buffer) => { stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_BYTES) })
  try {
    await withTimeout(client.connect(transport), '启动 MCP Server ')
  } catch (error) {
    await client.close().catch(() => {})
    const tail = stderrTail.trim()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(tail ? `${message}\nServer 输出：${tail.slice(-800)}` : message)
  }
  return { client, via: 'stdio', fingerprint: prepared.fingerprint, stderr: () => stderrTail, close: () => client.close() }
}

async function connectHttp(prepared: PreparedMcpConnection): Promise<CachedMcpConnection> {
  const http = prepared.http!
  const requestInit = { headers: http.headers }
  const client = new Client(CLIENT_INFO)
  try {
    // SDK 1.29's concrete transport types are stricter than its Transport
    // interface under exactOptionalPropertyTypes.
    await withTimeout(client.connect(new StreamableHTTPClientTransport(http.url, { requestInit }) as any), '连接 MCP Server ')
    return { client, via: 'streamable_http', fingerprint: prepared.fingerprint, stderr: () => '', close: () => client.close() }
  } catch (error) {
    await client.close().catch(() => {})
    if (!http.sseFallback || !shouldFallbackToSse(error)) throw error
  }
  const legacy = new Client(CLIENT_INFO)
  try {
    await withTimeout(legacy.connect(new SSEClientTransport(http.url, {
      requestInit,
      eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...http.headers } }) },
    }) as any), '连接 MCP Server（SSE）')
  } catch (error) {
    await legacy.close().catch(() => {})
    throw error
  }
  return { client: legacy, via: 'sse', fingerprint: prepared.fingerprint, stderr: () => '', close: () => legacy.close() }
}

export async function connectMcp(server: Record<string, any>): Promise<CachedMcpConnection> {
  const serverId = String(server.id)
  const prepared = prepareMcpConnection(server)
  return connections.getOrCreate(serverId, prepared.fingerprint, () => prepared.transport === 'stdio' ? connectStdio(prepared) : connectHttp(prepared))
}

/** Runs `action` on a cached connection, reconnecting once if the server went away. */
async function withConnection<T>(server: Record<string, any>, action: (connection: CachedMcpConnection) => Promise<T>): Promise<T> {
  const connection = await connectMcp(server)
  try {
    return await action(connection)
  } catch (error) {
    if (!/not connected|connection closed|EPIPE/i.test(error instanceof Error ? error.message : String(error))) throw error
    await disconnectMcp(String(server.id))
    return action(await connectMcp(server))
  }
}

export async function listMcpTools(server: Record<string, any>): Promise<{ serverId: string; tools: unknown[]; serverVersion: unknown; connectedVia: McpConnectedVia }> {
  return withConnection(server, (connection) => listWith(connection, String(server.id)))
}

async function listWith(connection: CachedMcpConnection, serverId: string): Promise<{ serverId: string; tools: unknown[]; serverVersion: unknown; connectedVia: McpConnectedVia }> {
  const tools: unknown[] = []
  let cursor: string | undefined
  // Follow pagination, bounded so a misbehaving server cannot loop forever.
  for (let page = 0; page < 20; page += 1) {
    const result = await connection.client.listTools(cursor ? { cursor } : undefined)
    tools.push(...result.tools)
    cursor = result.nextCursor
    if (!cursor || tools.length >= 2_000) break
  }
  return { serverId, tools, serverVersion: connection.client.getServerVersion(), connectedVia: connection.via }
}

export async function callMcpTool(server: Record<string, any>, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  return withConnection(server, (connection) => connection.client.callTool({ name: toolName, arguments: args }))
}

export function disconnectMcp(serverId: string): Promise<boolean> {
  return connections.disconnect(serverId)
}

export function closeAllMcp(): Promise<void> {
  return connections.closeAll()
}
