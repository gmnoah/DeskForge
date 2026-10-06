import { useEffect, useState } from 'react'
import { bridge, resultId } from './bridge'
import { useResolvedTheme, useWorkbench } from './hooks'
import { BrandMark, Icon, type IconName } from './icons'
import { AutomationsPage } from './features/automations/AutomationsPage'
import { LibraryPage, type LibraryView } from './features/library/LibraryPage'
import { AuditPage } from './features/settings/AuditPage'
import { SettingsPage, SettingRow } from './features/settings/SettingsPage'
import { MODEL_PROVIDER_META } from './features/settings/model-meta'
import { connectionTestFailure, describeConnectionTest, type ConnectionTestView } from './features/settings/connection-test'
import { ConnectionTestNotice } from './features/settings/ConnectionTestNotice'
import { ShellSidebar } from './features/shell/ShellSidebar'
import { WelcomeComposer } from './features/shell/WelcomeComposer'
import { WorkTimeline } from './features/work/WorkTimeline'
import { ApprovalDiff } from './features/work/ApprovalDiff'
import { isUserVisibleArtifact, WorkInspector, type WorkInspectorTab } from './features/work/WorkInspector'
import type {
  ApprovalItem,
  ApprovalScopeChoice,
  JsonRecord,
  ModelProvider,
  RunAccessMode,
  RunDetailView,
  ViewKey,
  WorkbenchSnapshot,
  WorkspaceItem,
} from './types'
import {
  ConfirmDialog,
  Field,
  IconButton,
  Modal,
  Spinner,
  StatusBadge,
  SubmitForm,
  Toasts,
  Toggle,
} from './ui'

type Perform = <T>(
  action: () => Promise<T>,
  successTitle?: string,
  options?: { refresh?: boolean; refreshRun?: boolean },
) => Promise<T | undefined>

function formatDate(value?: string, includeDate = false) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', includeDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }).format(date)
}

