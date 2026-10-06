import type { JsonRecord, McpCwdMode, McpServerItem } from '../../types'

export interface McpKeyValueRow {
  key: string
  value: string
  secret: boolean
  /** A secret already stored in the system keychain; an empty value keeps it. */
  stored?: boolean
}

export interface McpFormState {
  id?: string
  name: string
  namespace: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command: string
  args: string
  env: McpKeyValueRow[]
  cwdMode: McpCwdMode
  cwd: string
  url: string
  auth: 'none' | 'bearer' | 'headers' | 'oauth'
  bearer: string
  bearerStored: boolean
  headers: McpKeyValueRow[]
  sseFallback: boolean
}

export const SECRET_HINT = /(token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|credential|cookie|authorization|session)/i

export function emptyMcpForm(): McpFormState {
  return { name: '', namespace: '', enabled: true, transport: 'stdio', command: '', args: '', env: [], cwdMode: 'isolated', cwd: '', url: '', auth: 'none', bearer: '', bearerStored: false, headers: [], sseFallback: true }
}

/** Splits a command-line style argument string, honouring single and double quotes. */
export function splitArgs(text: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (quote) {
      if (character === quote) quote = undefined
      else if (character === '\\' && quote === '"' && (text[index + 1] === '"' || text[index + 1] === '\\')) current += text[++index]
      else current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue }
    if (/\s/.test(character)) {
      if (started) { args.push(current); current = ''; started = false }
      continue
    }
    current += character
    started = true
  }
  if (quote) throw new Error('参数中的引号没有闭合')
  if (started) args.push(current)
  return args
}

export function joinArgs(args: string[]): string {
  return args.map((arg) => (arg === '' || /[\s"'\\]/.test(arg) ? `"${arg.replace(/(["\\])/g, '\\$1')}"` : arg)).join(' ')
}

export function mcpFormFromServer(server: McpServerItem): McpFormState {
  const form = emptyMcpForm()
  form.id = server.id
  form.name = server.name
  form.namespace = server.toolNamespace ?? ''
  form.enabled = server.enabled
  form.transport = server.transport
  if (server.transport === 'stdio') {
    form.command = server.command ?? ''
    form.args = joinArgs(server.args ?? [])
    form.env = [
      ...Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value, secret: false })),
      ...(server.envKeys ?? []).map((key) => ({ key, value: '', secret: true, stored: true })),
    ]
    form.cwdMode = server.cwdMode ?? 'isolated'
    form.cwd = server.cwd ?? ''
  } else {
    form.url = server.url ?? ''
    form.auth = server.auth ?? 'none'
    form.bearerStored = form.auth === 'bearer' && Boolean(server.secretConfigured)
    form.headers = [
      ...Object.entries(server.headers ?? {}).map(([key, value]) => ({ key, value, secret: false })),
      ...(server.secretHeaderKeys ?? []).map((key) => ({ key, value: '', secret: true, stored: Boolean(server.secretConfigured) })),
    ]
    form.sseFallback = server.sseFallback !== false
  }
  return form
}

/** Client-side checks; the main process validates again and owns the final rules. */
export function mcpFormProblems(form: McpFormState): string[] {
  const problems: string[] = []
  if (!form.name.trim()) problems.push('请填写名称')
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(form.namespace.trim())) problems.push('工具命名空间须以字母开头，只能包含字母、数字、_ 和 -')
  const rows = form.transport === 'stdio' ? form.env : form.headers
  const label = form.transport === 'stdio' ? '环境变量' : 'Header'
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (!key && !row.value) continue
    if (!key) { problems.push(`${label}名称不能为空`); continue }
    const normalized = form.transport === 'stdio' ? key : key.toLowerCase()
    if (seen.has(normalized)) problems.push(`${label} ${key} 重复`)
    seen.add(normalized)
    if (!row.secret && SECRET_HINT.test(key)) problems.push(`${label} ${key} 看起来是密钥，请勾选「加密保存」`)
    if (row.secret && !row.value && !row.stored) problems.push(`请填写加密${label} ${key} 的值`)
  }
  if (form.transport === 'stdio') {
    if (!form.command.trim()) problems.push('请填写启动命令')
    try { splitArgs(form.args) } catch (error) { problems.push(error instanceof Error ? error.message : String(error)) }
    if (form.cwdMode === 'custom' && !form.cwd.trim()) problems.push('请通过「选择文件夹」指定工作目录')
  } else {
    if (!form.url.trim()) problems.push('请填写 Server URL')
    if (form.auth === 'bearer' && !form.bearer && !form.bearerStored) problems.push('请填写 Bearer Token')
    if (form.auth === 'headers' && !form.headers.some((row) => row.secret && row.key.trim())) problems.push('「自定义 Header」认证需要至少一个加密 Header')
  }
  return [...new Set(problems)]
}

/** Builds the `mcp:upsert` payload: plain values in config, secret values only in `secrets`. */
export function buildMcpInput(form: McpFormState): JsonRecord {
  const rows = (form.transport === 'stdio' ? form.env : form.headers).filter((row) => row.key.trim())
  const plain = Object.fromEntries(rows.filter((row) => !row.secret).map((row) => [row.key.trim(), row.value]))
  const secretRows = rows.filter((row) => row.secret)
  const secretValues = Object.fromEntries(secretRows.map((row) => [row.key.trim(), row.value]))
  const input: JsonRecord = {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    enabled: form.enabled,
    toolNamespace: form.namespace.trim(),
  }
  if (form.transport === 'stdio') {
    input.transport = {
      type: 'stdio',
      command: form.command.trim(),
      args: splitArgs(form.args),
      env: plain,
      envKeys: secretRows.map((row) => row.key.trim()),
      cwdMode: form.cwdMode,
      ...(form.cwdMode === 'custom' ? { cwd: form.cwd.trim() } : {}),
    }
    if (secretRows.length) input.secrets = { env: secretValues }
  } else {
    input.transport = {
      type: 'streamable_http',
      url: form.url.trim(),
      auth: form.auth,
      headers: plain,
      secretHeaderKeys: secretRows.map((row) => row.key.trim()),
      sseFallback: form.sseFallback,
    }
    const secrets: JsonRecord = {}
    if (secretRows.length) secrets.headers = secretValues
    if (form.auth === 'bearer' && form.bearer) secrets.bearer = form.bearer
    if (Object.keys(secrets).length) input.secrets = secrets
  }
  return input
}

export function connectedViaLabel(value: McpServerItem['connectedVia']): string {
  return value === 'sse' ? 'SSE（兼容模式）' : value === 'streamable_http' ? 'Streamable HTTP' : value === 'stdio' ? 'stdio' : '—'
}

export const CWD_MODE_LABELS: Record<McpCwdMode, string> = {
  isolated: '独立目录（推荐）',
  workspace: '当前工作区',
  custom: '指定文件夹',
}
