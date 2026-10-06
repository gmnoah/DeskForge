import { useState } from 'react'
import { bridge } from '../../bridge'
import { Icon } from '../../icons'
import type { JsonRecord, MemoryItem, SkillImportPreviewItem, SkillItem, WorkbenchSnapshot } from '../../types'
import { ConfirmDialog, EmptyState, Field, IconButton, Modal, PageHeader, SubmitForm, Toggle } from '../../ui'
import { McpServersPanel } from '../mcp/McpServersPanel'
import { SkillGitImportModal, SkillImportPreviewModal, skillOriginLabel } from './SkillImport'

type Perform = <T>(
  action: () => Promise<T>,
  successTitle?: string,
  options?: { refresh?: boolean; refreshRun?: boolean },
) => Promise<T | undefined>

export type LibraryView = 'memory' | 'mcp' | 'skills'

function shortPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

export function LibraryPage({ view, snapshot, workspaceId, perform, onView }: { view: LibraryView; snapshot: WorkbenchSnapshot; workspaceId: string | undefined; perform: Perform; onView: (view: LibraryView) => void }) {
  return (
    <section className="library-shell">
      <header className="library-toolbar titlebar-drag">
        <div><span>资料库</span><strong>长期信息与可用能力</strong></div>
        <nav className="library-nav no-drag" aria-label="资料库分类">
          <button type="button" className={view === 'memory' ? 'is-active' : ''} onClick={() => onView('memory')}><Icon name="memory" size={16} />记忆</button>
          <button type="button" className={view === 'mcp' ? 'is-active' : ''} onClick={() => onView('mcp')}><Icon name="plug" size={16} />连接</button>
          <button type="button" className={view === 'skills' ? 'is-active' : ''} onClick={() => onView('skills')}><Icon name="skill" size={16} />技能</button>
        </nav>
      </header>
      <div className="library-content">
        {view === 'memory' && <MemoryPage snapshot={snapshot} workspaceId={workspaceId} perform={perform} />}
        {view === 'mcp' && <McpPage snapshot={snapshot} workspaceId={workspaceId} perform={perform} />}
        {view === 'skills' && <SkillsPage snapshot={snapshot} perform={perform} />}
      </div>
    </section>
  )
}