function ApprovalCard({ approval, onRespond }: { approval: ApprovalItem; onRespond: (approval: ApprovalItem, decision: 'approve' | 'edit' | 'reject', scope?: ApprovalScopeChoice, editedArguments?: JsonRecord) => void }) {
  const [scope, setScope] = useState<ApprovalScopeChoice>('once')
  const [editing, setEditing] = useState(false)
  const [editedText, setEditedText] = useState(() => JSON.stringify(approval.arguments ?? {}, null, 2))
  const [editError, setEditError] = useState<string>()
  const canApproveForTask = approval.risk === 'reversible_write'
  const sessionOffer = approval.sessionRule?.eligible ? approval.sessionRule : undefined
  const scopeOptions = canApproveForTask || sessionOffer
  const effectiveScope: ApprovalScopeChoice = scope === 'session' && !sessionOffer ? 'once' : scope === 'run_tool' && !canApproveForTask ? 'once' : scope
  const actionLabel = approval.risk === 'irreversible' ? '允许高风险操作' : approval.risk === 'external_effect' ? '允许这次外部操作' : effectiveScope === 'session' ? '允许并记住' : '允许这一次'
  return (
    <section className={`approval-card risk-${approval.risk}`}>
      <div className="approval-icon"><Icon name={approval.risk === 'irreversible' ? 'warning' : 'shield'} /></div>
      <div className="approval-body">
        <div className="approval-heading">
          <div><span>需要你的确认</span><h3>{approval.title}</h3></div>
          <span className="risk-label">{approval.risk === 'reversible_write' ? '可以撤销' : approval.risk === 'external_effect' ? '会影响外部系统' : '可能无法撤销'}</span>
        </div>
        <p>{approval.summary || 'DeskForge 需要得到允许后才能继续。'}</p>
        {approval.diff && !editing && <ApprovalDiff diff={approval.diff} />}
        {approval.arguments && !editing && <details className="approval-details"><summary>查看操作参数</summary><pre>{JSON.stringify(approval.arguments, null, 2)}</pre></details>}
        {editing && <div className="approval-editor"><textarea aria-label="修改操作参数" className="mono" rows={6} value={editedText} onChange={(event) => { setEditedText(event.target.value); setEditError(undefined) }} />{editError && <span>{editError}</span>}</div>}
        <div className="approval-facts">
          <span><Icon name={approval.reversible ? 'check' : 'warning'} size={14} />{approval.reversible ? '可回滚' : '可能无法撤销'}</span>
          {approval.dataShared && <span><Icon name="globe" size={14} />将发送：{approval.dataShared}</span>}
          {!sessionOffer && approval.sessionRule?.reason && <span title={approval.sessionRule.reason}><Icon name="lock" size={14} />每次都需确认</span>}
        </div>
        {effectiveScope === 'session' && sessionOffer?.label && <p className="approval-session-hint"><Icon name="info" size={13} />本会话中，{sessionOffer.label}将自动允许，并照常写入审计日志；可在右侧「详细」或「隐私与记录」中撤销。</p>}
        <div className="approval-actions">
          <select aria-label="授权范围" value={effectiveScope} disabled={!scopeOptions} onChange={(event) => setScope(event.target.value as ApprovalScopeChoice)}>
            <option value="once">仅批准本次</option>
            {canApproveForTask && <option value="run_tool">本工作相同参数操作</option>}
            {sessionOffer && <option value="session">本会话总是允许此类操作</option>}
          </select>
          {editing ? <><button type="button" className="button secondary" onClick={() => setEditing(false)}>取消编辑</button><button type="button" className="button primary" onClick={() => { try { const value = JSON.parse(editedText) as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是 JSON 对象'); onRespond(approval, 'edit', undefined, value as JsonRecord) } catch (cause) { setEditError(cause instanceof Error ? cause.message : 'JSON 格式无效') } }}>修改后允许</button></> : <><button type="button" className="button ghost" onClick={() => setEditing(true)}>编辑参数</button><button type="button" className="button secondary" onClick={() => onRespond(approval, 'reject')}>拒绝</button><button type="button" className="button primary" onClick={() => onRespond(approval, 'approve', effectiveScope)}>{actionLabel}</button></>}
        </div>
      </div>
    </section>
  )
}

function RunHeader({ detail, onPause, onResume, onCancel, onToggleInspector, inspectorOpen, onRename, onExport, onDelete }: {
  detail: RunDetailView
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onToggleInspector: () => void
  inspectorOpen: boolean
  onRename: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const active = ['understanding', 'planning', 'running', 'verifying', 'waiting_approval', 'waiting_user'].includes(detail.status)
  return (
    <header className="run-header titlebar-drag">
      <div className="run-title-block">
        <div className="run-title-line"><h1>{detail.title}</h1><StatusBadge status={detail.status} /></div>
        <span>更新于 {formatDate(detail.updatedAt ?? detail.createdAt)}</span>
      </div>
      <div className="run-actions no-drag">
        {detail.status === 'paused' ? <IconButton icon="play" label="继续处理" onClick={onResume} /> : active ? <IconButton icon="pause" label="暂停" onClick={onPause} /> : null}
        {active && <IconButton icon="stop" label="停止" onClick={onCancel} />}
        <IconButton icon="edit" label="重命名会话" onClick={onRename} />
        <IconButton icon="download" label="导出为 Markdown" onClick={onExport} />
        {!active && <IconButton icon="trash" label="删除会话" onClick={onDelete} />}
        <IconButton icon="panelRight" label="工作详情" active={inspectorOpen} onClick={onToggleInspector} />
      </div>
    </header>
  )
}

function RunComposer({ runId, accessMode, disabled, onSend }: {
  runId: string
  accessMode: RunAccessMode
  disabled: boolean
  onSend: (message: string, accessMode: RunAccessMode, attachmentIds?: string[]) => void
}) {
  const [message, setMessage] = useState('')
  const [draftAccessMode, setDraftAccessMode] = useState<RunAccessMode>(accessMode)
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => { setDraftAccessMode(accessMode) }, [runId, accessMode])
  return (
    <SubmitForm className="run-composer" onSubmit={() => {
      if (!message.trim() || disabled) return
      onSend(message.trim(), draftAccessMode, attachments.map((attachment) => attachment.id))
      setMessage('')
      setAttachments([])
    }}>
      <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={1} placeholder={disabled ? '这项工作已停止' : '继续补充、调整方向或交代下一步…'} disabled={disabled} />
      {attachments.length > 0 && <div className="composer-attachments compact">{attachments.map((attachment) => <span key={attachment.id}><Icon name="file" size={12} />{attachment.name}<button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}>×</button></span>)}</div>}
      <div className="run-composer-bottom">
        <span>
          <select
            className="access-mode-select compact"
            value={draftAccessMode}
            onChange={(event) => setDraftAccessMode(event.target.value as RunAccessMode)}
            aria-label="工作执行权限"
            title="文件和命令只在当前工作区内执行，写入和 Shell 需要你批准"
            disabled={disabled}
          >
            <option value="approval">工作区 · 请求批准</option>
          </select>
          <button type="button" className="attachment-button compact" disabled={disabled} onClick={async () => { const imported = await bridge.importAttachments(); setAttachments((items) => [...items, ...imported.filter((next) => !items.some((item) => item.id === next.id)).map((item) => ({ id: item.id, name: item.name }))]) }}><Icon name="plus" size={13} />添加文件</button>
          <span className="composer-context"><Icon name="lock" size={13} />'工作区内处理'</span>
        </span>
        <button type="submit" className="send-button" aria-label="发送" disabled={disabled || !message.trim()}><Icon name="send" size={16} /></button>
      </div>
    </SubmitForm>
  )
}

function TasksView({
  snapshot,
  detail,
  runLoading,
  selectedWorkspace,
  inspectorOpen,
  onInspector,
  onCreate,
  onSettings,
  onSend,
  onPause,
  onResume,
  onCancel,
  onRename,
  onExport,
  onDelete,
  onApproval,
  onBindChrome,
  onRevealArtifact,
  onUndoChange,
}: {
  snapshot: WorkbenchSnapshot
  detail: RunDetailView | undefined
  runLoading: boolean
  selectedWorkspace: WorkspaceItem | undefined
  inspectorOpen: boolean
  onInspector: () => void
  onCreate: (prompt: string, mode: 'plan' | 'execute', accessMode: RunAccessMode, modelId?: string, attachmentIds?: string[]) => void
  onSettings: () => void
  onSend: (message: string, accessMode: RunAccessMode, attachmentIds?: string[]) => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onRename: () => void
  onExport: () => void
  onDelete: () => void
  onApproval: (approval: ApprovalItem, decision: 'approve' | 'edit' | 'reject', scope?: ApprovalScopeChoice, editedArguments?: JsonRecord) => void
  onBindChrome: () => void
  onRevealArtifact: (id: string) => void
  onUndoChange: (id: string) => void
}) {
  const [inspectorTab, setInspectorTab] = useState<WorkInspectorTab>('details')
  if (!detail && runLoading) return <main className="main-pane centered"><Spinner size={24} /></main>
  if (!detail) return <main className="main-pane"><WelcomeComposer workspace={selectedWorkspace} models={snapshot.models} defaultMode={snapshot.settings.defaultExecutionMode === 'plan' ? 'plan' : 'execute'} defaultAccessMode="approval" onSubmit={onCreate} onOpenSettings={onSettings} /></main>
  const inputDisabled = detail.status === 'cancelled'
  const pendingApprovals = detail.approvals.filter((approval) => approval.status === undefined || approval.status === 'pending')
  const openInspector = (tab: WorkInspectorTab) => { setInspectorTab(tab); if (!inspectorOpen) onInspector() }
  return (
    <div className="task-workbench">
      <main className="main-pane run-pane">
        <RunHeader detail={detail} onPause={onPause} onResume={onResume} onCancel={onCancel} onToggleInspector={onInspector} inspectorOpen={inspectorOpen} onRename={onRename} onExport={onExport} onDelete={onDelete} />
        <div className="run-scroll">
          <WorkTimeline
            detail={detail}
            approvals={pendingApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onRespond={onApproval} />)}
            onOpenDetails={() => openInspector('details')}
            onOpenChanges={() => openInspector('changes')}
          />
        </div>
        <RunComposer runId={detail.id} accessMode={detail.accessMode ?? 'approval'} disabled={inputDisabled} onSend={onSend} />
      </main>
      {inspectorOpen && <WorkInspector detail={detail} snapshot={snapshot} requestedTab={inspectorTab} onBindChrome={onBindChrome} onOpenSettings={onSettings} onRevealArtifact={onRevealArtifact} onUndoChange={onUndoChange} />}
    </div>
  )
}

function Onboarding({
  open,
  snapshot,
  perform,
  onDone,
}: {
  open: boolean
  snapshot: WorkbenchSnapshot
  perform: Perform
  onDone: () => void
}) {
  const connectedModel = snapshot.models.some((model) => model.hasSecret)
  const initialStep = connectedModel ? snapshot.workspaces.length ? 3 : 2 : snapshot.models.length ? 1 : 0
  const [step, setStep] = useState(initialStep)
  const [provider, setProvider] = useState<ModelProvider>('deepseek')
  const [modelId, setModelId] = useState(MODEL_PROVIDER_META.deepseek.defaultModelId)
  const [baseUrl, setBaseUrl] = useState(MODEL_PROVIDER_META.deepseek.defaultBaseUrl)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestView>()
  const [memoryEnabled, setMemoryEnabled] = useState(snapshot.settings.memoryEnabled !== false)
  const [defaultExecutionMode, setDefaultExecutionMode] = useState<'plan' | 'execute'>(snapshot.settings.defaultExecutionMode === 'plan' ? 'plan' : 'execute')
  useEffect(() => {
    const hasConnectedModel = snapshot.models.some((model) => model.hasSecret)
    if (open && step !== 0 && step < 3) setStep(hasConnectedModel ? snapshot.workspaces.length ? 3 : 2 : 1)
  }, [open, snapshot.models, snapshot.workspaces.length, step])
  if (!open) return null
  const selectProvider = (nextProvider: ModelProvider) => {
    setKey('')
    setTestResult(undefined)
    setProvider(nextProvider)
    setModelId(MODEL_PROVIDER_META[nextProvider].defaultModelId)
    setBaseUrl(MODEL_PROVIDER_META[nextProvider].defaultBaseUrl)
  }
  const testConnection = async () => {
    setTesting(true)
    setTestResult(undefined)
    try {
      setTestResult(describeConnectionTest(await bridge.testModelDraft({ provider, modelId: modelId.trim(), baseUrl: baseUrl.trim(), apiKey: key.trim() })))
    } catch (error) {
      setTestResult(connectionTestFailure(error))
    } finally {
      setTesting(false)
    }
  }
  const saveModel = async () => {
    const submittedKey = key.trim()
    setKey('')
    setTestResult(undefined)
    setSaving(true)
    try {
      const profile = await perform(() => bridge.saveModel({ name: MODEL_PROVIDER_META[provider].name, provider, modelId, baseUrl: baseUrl.trim() }), undefined, { refresh: false })
      const id = resultId(profile)
      if (id) {
        const secretSaved = await perform(async () => { await bridge.setModelSecret({ profileId: id, apiKey: submittedKey }); return true }, undefined, { refresh: false })
        if (secretSaved) {
          await perform(() => bridge.setDefaultModel(id), '模型已连接')
          setStep(2)
        }
      }
    } finally {
      setSaving(false)
    }
  }
  const chooseWorkspace = async () => {
    const path = await perform(() => bridge.chooseWorkspace(), undefined, { refresh: false })
    if (typeof path !== 'string' || !path) return
    const added = await perform(() => bridge.addWorkspace(path), '工作区已授权')
    if (added !== undefined) setStep(3)
  }
  const finish = async () => {
    setKey('')
    await perform(() => bridge.updateSettings({ memoryEnabled, defaultExecutionMode }), '设置已完成')
    onDone()
  }
  return (
    <div className="onboarding-backdrop">
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-label="欢迎使用 DeskForge">
        <div className="onboarding-side">
          <div className="onboarding-brand"><div className="brand-mark"><BrandMark size={19} /></div><strong>DeskForge</strong></div>
          <div className="setup-steps">
            {[['activity', '欢迎'], ['key', '连接模型'], ['folder', '授权工作区'], ['globe', '浏览器连接'], ['shield', '执行边界']].map(([icon, label], index) => {
              const indexStep = index
              return <div key={label} className={step === indexStep ? 'is-current' : step > indexStep ? 'is-done' : ''}><span>{step > indexStep ? <Icon name="check" size={14} /> : <Icon name={icon as IconName} size={15} />}</span><strong>{label}</strong></div>
            })}
          </div>
          <p><Icon name="lock" size={13} />本地优先 · 无账号 · 无遥测</p>
        </div>
        <div className="onboarding-main">
          {step === 0 && <div className="setup-panel welcome-panel"><div className="setup-illustration"><span><BrandMark size={32} /></span><i /><i /><i /></div><span className="eyebrow">安静的本地工作台</span><h1>交代工作，<br />把控制权留在手里。</h1><p>DeskForge 会理解目标、执行操作并整理结果。文件、活动记录与密钥由本机边界管理。</p><div className="setup-feature-row"><span><Icon name="folder" />文件与命令</span><span><Icon name="globe" />现有 Chrome</span><span><Icon name="shield" />确认与记录</span></div><button type="button" className="button primary setup-next" onClick={() => setStep(1)}>开始设置<Icon name="arrowRight" /></button></div>}
          {step === 1 && <div className="setup-panel"><span className="eyebrow">第 1 步，共 4 步</span><h1>连接一个模型</h1><p>直接使用你的官方 API Key。密钥保存后不可从界面读取。</p><div className="provider-choice"><button type="button" className={provider === 'deepseek' ? 'is-active' : ''} onClick={() => selectProvider('deepseek')}><span>D</span><div><strong>DeepSeek</strong><small>OpenAI 兼容</small></div><i /></button><button type="button" className={provider === 'kimi' ? 'is-active' : ''} onClick={() => selectProvider('kimi')}><span>K</span><div><strong>Kimi</strong><small>Moonshot</small></div><i /></button><button type="button" className={provider === 'tongyi' ? 'is-active' : ''} onClick={() => selectProvider('tongyi')}><span>通</span><div><strong>通义</strong><small>DashScope</small></div><i /></button><button type="button" className={provider === 'custom' ? 'is-active' : ''} onClick={() => selectProvider('custom')}><span>自</span><div><strong>自定义</strong><small>自备 baseUrl</small></div><i /></button></div><Field label="服务地址" hint={provider === 'custom' ? '必填，OpenAI 兼容的 /v1 地址' : '可按服务商文档修改'}><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example.com/v1" /></Field><Field label="模型 ID"><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={provider === 'custom' ? '模型 ID' : MODEL_PROVIDER_META[provider].defaultModelId} /></Field><Field label="API Key" hint="留空不会覆盖已保存的密钥。macOS 使用系统钥匙串加密；加密不可用时会明确失败，不会把明文写入数据库。"><input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={MODEL_PROVIDER_META[provider].keyPlaceholder} /></Field><div className="secret-note"><Icon name="lock" />密钥只写入本机加密存储，不会进入工具、日志或上下文。DeskForge 不是 WorkBuddy，也不是腾讯的产品。</div>{testResult && <ConnectionTestNotice result={testResult} onClose={() => setTestResult(undefined)} />}<div className="setup-actions"><button type="button" className="button secondary setup-test" disabled={!modelId.trim() || !baseUrl.trim() || !key.trim() || testing || saving} onClick={() => void testConnection()}>{testing && <Spinner size={14} />}测试连接</button><button type="button" className="button primary setup-next" disabled={!modelId.trim() || !baseUrl.trim() || !key.trim() || saving} onClick={() => void saveModel()}>{saving && <Spinner size={14} />}安全保存并继续<Icon name="arrowRight" /></button></div></div>}
          {step === 2 && <div className="setup-panel"><span className="eyebrow">第 2 步，共 4 步</span><h1>授权一个工作区</h1><p>DeskForge 只能通过文件工具访问你明确选择的根目录，并会阻止路径穿越和符号链接逃逸。</p><div className="workspace-picker-illustration"><span><Icon name="folder" size={30} /></span><div><strong>选择项目或资料文件夹</strong><small>你可以稍后添加多个工作区</small></div></div><ul className="safety-list"><li><Icon name="check" />修改前确认文件没有被其他程序更新</li><li><Icon name="check" />写入前保存快照，完成后展示变更</li><li><Icon name="check" />未知命令会在执行前请你确认</li></ul><button type="button" className="button primary setup-next" onClick={() => void chooseWorkspace()}>选择文件夹<Icon name="arrowRight" /></button></div>}
          {step === 3 && <div className="setup-panel"><span className="eyebrow">第 3 步，共 4 步</span><h1>连接 Chrome</h1><p>使用现有登录状态时，需要你手动加载扩展并绑定标签页；应用不会读取未授权页面。</p><div className="chrome-settings"><div className="chrome-illustration"><Icon name="globe" size={24} /></div><div><strong>{snapshot.chrome.connected ? 'Chrome 已连接' : snapshot.chrome.extensionInstalled ? '扩展已安装，当前离线' : '尚未检测到浏览器连接'}</strong><span>本地桥接：{snapshot.chrome.nativeHostInstalled ? '已安装' : '待安装'} · 可以稍后继续配置</span></div><span className={snapshot.chrome.connected ? 'health-pill healthy' : 'health-pill'}><i />{snapshot.chrome.connected ? '在线' : '可跳过'}</span></div><ul className="safety-list"><li><Icon name="check" />只访问你主动绑定给当前工作的标签页</li><li><Icon name="check" />不会导出 Cookie，也不会读取其他既有标签</li><li><Icon name="check" />提交、购买、发送、上传和删除仍需确认</li></ul><button type="button" className="button primary setup-next" onClick={() => setStep(4)}>{snapshot.chrome.connected ? '继续' : '稍后配置并继续'}<Icon name="arrowRight" /></button></div>}
          {step === 4 && <div className="setup-panel"><span className="eyebrow">第 4 步，共 4 步</span><h1>确认工作方式</h1><p>文件和 Shell 只在你选择的工作区内执行。写入和命令需要批准，不会默认授权磁盘根目录 /。</p><div className="secret-note"><Icon name="shield" />工作区白名单是唯一文件边界。DeskForge 不提供“完全访问 = /”。</div><SettingRow title="新工作默认方式" detail="先整理计划时只使用只读能力。"><select value={defaultExecutionMode} onChange={(event) => setDefaultExecutionMode(event.target.value as 'plan' | 'execute')}><option value="execute">直接处理</option><option value="plan">先整理计划（只读）</option></select></SettingRow><SettingRow title="允许提出记忆候选" detail="所有候选仍需你确认后才生效。"><Toggle checked={memoryEnabled} onChange={setMemoryEnabled} label="记忆建议" /></SettingRow><button type="button" className="button primary setup-next" onClick={() => void finish()}>进入工作台<Icon name="arrowRight" /></button></div>}
        </div>
      </section>
    </div>
  )
}

export default function App() {
  const workbench = useWorkbench()
  const { snapshot, loading, refreshing, error, selectedRunId, setSelectedRunId, runDetail, runLoading, refresh, perform, notify, toasts, dismissToast } = workbench
  const [view, setView] = useState<ViewKey>('tasks')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>()
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(() => window.localStorage.getItem('deskforge.sidebar-open') !== 'false')
  const [inspectorOpen, setInspectorOpen] = useState(() => {
    const stored = window.localStorage.getItem('deskforge.inspector-open')
    return stored === null ? true : stored === 'true'
  })
  const [cancelOpen, setCancelOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState<string>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  useResolvedTheme(snapshot.settings.theme)

  useEffect(() => {
    if (selectedWorkspaceId && snapshot.workspaces.some((item) => item.id === selectedWorkspaceId)) return
    setSelectedWorkspaceId(snapshot.workspaces.find((item) => item.selected)?.id ?? snapshot.workspaces[0]?.id)
  }, [selectedWorkspaceId, snapshot.workspaces])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setSelectedRunId(undefined)
        setView('tasks')
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        setView('settings')
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
        event.preventDefault()
        setSidebarOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setSelectedRunId])

  useEffect(() => { window.localStorage.setItem('deskforge.sidebar-open', String(sidebarOpen)) }, [sidebarOpen])
  useEffect(() => { window.localStorage.setItem('deskforge.inspector-open', String(inspectorOpen)) }, [inspectorOpen])

  const visibleArtifactCount = (runDetail?.artifacts.filter(isUserVisibleArtifact).length ?? 0) + (runDetail?.diffs.length ?? 0)
  useEffect(() => {
    if (visibleArtifactCount > 0) setInspectorOpen(true)
  }, [selectedRunId, visibleArtifactCount])

  const selectedWorkspace = snapshot.workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
  const shouldOnboard = !loading && !onboardingDismissed && snapshot.settings.onboardingCompleted === false

  const switchWorkspace = async (id: string) => {
    if (!id) return
    setSelectedWorkspaceId(id)
    await perform(() => bridge.selectWorkspace(id), undefined)
  }

  const createRun = async (prompt: string, mode: 'plan' | 'execute', accessMode: RunAccessMode, modelProfileId?: string, attachmentIds: string[] = []) => {
    if (!selectedWorkspaceId) { notify('info', '请先添加工作区'); setView('settings'); return }
    if (!modelProfileId) { notify('info', '请先配置模型'); setView('settings'); return }
    const objective = mode === 'plan' ? `仅制定可执行计划，不执行任何修改：\n\n${prompt}` : prompt
    const result = await perform(() => bridge.createRun({
      workspaceId: selectedWorkspaceId,
      objective,
      mode,
      accessMode,
      title: prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt,
      modelProfileId,
      ...(attachmentIds.length ? { attachmentIds } : {}),
    }), '工作已开始')
    const id = resultId(result)
    if (id) {
      setSelectedRunId(id)
      setView('tasks')
    }
  }

  const sendMessage = async (content: string, accessMode: RunAccessMode, attachmentIds: string[] = []) => {
    if (!selectedRunId) return
    const runId = selectedRunId
    const optimisticEventId = workbench.appendOptimisticUserMessage(runId, content, attachmentIds)
    await perform(() => bridge.sendMessage(runId, content, accessMode, attachmentIds))
    await workbench.reloadRun(runId, true)
    workbench.removeOptimisticUserMessage(runId, optimisticEventId)
  }

  const respondApproval = async (approval: ApprovalItem, decision: 'approve' | 'edit' | 'reject', scope?: ApprovalScopeChoice, editedArguments?: JsonRecord) => {
    const input: JsonRecord = { requestId: approval.id, decision }
    if (decision === 'approve') input.scope = scope ?? 'once'
    if (decision === 'edit' && editedArguments) input.editedArguments = editedArguments
    await perform(() => bridge.respondApproval(input), decision === 'approve' ? (scope === 'session' ? '已允许，本会话同类操作将自动允许' : '已允许这次操作') : decision === 'edit' ? '参数已修改，DeskForge 将按新参数继续' : '操作已拒绝', { refreshRun: true })
  }

  const handleAutomationRun = (value: unknown) => {
    const id = resultId(value)
    if (id) { setSelectedRunId(id); setView('tasks') }
  }

  if (loading) return (
    <div className="boot-screen"><div className="boot-logo"><BrandMark size={25} /></div><strong>DeskForge</strong><Spinner /><span>正在恢复本地工作台…</span></div>
  )

  if (error && snapshot.workspaces.length === 0 && snapshot.models.length === 0) return (
    <div className="fatal-screen"><div className="fatal-icon"><Icon name="warning" size={26} /></div><h1>工作台暂时无法启动</h1><p>{error}</p><button type="button" className="button primary" onClick={() => void refresh()}><Icon name="refresh" />重试</button><small>本机数据仍然安全，应用不会绕过授权访问。</small></div>
  )

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-hidden'}`}>
      {sidebarOpen && <ShellSidebar
        view={view}
        onView={setView}
        snapshot={snapshot}
        selectedWorkspaceId={selectedWorkspaceId}
        onWorkspace={(id) => void switchWorkspace(id)}
        selectedRunId={selectedRunId}
        onRun={setSelectedRunId}
        onNewTask={() => { setSelectedRunId(undefined); setView('tasks') }}
        search={search}
        onSearch={setSearch}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        onHide={() => setSidebarOpen(false)}
      />}
      <section className="content-shell">
        {!sidebarOpen && <div className="sidebar-reveal titlebar-drag"><IconButton icon="panelRight" label="显示侧栏" onClick={() => setSidebarOpen(true)} /></div>}
        {view === 'tasks' && <TasksView
          snapshot={snapshot}
          detail={runDetail}
          runLoading={runLoading}
          selectedWorkspace={selectedWorkspace}
          inspectorOpen={inspectorOpen}
          onInspector={() => setInspectorOpen((value) => !value)}
          onCreate={(prompt, mode, accessMode, modelId, attachmentIds) => void createRun(prompt, mode, accessMode, modelId, attachmentIds)}
          onSettings={() => setView('settings')}
          onSend={(message, accessMode, attachmentIds) => void sendMessage(message, accessMode, attachmentIds)}
          onPause={() => selectedRunId && void perform(() => bridge.pauseRun(selectedRunId), '工作已暂停', { refreshRun: true })}
          onResume={() => selectedRunId && void perform(() => bridge.resumeRun(selectedRunId), '继续处理', { refreshRun: true })}
          onCancel={() => setCancelOpen(true)}
          onRename={() => setRenameDraft(runDetail?.title ?? '')}
          onExport={() => selectedRunId && void perform(async () => {
            const exported = await bridge.exportRunMarkdown(selectedRunId)
            if (exported) notify('success', '会话已导出为 Markdown', `${exported.path}（密钥类内容已脱敏）`)
            return exported
          }, undefined, { refresh: false })}
          onDelete={() => setDeleteOpen(true)}
          onApproval={(approval, decision, scope, editedArguments) => void respondApproval(approval, decision, scope, editedArguments)}
          onBindChrome={() => selectedRunId && void perform(() => bridge.requestChromeBinding(selectedRunId), '已向 Chrome 发出绑定请求')}
          onRevealArtifact={(id) => void perform(() => bridge.revealArtifact(id), undefined, { refresh: false })}
          onUndoChange={(id) => void perform(() => bridge.undoChange(id), '文件变更已撤销', { refreshRun: true })}
        />}
        {(['memory', 'mcp', 'skills'] as ViewKey[]).includes(view) && <LibraryPage view={view as LibraryView} snapshot={snapshot} workspaceId={selectedWorkspaceId} perform={perform} onView={setView} />}
        {view === 'automations' && <AutomationsPage snapshot={snapshot} workspaceId={selectedWorkspaceId} perform={perform} onRunCreated={handleAutomationRun} />}
        {view === 'settings' && <SettingsPage snapshot={snapshot} selectedWorkspaceId={selectedWorkspaceId} perform={perform} onWorkspaceAdded={() => void refresh()} onWorkspaceSelected={(id) => void switchWorkspace(id)} onOpenAudit={() => setView('audit')} />}
        {view === 'audit' && <AuditPage snapshot={snapshot} perform={perform} />}
      </section>
      <ConfirmDialog open={cancelOpen} title="停止当前工作？" description="正在运行的操作会收到停止信号，已经完成的本地变更不会自动撤销。" confirmLabel="停止工作" danger onCancel={() => setCancelOpen(false)} onConfirm={() => { setCancelOpen(false); if (selectedRunId) void perform(() => bridge.cancelRun(selectedRunId), '已停止', { refreshRun: true }) }} />
      <Modal open={renameDraft !== undefined} title="重命名会话" description="新名称会同步到侧栏和会话搜索。" onClose={() => setRenameDraft(undefined)}>
        <SubmitForm className="modal-form" onSubmit={() => {
          const title = (renameDraft ?? '').trim()
          if (!title || !selectedRunId) return
          setRenameDraft(undefined)
          void perform(() => bridge.renameRun(selectedRunId, title), '会话已重命名', { refreshRun: true })
        }}>
          <Field label="会话名称"><input autoFocus maxLength={500} value={renameDraft ?? ''} onChange={(event) => setRenameDraft(event.target.value)} aria-label="会话名称" /></Field>
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setRenameDraft(undefined)}>取消</button>
            <button type="submit" className="button primary" disabled={!(renameDraft ?? '').trim()}>保存</button>
          </div>
        </SubmitForm>
      </Modal>
      <ConfirmDialog open={deleteOpen} title="删除这个会话？" description="会话消息、步骤和工具记录会从本机删除，且无法恢复；审计日志仍会保留。已写入工作区的文件不受影响。" confirmLabel="删除会话" danger onCancel={() => setDeleteOpen(false)} onConfirm={() => {
        setDeleteOpen(false)
        const id = selectedRunId
        if (!id) return
        void perform(async () => { await bridge.removeRun(id); setSelectedRunId(undefined) }, '会话已删除')
      }} />
      <Onboarding open={shouldOnboard} snapshot={snapshot} perform={perform} onDone={() => { setOnboardingDismissed(true); void refresh() }} />
      <Toasts items={toasts} onDismiss={dismissToast} />
    </div>
  )
}
