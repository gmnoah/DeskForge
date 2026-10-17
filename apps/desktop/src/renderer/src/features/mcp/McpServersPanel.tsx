import { t, useLocale } from '../../i18n'
import { useState } from 'react'
import { bridge } from '../../bridge'
import { Icon } from '../../icons'
import type { McpServerItem, McpTestResult, McpToolItem } from '../../types'
import { ConfirmDialog, EmptyState, Field, IconButton, Modal, Spinner, SubmitForm, Toggle } from '../../ui'
import { buildMcpInput, connectedViaLabel, CWD_MODE_LABELS, emptyMcpForm, mcpFormFromServer, mcpFormProblems, SECRET_HINT, type McpFormState, type McpKeyValueRow } from './mcp-form'

type Perform = <T>(
  action: () => Promise<T>,
  successTitle?: string,
  options?: { refresh?: boolean; refreshRun?: boolean },
) => Promise<T | undefined>

/** MCP server management shared by Settings and the Library 连接 tab. */
export function McpServersPanel({ servers, workspaceId, perform, editorOpen, onEditorOpenChange }: {
  servers: McpServerItem[]
  workspaceId: string | undefined
  perform: Perform
  editorOpen?: boolean
  onEditorOpenChange?: (open: boolean) => void
}) {
  useLocale()
  const [editing, setEditing] = useState<McpFormState | undefined>()
  const [results, setResults] = useState<Record<string, McpTestResult>>({})
  const [testing, setTesting] = useState<string | undefined>()
  const [removing, setRemoving] = useState<McpServerItem | undefined>()
  const creating = Boolean(editorOpen) && !editing

  const closeEditor = () => { setEditing(undefined); onEditorOpenChange?.(false) }
  const test = async (server: McpServerItem) => {
    setTesting(server.id)
    const result = await perform(() => bridge.testMcp({ id: server.id, ...(workspaceId ? { workspaceId } : {}) }), undefined, { refresh: true })
    if (result) setResults((current) => ({ ...current, [server.id]: result }))
    setTesting(undefined)
  }

  return (
    <div className="mcp-panel">
      {servers.length === 0 && <EmptyState compact icon="plug" title={t('还没有 MCP Server')} description={t('可以添加本地 stdio 命令，或连接支持 Streamable HTTP 的远程服务。')} action={<button className="button secondary small" type="button" onClick={() => onEditorOpenChange?.(true)}><Icon name="plus" />{t('添加 MCP Server')}</button>} />}
      {servers.map((server) => (
        <McpServerCard
          key={server.id}
          server={server}
          result={results[server.id]}
          testing={testing === server.id}
          onTest={() => void test(server)}
          onEdit={() => setEditing(mcpFormFromServer(server))}
          onRemove={() => setRemoving(server)}
          perform={perform}
        />
      ))}
      {(creating || editing) && <McpServerEditor initial={editing ?? emptyMcpForm()} perform={perform} onClose={closeEditor} />}
      <ConfirmDialog
        open={Boolean(removing)}
        danger
        title={t('删除 MCP Server？')}
        description={t('将删除「{0}」的配置和加密保存的密钥，正在使用它的工作将无法继续调用其工具。', { 0: removing?.name ?? '' })}
        confirmLabel={t('删除')}
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => { const target = removing; setRemoving(undefined); if (target) void perform(() => bridge.removeMcp(target.id), t('MCP Server 已删除')) }}
      />
    </div>
  )
}

function healthLabel(server: McpServerItem): [string, string] {
  if (!server.enabled) return [t('已停用'), '']
  if (server.status === 'connected') return [t('已连接'), 'healthy']
  if (server.status === 'error') return [t('连接失败'), 'unhealthy']
  return [t('未测试'), '']
}

