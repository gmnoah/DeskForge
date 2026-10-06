import { useCallback, useEffect, useState } from 'react'
import { bridge } from '../../bridge'
import { Icon } from '../../icons'
import type { EmbeddingsView, KnowledgeSearchView, KnowledgeStatusItem, WorkbenchSnapshot } from '../../types'
import { ConfirmDialog, EmptyState, Field, IconButton, Spinner, SubmitForm, Toggle } from '../../ui'
import {
  applyPreset, draftFromView, draftToInput, EMBEDDING_PRESETS, endpointHost, KNOWLEDGE_STATE_LABEL, knowledgeSummary,
  lastRunSummary, limitReasonLabel, needsEgressAck, skippedSummary, type EmbeddingsDraft,
} from './knowledge-view'

type Perform = <T>(action: () => Promise<T>, successTitle?: string, options?: { refresh?: boolean; refreshRun?: boolean }) => Promise<T | undefined>

function formatTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

/** Per-workspace local knowledge index: status, incremental update, rebuild, clear and a quick search. */
export function KnowledgePanel({ snapshot, selectedWorkspaceId, perform }: { snapshot: WorkbenchSnapshot; selectedWorkspaceId: string | undefined; perform: Perform }) {
  const [statuses, setStatuses] = useState<KnowledgeStatusItem[]>()
  const [busy, setBusy] = useState<string>()
  const [clearTarget, setClearTarget] = useState<KnowledgeStatusItem>()
  const [query, setQuery] = useState('')
  const [searchWorkspace, setSearchWorkspace] = useState<string | undefined>(selectedWorkspaceId)
  const [result, setResult] = useState<KnowledgeSearchView>()
  const [searching, setSearching] = useState(false)
  const workspaceKey = snapshot.workspaces.map((workspace) => workspace.id).join(',')

  const load = useCallback(async () => {
    try { setStatuses(await bridge.knowledgeStatus()) } catch { setStatuses([]) }
  }, [])
  useEffect(() => { void load() }, [load, workspaceKey])
  useEffect(() => { setSearchWorkspace((current) => current ?? selectedWorkspaceId ?? snapshot.workspaces[0]?.id) }, [selectedWorkspaceId, snapshot.workspaces])

  const rebuild = async (status: KnowledgeStatusItem, mode: 'incremental' | 'full') => {
    setBusy(status.workspaceId)
    const next = await perform(() => bridge.rebuildKnowledge(status.workspaceId, mode), mode === 'full' ? '索引已重建' : '索引已更新', { refresh: false })
    if (next) setStatuses((items) => items?.map((item) => (item.workspaceId === next.workspaceId ? next : item)))
    setBusy(undefined)
  }

  const runSearch = async () => {
    if (!searchWorkspace || !query.trim()) return
    setSearching(true)
    const found = await perform(() => bridge.searchKnowledge(searchWorkspace, query.trim()), undefined, { refresh: false })
    setResult(found)
    setSearching(false)
  }

  if (!snapshot.workspaces.length) return <EmptyState compact icon="folder" title="还没有工作区" description="添加并授权工作区后即可建立本地知识索引。" />
  if (!statuses) return <div className="knowledge-loading"><Spinner /></div>
  return (
    <div className="knowledge-panel">
      <div className="knowledge-list">
        {statuses.map((status) => {
          const running = busy === status.workspaceId || status.state === 'indexing'
          const skipped = skippedSummary(status)
          const lastRun = lastRunSummary(status)
          return (
            <div key={status.workspaceId} className="knowledge-row">
              <span className="folder-symbol"><Icon name="search" /></span>
              <div className="knowledge-copy">
                <div className="knowledge-title"><strong>{status.workspaceName}</strong><span className={`knowledge-state state-${status.state}`}>{running ? '索引中…' : KNOWLEDGE_STATE_LABEL[status.state]}</span></div>
                <small>{knowledgeSummary(status)}{status.indexedAt ? ` · 更新于 ${formatTime(status.indexedAt)}` : ''}</small>
                {lastRun && <small>{lastRun}</small>}
                {skipped && <small>{skipped}</small>}
                {status.truncated && <small className="knowledge-warning"><Icon name="warning" size={12} />{limitReasonLabel(status.limitReason)}</small>}
                {status.error && <small className="knowledge-error"><Icon name="warning" size={12} />{status.error}</small>}
                {status.embeddings.error && <small className="knowledge-error"><Icon name="warning" size={12} />{status.embeddings.error}</small>}
              </div>
              <div className="knowledge-actions">
                {running ? <Spinner size={16} /> : <>
                  <button type="button" className="button secondary small" onClick={() => void rebuild(status, status.state === 'empty' ? 'full' : 'incremental')}><Icon name="refresh" />{status.state === 'empty' ? '建立索引' : '增量更新'}</button>
                  {status.state !== 'empty' && <IconButton icon="layers" label="完全重建索引" onClick={() => void rebuild(status, 'full')} />}
                  {status.state !== 'empty' && <IconButton icon="trash" label="清除索引" onClick={() => setClearTarget(status)} />}
                </>}
              </div>
            </div>
          )
        })}
      </div>
      <p className="knowledge-note"><Icon name="lock" size={13} />索引保存在本机应用数据目录，不写入工作区；遵守 .gitignore，跳过符号链接、二进制、超过 1 MB 的文本以及 .env、私钥等敏感文件。支持 Markdown、纯文本、常见代码与配置文件、.docx；暂不支持 PDF。</p>
      <SubmitForm className="knowledge-search" onSubmit={() => void runSearch()}>
        <select aria-label="检索的工作区" value={searchWorkspace ?? ''} onChange={(event) => setSearchWorkspace(event.target.value)}>
          {snapshot.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="试试检索：部署流程、周报、computeTotal…" aria-label="检索本地知识库" />
        <button type="submit" className="button secondary small" disabled={!query.trim() || searching}>{searching ? <Spinner size={14} /> : <Icon name="search" />}检索</button>
      </SubmitForm>
      {result && (
        <div className="knowledge-results" aria-live="polite">
          <div className="knowledge-results-head">{result.mode === 'hybrid' ? '混合排序（关键词 + 向量）' : '关键词排序'} · {result.results.length} 条</div>
          {result.note && <p className="knowledge-note">{result.note}</p>}
          {result.results.map((hit, index) => (
            <div key={`${hit.path}:${hit.startLine}:${index}`} className="knowledge-hit">
              <div><code>{hit.path}:{hit.startLine}-{hit.endLine}</code><span className={`knowledge-match match-${hit.matchedBy}`}>{hit.matchedBy === 'hybrid' ? '混合' : hit.matchedBy === 'semantic' ? '语义' : '关键词'}</span></div>
              <pre>{hit.snippet}</pre>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(clearTarget)}
        title="清除这个工作区的索引？"
        description="只删除 DeskForge 应用数据目录中的索引文件（含向量），不会改动工作区里的任何文件。之后可以随时重新建立。"
        confirmLabel="清除索引"
        danger
        onCancel={() => setClearTarget(undefined)}
        onConfirm={() => {
          const target = clearTarget
          setClearTarget(undefined)
          if (!target) return
          void perform(() => bridge.clearKnowledge(target.workspaceId), '索引已清除', { refresh: false }).then((next) => {
            if (next) setStatuses((items) => items?.map((item) => (item.workspaceId === next.workspaceId ? next : item)))
          })
        }}
      />
    </div>
  )
}

/** Optional OpenAI-compatible embeddings. Off by default; enabling requires an explicit data-egress confirmation. */
export function EmbeddingsPanel({ perform }: { perform: Perform }) {
  const [saved, setSaved] = useState<EmbeddingsView>()
  const [draft, setDraft] = useState<EmbeddingsDraft>()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string }>()

  useEffect(() => {
    bridge.getEmbeddings().then((view) => { setSaved(view); setDraft(draftFromView(view)) }).catch(() => undefined)
  }, [])

  if (!draft) return <div className="knowledge-loading"><Spinner /></div>
  const host = endpointHost(draft.baseUrl) || '所配置的接口'
  const update = (patch: Partial<EmbeddingsDraft>) => setDraft((current) => (current ? { ...current, ...patch } : current))
  const save = async (acknowledge: boolean) => {
    const view = await perform(() => bridge.setEmbeddings(draftToInput(draft, acknowledge)), draft.enabled ? '向量检索设置已保存' : '向量检索已关闭', { refresh: false })
    if (view) { setSaved(view); setDraft(draftFromView(view)) }
  }

  return (
    <div className="embeddings-panel">
      <div className="setting-row">
        <div><strong>启用向量检索</strong><span>默认关闭。关闭时知识库只使用本机关键词索引，任何内容都不会发出。</span></div>
        <div><Toggle checked={draft.enabled} label="启用向量检索" onChange={(checked) => update({ enabled: checked })} /></div>
      </div>
      <div className={`egress-callout ${draft.enabled ? 'is-active' : ''}`}>
        <Icon name="globe" size={15} />
        <p>启用后，建立或更新索引时，<strong>工作区文档片段（含文件路径）会发送到 {host}</strong> 生成向量；每次知识库检索（包括 Agent 调用 knowledge_search）的<strong>查询词</strong>也会发送。每次发送都会记入「隐私与记录」。API Key 使用系统安全存储加密，仅在主进程使用，不会提供给 Agent。</p>
      </div>
      <SubmitForm className="embeddings-form" onSubmit={() => { if (needsEgressAck(draft, saved)) setConfirmOpen(true); else void save(false) }}>
        <Field label="服务预设">
          <select value={draft.preset} onChange={(event) => setDraft(applyPreset(draft, event.target.value as EmbeddingsDraft['preset']))}>
            {EMBEDDING_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </Field>
        <Field label="接口地址" hint="OpenAI 兼容的 /embeddings 接口；必须是 HTTPS（本机回环地址除外）。"><input value={draft.baseUrl} onChange={(event) => update({ baseUrl: event.target.value, preset: 'custom' })} placeholder="https://…/v1" /></Field>
        <div className="embeddings-grid">
          <Field label="模型"><input value={draft.model} onChange={(event) => update({ model: event.target.value })} placeholder="text-embedding-v4" /></Field>
          <Field label="维度（可选）"><input inputMode="numeric" value={draft.dimensions} onChange={(event) => update({ dimensions: event.target.value.replace(/\D/g, '') })} placeholder="1024" /></Field>
        </div>
        <Field label="API Key" hint={saved?.hasKey ? '已安全保存；留空表示不修改。' : saved?.secureStorage === false ? '系统安全存储不可用，无法保存密钥。' : '保存后使用系统安全存储加密。'}>
          <input type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => update({ apiKey: event.target.value })} placeholder={saved?.hasKey ? '••••••••（已保存）' : 'sk-…'} />
        </Field>
        <div className="modal-actions">
          {saved?.hasKey && <button type="button" className="button ghost" onClick={() => void perform(() => bridge.setEmbeddings({ ...draftToInput({ ...draft, enabled: false, apiKey: '' }, false), clearKey: true }), '已删除向量接口密钥', { refresh: false }).then((view) => { if (view) { setSaved(view); setDraft(draftFromView(view)) } })}>删除密钥</button>}
          <button type="button" className="button secondary" disabled={testing || !saved?.hasKey} onClick={() => {
            setTesting(true)
            void bridge.testEmbeddings().then((test) => setTestResult(test.ok ? { ok: true, text: `连接成功：${test.dimensions ?? '?'} 维，${test.latencyMs} ms` } : { ok: false, text: test.error ?? '连接失败' })).catch((cause: unknown) => setTestResult({ ok: false, text: cause instanceof Error ? cause.message : '连接失败' })).finally(() => setTesting(false))
          }}>{testing ? <Spinner size={14} /> : <Icon name="activity" />}测试连接</button>
          <button type="submit" className="button primary">保存</button>
        </div>
        {testResult && <p className={`embeddings-test ${testResult.ok ? 'is-ok' : 'is-error'}`}><Icon name={testResult.ok ? 'check' : 'warning'} size={13} />{testResult.text}（测试只发送一句固定文本）</p>}
      </SubmitForm>
      <ConfirmDialog
        open={confirmOpen}
        title={`允许把文档片段发送到 ${host}？`}
        description={`启用向量检索后，DeskForge 会把已索引的工作区文档片段（含相对路径）以及检索词发送到 ${host} 生成向量，可能产生费用。请确认该服务符合你的数据合规要求。你可以随时关闭，关闭后不再发送任何内容。`}
        confirmLabel="确认并启用"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); void save(true) }}
      />
    </div>
  )
}