function MemoryPage({ snapshot, workspaceId, perform }: { snapshot: WorkbenchSnapshot; workspaceId: string | undefined; perform: Perform }) {
  const [filter, setFilter] = useState<'all' | 'proposed' | 'confirmed' | 'disabled'>('all')
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [scope, setScope] = useState<'user' | 'workspace' | 'thread'>('user')
  const [kind, setKind] = useState('stable_fact')
  const visible = snapshot.memory.filter((item) => filter === 'all' || item.status === filter)
  const counts = {
    proposed: snapshot.memory.filter((item) => item.status === 'proposed').length,
    confirmed: snapshot.memory.filter((item) => item.status === 'confirmed').length,
    disabled: snapshot.memory.filter((item) => item.status === 'disabled').length,
  }
  const createMemory = async () => {
    if (!content.trim()) return
    const input: JsonRecord = {
      type: kind,
      scope,
      content: content.trim(),
      confidence: 1,
      source: { kind: 'user', reference: 'memory-manager' },
    }
    if (scope === 'workspace' && workspaceId) input.workspaceId = workspaceId
    const result = await perform(() => bridge.proposeMemory(input), '已创建记忆候选')
    if (result !== undefined) { setContent(''); setOpen(false) }
  }
  return (
    <main className="management-page">
      <PageHeader title="记忆" description="只有经过你确认的信息才会在相关工作中重新出现。" action={<button className="button primary" type="button" onClick={() => setOpen(true)}><Icon name="plus" />添加记忆</button>} />
      <div className="segmented-filter">
        {([
          ['all', `全部 ${snapshot.memory.length}`], ['proposed', `待确认 ${counts.proposed}`], ['confirmed', `已确认 ${counts.confirmed}`], ['disabled', `已停用 ${counts.disabled}`],
        ] as const).map(([id, label]) => <button type="button" key={id} className={filter === id ? 'is-active' : ''} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      <div className="memory-grid">
        {visible.map((memory) => <MemoryCard key={memory.id} memory={memory} perform={perform} />)}
      </div>
      {visible.length === 0 && <EmptyState icon="memory" title={filter === 'all' ? '还没有记忆' : '这里暂时为空'} description="DeskForge 可以在工作结束时提出候选；未经确认的内容不会影响以后。" action={<button type="button" className="button secondary" onClick={() => setOpen(true)}>添加第一条</button>} />}
      <Modal open={open} onClose={() => setOpen(false)} title="添加记忆候选" description="先作为候选保存，确认后才会在相关工作中使用。">
        <SubmitForm onSubmit={() => void createMemory()} className="modal-form">
          <Field label="内容"><textarea rows={5} value={content} onChange={(event) => setContent(event.target.value)} placeholder="例如：我偏好先看结论，再看实现细节。" autoFocus /></Field>
          <div className="field-row">
            <Field label="类型"><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="stable_fact">稳定事实</option><option value="knowledge_background">知识背景</option><option value="behavior_signal">行为信号</option><option value="style_preference">表达偏好</option><option value="continuation">会话延续</option></select></Field>
            <Field label="作用范围"><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="user">所有工作区</option><option value="workspace" disabled={!workspaceId}>当前工作区</option><option value="thread">当前工作</option></select></Field>
          </div>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setOpen(false)}>取消</button><button type="submit" className="button primary" disabled={!content.trim()}>保存候选</button></div>
        </SubmitForm>
      </Modal>
    </main>
  )
}

function MemoryCard({ memory, perform }: { memory: MemoryItem; perform: Perform }) {
  const labels: Record<string, string> = { stable_fact: '稳定事实', knowledge_background: '知识背景', behavior_signal: '行为信号', style_preference: '表达偏好', continuation: '会话延续' }
  const scopeLabels: Record<string, string> = { user: '所有工作区', workspace: '当前工作区', thread: '当前工作' }
  return (
    <article className={`memory-card memory-${memory.status}`}>
      <div className="memory-card-top"><span className={`memory-state ${memory.status}`}>{memory.status === 'proposed' ? '待确认' : memory.status === 'confirmed' ? '已确认' : '已停用'}</span></div>
      <p>{memory.content}</p>
      <div className="memory-meta"><span><Icon name="layers" size={13} />{labels[memory.kind ?? ''] ?? memory.kind ?? '记忆'}</span><span><Icon name="globe" size={13} />{scopeLabels[memory.scope] ?? memory.scope}</span>{memory.confidence !== undefined && <span>{Math.round(memory.confidence * 100)}% 置信</span>}</div>
      {memory.source && <div className="memory-source">来源：{memory.source}</div>}
      <div className="card-actions">
        {memory.status === 'proposed' && <><button className="button primary small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'confirm'), '记忆已确认')}>确认使用</button><button className="button ghost small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'remove'), '候选已删除')}>删除</button></>}
        {memory.status === 'confirmed' && <button className="button secondary small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'disable'), '记忆已停用')}>停用</button>}
        {memory.status === 'disabled' && <><button className="button secondary small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'confirm'), '记忆已恢复')}>恢复</button><button className="button ghost small danger-text" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'remove'), '记忆已删除')}>永久删除</button></>}
      </div>
    </article>
  )
}

function McpPage({ snapshot, workspaceId, perform }: { snapshot: WorkbenchSnapshot; workspaceId: string | undefined; perform: Perform }) {
  const [open, setOpen] = useState(false)
  return (
    <main className="management-page">
      <PageHeader title="连接" description="通过 MCP 连接本地命令或远程服务。也可以在「设置 › MCP 连接」中管理。" action={<button className="button primary" type="button" onClick={() => setOpen(true)}><Icon name="plus" />添加 MCP Server</button>} />
      <div className="security-banner"><Icon name="shield" /><div><strong>每次调用都需要你批准</strong><p>列出工具是只读操作；调用 MCP 工具一律弹出审批，不会被会话规则自动放行。密钥加密保存在本机。</p></div></div>
      <div className="mcp-panel-wrap"><McpServersPanel servers={snapshot.mcpServers} workspaceId={workspaceId} perform={perform} editorOpen={open} onEditorOpenChange={setOpen} /></div>
    </main>
  )
}

