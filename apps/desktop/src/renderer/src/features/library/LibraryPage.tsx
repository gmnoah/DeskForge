import { t, useLocale } from '../../i18n'
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
  useLocale()
  return (
    <section className="library-shell">
      <header className="library-toolbar titlebar-drag">
        <div><span>{t('资料库')}</span><strong>{t('长期信息与可用能力')}</strong></div>
        <nav className="library-nav no-drag" aria-label={t('资料库分类')}>
          <button type="button" className={view === 'memory' ? 'is-active' : ''} onClick={() => onView('memory')}><Icon name="memory" size={16} />{t('记忆')}</button>
          <button type="button" className={view === 'mcp' ? 'is-active' : ''} onClick={() => onView('mcp')}><Icon name="plug" size={16} />{t('连接')}</button>
          <button type="button" className={view === 'skills' ? 'is-active' : ''} onClick={() => onView('skills')}><Icon name="skill" size={16} />{t('技能')}</button>
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
  useLocale()
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
    const result = await perform(() => bridge.proposeMemory(input), t('已创建记忆候选'))
    if (result !== undefined) { setContent(''); setOpen(false) }
  }
  return (
    <main className="management-page">
      <PageHeader title={t('记忆')} description={t('只有经过你确认的信息才会在相关工作中重新出现。')} action={<button className="button primary" type="button" onClick={() => setOpen(true)}><Icon name="plus" />{t('添加记忆')}</button>} />
      <div className="segmented-filter">
        {([
          ['all', t('全部 {0}', { 0: snapshot.memory.length })], ['proposed', t('待确认 {0}', { 0: counts.proposed })], ['confirmed', t('已确认 {0}', { 0: counts.confirmed })], ['disabled', t('已停用 {0}', { 0: counts.disabled })],
        ] as const).map(([id, label]) => <button type="button" key={id} className={filter === id ? 'is-active' : ''} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      <div className="memory-grid">
        {visible.map((memory) => <MemoryCard key={memory.id} memory={memory} perform={perform} />)}
      </div>
      {visible.length === 0 && <EmptyState icon="memory" title={filter === 'all' ? t('还没有记忆') : t('这里暂时为空')} description={t('DeskForge 可以在工作结束时提出候选；未经确认的内容不会影响以后。')} action={<button type="button" className="button secondary" onClick={() => setOpen(true)}>{t('添加第一条')}</button>} />}
      <Modal open={open} onClose={() => setOpen(false)} title={t('添加记忆候选')} description={t('先作为候选保存，确认后才会在相关工作中使用。')}>
        <SubmitForm onSubmit={() => void createMemory()} className="modal-form">
          <Field label={t('内容')}><textarea rows={5} value={content} onChange={(event) => setContent(event.target.value)} placeholder={t('例如：我偏好先看结论，再看实现细节。')} autoFocus /></Field>
          <div className="field-row">
            <Field label={t('类型')}><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="stable_fact">{t('稳定事实')}</option><option value="knowledge_background">{t('知识背景')}</option><option value="behavior_signal">{t('行为信号')}</option><option value="style_preference">{t('表达偏好')}</option><option value="continuation">{t('会话延续')}</option></select></Field>
            <Field label={t('作用范围')}><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="user">{t('所有工作区')}</option><option value="workspace" disabled={!workspaceId}>{t('当前工作区')}</option><option value="thread">{t('当前工作')}</option></select></Field>
          </div>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setOpen(false)}>{t('取消')}</button><button type="submit" className="button primary" disabled={!content.trim()}>{t('保存候选')}</button></div>
        </SubmitForm>
      </Modal>
    </main>
  )
}

function MemoryCard({ memory, perform }: { memory: MemoryItem; perform: Perform }) {
  useLocale()
  const labels: Record<string, string> = { stable_fact: t('稳定事实'), knowledge_background: t('知识背景'), behavior_signal: t('行为信号'), style_preference: t('表达偏好'), continuation: t('会话延续') }
  const scopeLabels: Record<string, string> = { user: t('所有工作区'), workspace: t('当前工作区'), thread: t('当前工作') }
  return (
    <article className={`memory-card memory-${memory.status}`}>
      <div className="memory-card-top"><span className={`memory-state ${memory.status}`}>{memory.status === 'proposed' ? t('待确认') : memory.status === 'confirmed' ? t('已确认') : t('已停用')}</span></div>
      <p>{memory.content}</p>
      <div className="memory-meta"><span><Icon name="layers" size={13} />{labels[memory.kind ?? ''] ?? memory.kind ?? t('记忆')}</span><span><Icon name="globe" size={13} />{scopeLabels[memory.scope] ?? memory.scope}</span>{memory.confidence !== undefined && <span>{Math.round(memory.confidence * 100)}{t('% 置信')}</span>}</div>
      {memory.source && <div className="memory-source">{t('来源：')}{memory.source}</div>}
      <div className="card-actions">
        {memory.status === 'proposed' && <><button className="button primary small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'confirm'), t('记忆已确认'))}>{t('确认使用')}</button><button className="button ghost small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'remove'), t('候选已删除'))}>{t('删除')}</button></>}
        {memory.status === 'confirmed' && <button className="button secondary small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'disable'), t('记忆已停用'))}>{t('停用')}</button>}
        {memory.status === 'disabled' && <><button className="button secondary small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'confirm'), t('记忆已恢复'))}>{t('恢复')}</button><button className="button ghost small danger-text" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'remove'), t('记忆已删除'))}>{t('永久删除')}</button></>}
      </div>
    </article>
  )
}