function McpServerCard({ server, result, testing, onTest, onEdit, onRemove, perform }: {
  server: McpServerItem
  result: McpTestResult | undefined
  testing: boolean
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
  perform: Perform
}) {
  useLocale()
  const [showTools, setShowTools] = useState(false)
  const [label, tone] = healthLabel(server)
  const tools = server.tools ?? []
  const enabledTools = tools.filter((tool) => tool.enabled).length
  const endpoint = server.transport === 'stdio' ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') : server.url
  return (
    <article className={`mcp-server-card ${server.enabled ? '' : 'is-disabled'}`}>
      <div className="mcp-server-head">
        <div className="connection-logo"><Icon name={server.transport === 'stdio' ? 'terminal' : 'globe'} /></div>
        <div className="mcp-server-title">
          <strong>{server.name}</strong>
          <small>{server.transport === 'stdio' ? `stdio · ${CWD_MODE_LABELS[server.cwdMode ?? 'isolated']}` : t('Streamable HTTP{0}', { 0: server.sseFallback ? t(' · 允许 SSE 兼容') : '' })}{server.toolNamespace ? ` · ${server.toolNamespace}` : ''}</small>
        </div>
        <span className={`health-pill ${tone}`}><i />{label}</span>
        <Toggle checked={server.enabled} label={t('{0} {1}', { 0: server.enabled ? t('停用') : t('启用'), 1: server.name })} onChange={(enabled) => void perform(() => bridge.setMcpEnabled(server.id, enabled), enabled ? t('MCP Server 已启用') : t('MCP Server 已停用'))} />
      </div>
      <code className="mcp-endpoint">{endpoint || t('未配置端点')}</code>
      <div className="mcp-server-meta">
        <span>{t('工具')}<strong>{tools.length ? `${enabledTools}/${tools.length}` : server.toolCount ?? '—'}</strong></span>
        <span>{t('连接方式')}<strong>{connectedViaLabel(server.connectedVia)}</strong></span>
        {server.serverVersion && <span>{t('版本')}<strong>{server.serverVersion}</strong></span>}
        {(server.envKeys?.length || server.secretHeaderKeys?.length || server.auth === 'bearer') ? <span><Icon name="lock" size={12} />{t('加密保存：')}{[...(server.envKeys ?? []), ...(server.secretHeaderKeys ?? []), ...(server.auth === 'bearer' ? ['Bearer Token'] : [])].join('、')}</span> : null}
      </div>
      {server.lastError && server.status === 'error' && !result && <div className="inline-notice error"><Icon name="warning" /><span>{server.lastError}</span></div>}
      {result && <McpTestNotice result={result} />}
      <div className="card-actions">
        <button className="button secondary small" type="button" disabled={testing || !server.enabled} onClick={onTest}>{testing ? <Spinner size={13} /> : <Icon name="activity" size={14} />}{t('测试连接')}</button>
        {server.auth === 'oauth' && <button className="button secondary small" type="button" onClick={() => void perform(() => bridge.authorizeMcp(server.id), t('已在浏览器打开 OAuth 授权'))}><Icon name="key" size={14} />{server.secretConfigured ? t('重新授权') : t('授权')}</button>}
        <button className="button ghost small" type="button" disabled={!tools.length} onClick={() => setShowTools((value) => !value)}><Icon name="layers" size={14} />{showTools ? t('收起工具') : t('工具列表')}</button>
        <span className="mcp-card-spacer" />
        <IconButton icon="edit" label={t('编辑 {0}', { 0: server.name })} onClick={onEdit} />
        <IconButton icon="trash" label={t('删除 {0}', { 0: server.name })} onClick={onRemove} />
      </div>
      {showTools && tools.length > 0 && (
        <ul className="mcp-tool-list" aria-label={t('{0} 的工具', { 0: server.name })}>
          {tools.map((tool) => <McpToolRow key={tool.name} tool={tool} onToggle={(enabled) => void perform(() => bridge.setMcpToolEnabled(server.id, tool.name, enabled), enabled ? t('已启用 {0}', { 0: tool.name }) : t('已停用 {0}', { 0: tool.name }))} />)}
        </ul>
      )}
    </article>
  )
}

function McpToolRow({ tool, onToggle }: { tool: McpToolItem; onToggle: (enabled: boolean) => void }) {
  useLocale()
  return (
    <li className={tool.enabled ? '' : 'is-disabled'}>
      <div>
        <strong>{tool.title ?? tool.name}</strong>
        {tool.title && <code>{tool.name}</code>}
        {tool.destructiveHint && <span className="mcp-tool-hint danger">{t('服务器标注：可能有破坏性')}</span>}
        {tool.readOnlyHint && <span className="mcp-tool-hint">{t('服务器标注：只读（仍需批准）')}</span>}
        {tool.description && <p>{tool.description}</p>}
      </div>
      <Toggle checked={tool.enabled} label={t('{0}工具 {1}', { 0: tool.enabled ? t('停用') : t('启用'), 1: tool.name })} onChange={onToggle} />
    </li>
  )
}