function SkillsPage({ snapshot, perform }: { snapshot: WorkbenchSnapshot; perform: Perform }) {
  const [query, setQuery] = useState('')
  const [gitOpen, setGitOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<SkillImportPreviewItem | undefined>()
  const [removing, setRemoving] = useState<SkillItem | undefined>()
  const visible = snapshot.skills.filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))
  const startPreview = async (action: () => Promise<SkillImportPreviewItem | undefined>) => {
    setBusy(true)
    const result = await perform(action, undefined, { refresh: false })
    setBusy(false)
    if (result) { setGitOpen(false); setPreview(result) }
  }
  const cancelPreview = () => {
    const current = preview
    setPreview(undefined)
    if (current) void bridge.cancelSkillImport(current.selectionId).catch(() => undefined)
  }
  const confirmPreview = async () => {
    if (!preview) return
    setBusy(true)
    const result = await perform(() => bridge.confirmSkillImport(preview.selectionId), preview.replaces ? `已更新 ${preview.name}` : `已安装 ${preview.name}`)
    setBusy(false)
    if (result !== undefined) setPreview(undefined)
  }
  return (
    <main className="management-page">
      <PageHeader title="技能" description="保存可复用的工作方法，需要时才加载；导入时只复制文件，脚本运行仍需批准。" action={<div className="page-header-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setGitOpen(true)}><Icon name="globe" />从 Git 导入</button><button type="button" className="button primary" disabled={busy} onClick={() => void startPreview(() => bridge.previewSkillFolder())}><Icon name="folder" />从文件夹导入</button></div>} />
      <div className="page-tools"><div className="search-field"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skills" /></div><span>{snapshot.skills.filter((skill) => skill.enabled).length} 个已启用 · 共 {snapshot.skills.length} 个</span></div>
      <div className="skill-list">
        {visible.map((skill) => <SkillRow key={skill.id} skill={skill} busy={busy} perform={perform} onUpdate={() => void startPreview(() => bridge.previewSkillUpdate(skill.id))} onRemove={() => setRemoving(skill)} />)}
      </div>
      {visible.length === 0 && <EmptyState icon="skill" title={query ? '没有匹配的技能' : '还没有技能'} description="选择包含 SKILL.md 的本地文件夹，或填写公开的 Git 仓库地址即可导入。" />}
      <SkillGitImportModal open={gitOpen} busy={busy} onClose={() => setGitOpen(false)} onSubmit={(input) => void startPreview(() => bridge.previewSkillGit(input))} />
      <SkillImportPreviewModal preview={preview} busy={busy} onCancel={cancelPreview} onConfirm={() => void confirmPreview()} />
      <ConfirmDialog
        open={Boolean(removing)}
        danger
        title="移除 Skill？"
        description={removing?.origin?.kind === 'bundled' ? `将移除内置 Skill「${removing.name}」，之后启动时不会自动重新安装。` : `将从 DeskForge 中删除「${removing?.name ?? ''}」的已安装副本，原始文件夹或仓库不受影响。`}
        confirmLabel="移除"
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => { const target = removing; setRemoving(undefined); if (target) void perform(() => bridge.removeSkill(target.id), 'Skill 已移除') }}
      />
    </main>
  )
}

function SkillRow({ skill, busy, perform, onUpdate, onRemove }: { skill: SkillItem; busy: boolean; perform: Perform; onUpdate: () => void; onRemove: () => void }) {
  const updatable = skill.origin?.kind === 'folder' || skill.origin?.kind === 'git'
  return (
    <article className={`skill-row ${skill.enabled ? '' : 'is-disabled'}`}>
      <div className="skill-symbol"><Icon name="skill" /></div>
      <div className="skill-main"><div><h3>{skill.name}</h3><span>v{skill.version ?? '—'}</span>{skill.origin?.kind === 'bundled' && <span className="skill-origin-pill">内置</span>}{skill.origin?.kind === 'git' && <span className="skill-origin-pill">Git</span>}</div><p>{skill.description}</p><div className="permission-chips">{skill.permissions?.map((permission) => <span key={permission}>{permission}</span>)}{(!skill.permissions || skill.permissions.length === 0) && <span>无额外权限声明</span>}</div><small title={skillOriginLabel(skill.origin, skill.source)}>{skill.origin ? skillOriginLabel(skill.origin) : skill.source ? shortPath(skill.source) : '本地 Skill'}</small></div>
      <div className="skill-controls">
        {updatable && <button type="button" className="button ghost small" disabled={busy} onClick={onUpdate}><Icon name="refresh" size={13} />更新</button>}
        <Toggle checked={skill.enabled} label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`} onChange={(enabled) => void perform(() => bridge.toggleSkill(skill.id, enabled), enabled ? 'Skill 已启用' : 'Skill 已停用')} />
        <IconButton icon="trash" label={`移除 ${skill.name}`} onClick={onRemove} />
      </div>
    </article>
  )
}