function McpPage({ snapshot, workspaceId, perform }: { snapshot: WorkbenchSnapshot; workspaceId: string | undefined; perform: Perform }) {
  useLocale()
  const [open, setOpen] = useState(false)
  return (
    <main className="management-page">
      <PageHeader title={t('连接')} description={t('通过 MCP 连接本地命令或远程服务。也可以在「设置 › MCP 连接」中管理。')} action={<button className="button primary" type="button" onClick={() => setOpen(true)}><Icon name="plus" />{t('添加 MCP Server')}</button>} />
      <div className="security-banner"><Icon name="shield" /><div><strong>{t('每次调用都需要你批准')}</strong><p>{t('列出工具是只读操作；调用 MCP 工具一律弹出审批，不会被会话规则自动放行。密钥加密保存在本机。')}</p></div></div>
      <div className="mcp-panel-wrap"><McpServersPanel servers={snapshot.mcpServers} workspaceId={workspaceId} perform={perform} editorOpen={open} onEditorOpenChange={setOpen} /></div>
    </main>
  )
}

function SkillsPage({ snapshot, perform }: { snapshot: WorkbenchSnapshot; perform: Perform }) {
  useLocale()
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
    const result = await perform(() => bridge.confirmSkillImport(preview.selectionId), preview.replaces ? t('已更新 {0}', { 0: preview.name }) : t('已安装 {0}', { 0: preview.name }))
    setBusy(false)
    if (result !== undefined) setPreview(undefined)
  }
  return (
    <main className="management-page">
      <PageHeader title={t('技能')} description={t('保存可复用的工作方法，需要时才加载；导入时只复制文件，脚本运行仍需批准。')} action={<div className="page-header-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setGitOpen(true)}><Icon name="globe" />{t('从 Git 导入')}</button><button type="button" className="button primary" disabled={busy} onClick={() => void startPreview(() => bridge.previewSkillFolder())}><Icon name="folder" />{t('从文件夹导入')}</button></div>} />
      <div className="page-tools"><div className="search-field"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索 Skills')} /></div><span>{snapshot.skills.filter((skill) => skill.enabled).length}{t('个已启用 · 共')}{snapshot.skills.length}{t('个')}</span></div>
      <div className="skill-list">
        {visible.map((skill) => <SkillRow key={skill.id} skill={skill} busy={busy} perform={perform} onUpdate={() => void startPreview(() => bridge.previewSkillUpdate(skill.id))} onRemove={() => setRemoving(skill)} />)}
      </div>
      {visible.length === 0 && <EmptyState icon="skill" title={query ? t('没有匹配的技能') : t('还没有技能')} description={t('选择包含 SKILL.md 的本地文件夹，或填写公开的 Git 仓库地址即可导入。')} />}
      <SkillGitImportModal open={gitOpen} busy={busy} onClose={() => setGitOpen(false)} onSubmit={(input) => void startPreview(() => bridge.previewSkillGit(input))} />
      <SkillImportPreviewModal preview={preview} busy={busy} onCancel={cancelPreview} onConfirm={() => void confirmPreview()} />
      <ConfirmDialog
        open={Boolean(removing)}
        danger
        title={t('移除 Skill？')}
        description={removing?.origin?.kind === 'bundled' ? t('将移除内置 Skill「{0}」，之后启动时不会自动重新安装。', { 0: removing.name }) : t('将从 DeskForge 中删除「{0}」的已安装副本，原始文件夹或仓库不受影响。', { 0: removing?.name ?? '' })}
        confirmLabel={t('移除')}
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => { const target = removing; setRemoving(undefined); if (target) void perform(() => bridge.removeSkill(target.id), t('Skill 已移除')) }}
      />
    </main>
  )
}

function SkillRow({ skill, busy, perform, onUpdate, onRemove }: { skill: SkillItem; busy: boolean; perform: Perform; onUpdate: () => void; onRemove: () => void }) {
  useLocale()
  const updatable = skill.origin?.kind === 'folder' || skill.origin?.kind === 'git'
  return (
    <article className={`skill-row ${skill.enabled ? '' : 'is-disabled'}`}>
      <div className="skill-symbol"><Icon name="skill" /></div>
      <div className="skill-main"><div><h3>{skill.name}</h3><span>v{skill.version ?? '—'}</span>{skill.origin?.kind === 'bundled' && <span className="skill-origin-pill">{t('内置')}</span>}{skill.origin?.kind === 'git' && <span className="skill-origin-pill">Git</span>}</div><p>{skill.description}</p><div className="permission-chips">{skill.permissions?.map((permission) => <span key={permission}>{permission}</span>)}{(!skill.permissions || skill.permissions.length === 0) && <span>{t('无额外权限声明')}</span>}</div><small title={skillOriginLabel(skill.origin, skill.source)}>{skill.origin ? skillOriginLabel(skill.origin) : skill.source ? shortPath(skill.source) : t('本地 Skill')}</small></div>
      <div className="skill-controls">
        {updatable && <button type="button" className="button ghost small" disabled={busy} onClick={onUpdate}><Icon name="refresh" size={13} />{t('更新')}</button>}
        <Toggle checked={skill.enabled} label={t('{0} {1}', { 0: skill.enabled ? t('停用') : t('启用'), 1: skill.name })} onChange={(enabled) => void perform(() => bridge.toggleSkill(skill.id, enabled), enabled ? t('Skill 已启用') : t('Skill 已停用'))} />
        <IconButton icon="trash" label={t('移除 {0}', { 0: skill.name })} onClick={onRemove} />
      </div>
    </article>
  )
}