export function McpTestNotice({ result }: { result: McpTestResult }) {
  useLocale()
  if (!result.ok) return <div className="inline-notice error"><Icon name="warning" /><span>{t('连接失败：')}{result.error}</span></div>
  return (
    <div className="mcp-test-result">
      <div className="inline-notice success"><Icon name="check" /><span>{t('连接成功')}{result.latencyMs !== undefined ? `（${result.latencyMs} ms，${connectedViaLabel(result.connectedVia)}）` : ''}{t('，发现')}{result.tools.length}{t('个工具。')}</span></div>
      {result.tools.length > 0 && <div className="mcp-test-tools">{result.tools.map((tool) => <span key={tool.name} className={tool.enabled ? '' : 'is-disabled'} title={tool.description}>{tool.name}</span>)}</div>}
    </div>
  )
}

function KeyValueRows({ label, rows, onChange, keyPlaceholder, valuePlaceholder }: {
  label: string
  rows: McpKeyValueRow[]
  onChange: (rows: McpKeyValueRow[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  useLocale()
  const update = (index: number, patch: Partial<McpKeyValueRow>) => onChange(rows.map((row, current) => {
    if (current !== index) return row
    const next = { ...row, ...patch }
    // Typing a credential-looking name ticks 「加密保存」 automatically.
    if (patch.key !== undefined && !row.secret && SECRET_HINT.test(patch.key)) next.secret = true
    if (patch.secret === false) next.stored = false
    return next
  }))
  return (
    <div className="kv-editor">
      <div className="kv-editor-head"><span className="field-label">{label}</span><button type="button" className="button ghost small" onClick={() => onChange([...rows, { key: '', value: '', secret: false }])}><Icon name="plus" size={13} />{t('添加')}</button></div>
      {rows.length === 0 && <p className="kv-empty">{t('未设置')}</p>}
      {rows.map((row, index) => (
        <div className="kv-row" key={index}>
          <input aria-label={t('{0}名称', { 0: label })} value={row.key} onChange={(event) => update(index, { key: event.target.value })} placeholder={keyPlaceholder} disabled={row.stored && row.secret} />
          <input aria-label={t('{0}值', { 0: label })} type={row.secret ? 'password' : 'text'} value={row.value} onChange={(event) => update(index, { value: event.target.value })} placeholder={row.secret && row.stored ? t('已加密保存，留空则保持不变') : valuePlaceholder} autoComplete="off" />
          <label className="kv-secret"><input type="checkbox" checked={row.secret} onChange={(event) => update(index, { secret: event.target.checked })} />{t('加密保存')}</label>
          <IconButton icon="trash" label={t('删除{0} {1}', { 0: label, 1: row.key })} onClick={() => onChange(rows.filter((_, current) => current !== index))} />
        </div>
      ))}
    </div>
  )
}

function McpServerEditor({ initial, perform, onClose }: { initial: McpFormState; perform: Perform; onClose: () => void }) {
  useLocale()
  const [form, setForm] = useState<McpFormState>(initial)
  const [submitted, setSubmitted] = useState(false)
  const set = <K extends keyof McpFormState>(key: K, value: McpFormState[K]) => setForm((current) => ({ ...current, [key]: value }))
  const problems = mcpFormProblems(form)
  const save = async () => {
    setSubmitted(true)
    if (problems.length) return
    const result = await perform(() => bridge.saveMcp(buildMcpInput(form)), form.id ? t('MCP Server 已更新') : t('MCP Server 已添加'))
    if (result !== undefined) {
      onClose()
      const id = result && typeof result === 'object' ? (result as { id?: unknown }).id : undefined
      if (!form.id && form.transport === 'http' && form.auth === 'oauth' && typeof id === 'string') await perform(() => bridge.authorizeMcp(id), t('已在浏览器打开 OAuth 授权'))
    }
  }
  const chooseCwd = async () => {
    const path = await perform(() => bridge.chooseMcpCwd(), undefined, { refresh: false })
    if (path) setForm((current) => ({ ...current, cwdMode: 'custom', cwd: path }))
  }
  return (
    <Modal open onClose={onClose} title={form.id ? t('编辑 {0}', { 0: initial.name }) : t('添加 MCP Server')} description={t('配置只保存在本机；勾选「加密保存」的值使用系统钥匙串加密，不会写入配置文件或日志。')} wide>
      <SubmitForm className="modal-form mcp-editor" onSubmit={() => void save()}>
        <div className="field-row">
          <Field label={t('名称')}><input value={form.name} onChange={(event) => set('name', event.target.value)} placeholder={t('例如 文件检索')} autoFocus /></Field>
          <Field label={t('工具命名空间')} hint={t('字母开头，可用数字、_、-')}><input value={form.namespace} onChange={(event) => set('namespace', event.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))} placeholder="files" /></Field>
        </div>
        {!form.id && (
          <Field label={t('传输方式')}><div className="radio-cards">
            <button type="button" className={form.transport === 'stdio' ? 'is-active' : ''} onClick={() => set('transport', 'stdio')}><Icon name="terminal" /><span><strong>stdio</strong><small>{t('在本机启动进程')}</small></span></button>
            <button type="button" className={form.transport === 'http' ? 'is-active' : ''} onClick={() => set('transport', 'http')}><Icon name="globe" /><span><strong>Streamable HTTP</strong><small>{t('连接远程 Server')}</small></span></button>
          </div></Field>
        )}
        {form.transport === 'stdio' ? (
          <>
            <div className="field-row">
              <Field label={t('启动命令')}><input value={form.command} onChange={(event) => set('command', event.target.value)} placeholder="npx" /></Field>
              <Field label={t('参数')} hint={t('按空格分隔，含空格的参数请加引号')}><input value={form.args} onChange={(event) => set('args', event.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ." /></Field>
            </div>
            <KeyValueRows label={t('环境变量')} rows={form.env} onChange={(rows) => set('env', rows)} keyPlaceholder="NAME" valuePlaceholder={t('值')} />
            <Field label={t('工作目录')} hint={form.cwdMode === 'isolated' ? t('每个 Server 一个独立的空目录，不接触你的文件。') : form.cwdMode === 'workspace' ? t('在当前任务的工作区中运行；没有工作区时无法启动。') : t('只能是通过「选择文件夹」指定的目录或已授权的工作区，不能是根目录或主目录。')}>
              <div className="mcp-cwd-row">
                <select value={form.cwdMode} onChange={(event) => set('cwdMode', event.target.value as McpFormState['cwdMode'])}>
                  {(Object.keys(CWD_MODE_LABELS) as Array<McpFormState['cwdMode']>).map((mode) => <option key={mode} value={mode}>{CWD_MODE_LABELS[mode]}</option>)}
                </select>
                {form.cwdMode === 'custom' && <><code>{form.cwd || t('尚未选择')}</code><button type="button" className="button secondary small" onClick={() => void chooseCwd()}><Icon name="folder" size={13} />{t('选择文件夹')}</button></>}
              </div>
            </Field>
            <div className="inline-notice"><Icon name="info" /><span>{t('stdio Server 以你的系统用户身份运行，并非沙箱；只添加你信任的命令。DeskForge 不会把应用自身的密钥传给它。')}</span></div>
          </>
        ) : (
          <>
            <Field label="Server URL" hint={t('必须是 HTTPS；本机调试可使用 http://localhost')}><input value={form.url} onChange={(event) => set('url', event.target.value)} placeholder="https://example.com/mcp" /></Field>
            <div className="field-row">
              <Field label={t('认证')}><select value={form.auth} onChange={(event) => set('auth', event.target.value as McpFormState['auth'])}><option value="none">{t('无认证')}</option><option value="bearer">Bearer Token</option><option value="headers">{t('自定义 Header')}</option><option value="oauth">OAuth</option></select></Field>
              {form.auth === 'bearer' && <Field label="Bearer Token"><input type="password" value={form.bearer} onChange={(event) => set('bearer', event.target.value)} placeholder={form.bearerStored ? t('已加密保存，留空则保持不变') : t('不会回显')} autoComplete="off" /></Field>}
            </div>
            {form.auth !== 'oauth' && <KeyValueRows label="Header" rows={form.headers} onChange={(rows) => set('headers', rows)} keyPlaceholder="X-Header-Name" valuePlaceholder={t('值')} />}
            <label className="mcp-checkbox"><input type="checkbox" checked={form.sseFallback} onChange={(event) => set('sseFallback', event.target.checked)} />{t('Streamable HTTP 不可用时，尝试旧版 SSE 传输')}</label>
          </>
        )}
        <div className="inline-notice"><Icon name="shield" /><span>{t('MCP 工具每次调用都需要你批准，不能被会话规则自动放行。')}</span></div>
        {submitted && problems.length > 0 && <div className="inline-notice error"><Icon name="warning" /><span>{problems.join('；')}</span></div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>{t('取消')}</button><button type="submit" className="button primary">{form.id ? t('保存修改') : t('添加')}</button></div>
      </SubmitForm>
    </Modal>
  )
}
