import { useEffect, useRef, useState } from 'react'
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
import { SlashCommandMenu } from './features/shell/SlashCommandMenu'
import { FileMentionMenu } from './features/shell/FileMentionMenu'
import { CommandPalette } from './features/shell/CommandPalette'
import { formatTokenCount, readTokenUsage, tokenUsageLines, type TokenUsageView } from './features/work/run-insights'
import { WorkTimeline } from './features/work/WorkTimeline'
import { ApprovalDiff } from './features/work/ApprovalDiff'
import { isUserVisibleArtifact, WorkInspector, type WorkInspectorTab } from './features/work/WorkInspector'
import type {
  ApprovalItem,
  ApprovalScopeChoice,
  JsonRecord,
  ModelProvider,
  RunPermissionMode,
  RunDetailView,
  SkillItem,
  ViewKey,
  WorkbenchSnapshot,
  WorkspaceFileItem,
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

function translateApprovalReason(text?: string): string {
  if (!text) return 'DeskForge 需要得到允许后才能继续。'
  const map: Record<string, string> = {
    'The tool declares this operation destructive.': '操作包含删除或不可逆破坏性改动（如 rm），系统无法自动放行。',
    'Command may irreversibly delete data or modify the operating system.': '命令包含删除文件或修改系统操作，属于不可逆高风险操作。',
    'Command communicates with an external system or publishes data.': '命令将与外部系统通信或对外发布数据。',
    'Command is not proven read-only and may modify the workspace.': '命令可能会对工作区文件产生写入修改。',
    'Filesystem deletion is not assumed recoverable.': '删除文件操作无法保证完全恢复。',
    'Target is outside the authorized workspace roots.': '操作目标超出了已授权的工作区目录。',
    'Shell-based macOS GUI and application automation is outside this product boundary.': '系统禁止通过 Shell 脚本接管 macOS 桌面 GUI 或自动化。',
  }
  return map[text] ?? text
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
  const command = typeof approval.arguments?.command === 'string' ? approval.arguments.command : undefined
  return (
    <section className={`approval-card risk-${approval.risk}`}>
      <div className="approval-icon"><Icon name={approval.risk === 'irreversible' ? 'warning' : 'shield'} /></div>
      <div className="approval-body">
        <div className="approval-heading">
          <div><span>需要你的确认</span><h3>{approval.title}</h3></div>
          <span className="risk-label">{approval.risk === 'reversible_write' ? '可以撤销' : approval.risk === 'external_effect' ? '会影响外部系统' : '可能无法撤销'}</span>
        </div>
        <p>{translateApprovalReason(approval.summary)}</p>
        {command && !editing && (
          <div className="approval-command-preview" title="待执行命令">
            <code>{command.length > 240 ? `${command.slice(0, 240)}…` : command}</code>
          </div>
        )}
        {approval.diff && !editing && <ApprovalDiff diff={approval.diff} />}
        {approval.arguments && !editing && <details className="approval-details"><summary>查看完整操作参数</summary><pre>{JSON.stringify(approval.arguments, null, 2)}</pre></details>}
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

function ContextUsageMeter({ usage }: { usage: TokenUsageView }) {
  const budget = 128_000
  const pct = Math.min(100, Math.round((usage.totalTokens / budget) * 100))
  const isHigh = pct >= 80
  const isMedium = pct >= 50

  const lines = tokenUsageLines(usage)
  const tooltipText = `上下文用量预算估算 (${pct}% / 128k tokens)\n` + lines.map((l) => `${l.label}: ${l.value}`).join('\n')

  return (
    <div
      className={`context-usage-meter${isHigh ? ' is-high' : isMedium ? ' is-medium' : ''}`}
      title={tooltipText}
    >
      <div className="context-usage-bar-track">
        <div className="context-usage-bar-fill" style={{ width: `${Math.max(6, pct)}%` }} />
      </div>
      <span className="context-usage-label">
        <Icon name="layers" size={11} />
        {formatTokenCount(usage.totalTokens)}
      </span>
    </div>
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
  const tokenUsage = readTokenUsage(detail.tokenUsage)

  return (
    <header className="run-header titlebar-drag">
      <div className="run-title-block">
        <div className="run-title-line">
          <span className="run-forge-badge">工单</span>
          <h1>{detail.title}</h1>
          <StatusBadge status={detail.status} />
          {tokenUsage && <ContextUsageMeter usage={tokenUsage} />}
        </div>
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

function getMentionMatch(text: string, cursorPosition: number): { query: string; start: number } | null {
  const beforeCursor = text.slice(0, cursorPosition)
  const match = beforeCursor.match(/(?:^|[\s\n])@([^\s@]*)$/)
  if (!match) return null
  const query = match[1] ?? ''
  const atIndex = beforeCursor.length - query.length - 1
  return { query, start: atIndex }
}

function extractMentions(text: string): string[] {
  const regex = /(?:^|[\s\n])@([^\s@]+)/g
  const matches: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match[1] && !matches.includes(match[1])) {
      matches.push(match[1])
    }
  }
  return matches
}

function RunComposer({ runId, workspaceId, permissionMode, disabled, onSend, skills = [] }: {
  runId: string
  workspaceId?: string | undefined
  permissionMode: RunPermissionMode
  disabled: boolean
  onSend: (message: string, permissionMode: RunPermissionMode, attachmentIds?: string[]) => void
  skills?: SkillItem[]
}) {
  const [message, setMessage] = useState('')
  const [draftPermissionMode, setDraftPermissionMode] = useState<RunPermissionMode>(permissionMode)
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string }>>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [matchedFiles, setMatchedFiles] = useState<WorkspaceFileItem[]>([])
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentionMatch, setMentionMatch] = useState<{ query: string; start: number } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const mentionedFiles = extractMentions(message)

  const handleRemoveMention = (filePath: string) => {
    const escaped = filePath.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    const regex = new RegExp(`@${escaped}(?:\\s|$)`, 'g')
    setMessage((prev) => prev.replace(regex, '').trim())
  }

  const handleTriggerMention = () => {
    if (disabled || !workspaceId) return
    const cursor = textareaRef.current?.selectionStart ?? message.length
    const before = message.slice(0, cursor)
    const after = message.slice(cursor)
    const needsSpace = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n')
    const inserted = needsSpace ? ' @' : '@'
    const nextMessage = before + inserted + after
    const nextCursor = before.length + inserted.length
    setMessage(nextMessage)
    setMentionDismissed(false)
    checkMention(nextMessage, nextCursor)
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(nextCursor, nextCursor)
      }
    })
  }

  const handleTriggerSlash = () => {
    if (disabled) return
    if (!message.startsWith('/')) {
      const nextMessage = `/${message}`
      setMessage(nextMessage)
      setSlashDismissed(false)
      setSlashIndex(0)
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(nextMessage.length, nextMessage.length)
        }
      })
    } else {
      setSlashDismissed(false)
      textareaRef.current?.focus()
    }
  }

  useEffect(() => { setDraftPermissionMode(permissionMode) }, [runId, permissionMode])

  const isSlashActive = !disabled && message.startsWith('/') && !message.includes(' ') && !slashDismissed
  const slashQuery = isSlashActive ? message.slice(1).toLowerCase() : ''
  const availableSkills = skills.filter((s) => s.enabled !== false)
  const matchingSkills = isSlashActive
    ? availableSkills.filter((s) => !slashQuery || s.name.toLowerCase().includes(slashQuery) || (s.description && s.description.toLowerCase().includes(slashQuery)))
    : []

  const isMentionActive = Boolean(!disabled && workspaceId && mentionMatch && !mentionDismissed && !isSlashActive)

  const checkMention = (text: string, cursor: number) => {
    if (!workspaceId) {
      setMentionMatch(null)
      return
    }
    const match = getMentionMatch(text, cursor)
    setMentionMatch(match)
    if (!match) {
      setMatchedFiles([])
      setMentionDismissed(false)
    }
  }

  useEffect(() => {
    if (!workspaceId || !mentionMatch || mentionDismissed) {
      setMatchedFiles([])
      return
    }
    let cancelled = false
    setMentionLoading(true)
    const timeout = setTimeout(async () => {
      try {
        const results = await bridge.searchWorkspaceFiles(workspaceId, mentionMatch.query, 30)
        if (!cancelled) {
          setMatchedFiles(results)
          setMentionIndex(0)
          setMentionLoading(false)
        }
      } catch {
        if (!cancelled) {
          setMatchedFiles([])
          setMentionLoading(false)
        }
      }
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [workspaceId, mentionMatch?.query, mentionDismissed])

  const handleSelectSkill = (skill: SkillItem) => {
    setMessage(`/${skill.name} `)
    setSlashDismissed(false)
    textareaRef.current?.focus()
  }

  const handleSelectFile = (file: WorkspaceFileItem) => {
    if (!textareaRef.current) return
    const cursor = textareaRef.current.selectionStart ?? message.length
    const match = getMentionMatch(message, cursor)
    if (!match) return

    const beforeAt = message.slice(0, match.start)
    const afterCursor = message.slice(cursor)
    const insertText = `@${file.path} `
    const nextMessage = beforeAt + insertText + afterCursor
    const nextCursor = beforeAt.length + insertText.length

    setMessage(nextMessage)
    setMentionDismissed(false)
    setMentionMatch(null)
    setMatchedFiles([])

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(nextCursor, nextCursor)
      }
    })
  }

  const handleMessageChange = (val: string, cursor: number) => {
    setMessage(val)
    if (val.startsWith('/') && !val.includes(' ')) {
      setSlashDismissed(false)
      setSlashIndex(0)
    }
    checkMention(val, cursor)
  }

  const submit = () => {
    if (!message.trim() || disabled) return
    onSend(message.trim(), draftPermissionMode, attachments.map((attachment) => attachment.id))
    setMessage('')
    setAttachments([])
    setSlashDismissed(false)
    setMentionDismissed(false)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSlashActive && matchingSkills.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashIndex((prev) => (prev + 1) % matchingSkills.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashIndex((prev) => (prev - 1 + matchingSkills.length) % matchingSkills.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const selected = matchingSkills[slashIndex] ?? matchingSkills[0]
        if (selected) {
          handleSelectSkill(selected)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashDismissed(true)
        return
      }
    }

    if (isMentionActive && matchedFiles.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((prev) => (prev + 1) % matchedFiles.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((prev) => (prev - 1 + matchedFiles.length) % matchedFiles.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const selected = matchedFiles[mentionIndex] ?? matchedFiles[0]
        if (selected) {
          handleSelectFile(selected)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionDismissed(true)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="run-composer-dock">
      <SubmitForm className="run-composer" onSubmit={submit}>
        {isSlashActive && matchingSkills.length > 0 && (
          <SlashCommandMenu
            skills={matchingSkills}
            query={slashQuery}
            selectedIndex={slashIndex}
            onSelect={handleSelectSkill}
          />
        )}
        {isMentionActive && (
          <FileMentionMenu
            files={matchedFiles}
            query={mentionMatch?.query ?? ''}
            selectedIndex={mentionIndex}
            loading={mentionLoading}
            onSelect={handleSelectFile}
          />
        )}
        <div className="composer-input-box">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(event) => handleMessageChange(event.target.value, event.target.selectionStart)}
            onKeyUp={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                checkMention(event.currentTarget.value, event.currentTarget.selectionStart)
              }
            }}
            onClick={(event) => checkMention(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder={disabled ? '这项工作已停止' : '交代指令、追加要求（输入 / 调用技能，@ 关联工作区文件，Enter 发送）…'}
            disabled={disabled}
          />
          {(mentionedFiles.length > 0 || attachments.length > 0) && (
            <div className="composer-context-chips compact" aria-label="已关联上下文">
              <span className="context-chips-title">
                <Icon name="layers" size={11} />
                <span>上下文:</span>
              </span>
              {mentionedFiles.map((filePath) => (
                <span key={filePath} className="composer-chip mention-chip" title={`引用工作区文件: ${filePath}`}>
                  <Icon name="file" size={11} />
                  <span className="composer-chip-text">@{filePath}</span>
                  <button
                    type="button"
                    aria-label={`移除引用 @${filePath}`}
                    title="移除该文件引用"
                    onClick={() => handleRemoveMention(filePath)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {attachments.map((attachment) => (
                <span key={attachment.id} className="composer-chip attachment-chip" title={`已添加附件: ${attachment.name}`}>
                  <Icon name="file" size={11} />
                  <span className="composer-chip-text">{attachment.name}</span>
                  <button
                    type="button"
                    aria-label={`移除附件 ${attachment.name}`}
                    title="移除该附件"
                    onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="run-composer-bottom">
          <div className="composer-controls">
            <select
              className="access-mode-select permission-mode-select compact"
              value={draftPermissionMode}
              onChange={(event) => setDraftPermissionMode(event.target.value as RunPermissionMode)}
              aria-label="操作确认方式"
              title="自动处理只放行可撤销的工作区写入和验证命令；删除、敏感文件及外发仍需批准"
              disabled={disabled}
            >
              <option value="approval">请求批准（每步确认）</option>
              <option value="workspace_auto">工作区内自动处理</option>
            </select>
            <button
              type="button"
              className="composer-action-btn compact"
              disabled={disabled || !workspaceId}
              title="引用工作区文件 (@)"
              onClick={handleTriggerMention}
            >
              <span className="action-symbol">@</span>
              <span>文件</span>
            </button>
            <button
              type="button"
              className="composer-action-btn compact"
              disabled={disabled}
              title="调用技能 (/)"
              onClick={handleTriggerSlash}
            >
              <Icon name="skill" size={12} />
              <span>技能</span>
            </button>
            <button
              type="button"
              className="attachment-button compact"
              disabled={disabled}
              onClick={async () => {
                const imported = await bridge.importAttachments()
                setAttachments((items) => [
                  ...items,
                  ...imported
                    .filter((next) => !items.some((item) => item.id === next.id))
                    .map((item) => ({ id: item.id, name: item.name })),
                ])
              }}
            >
              <Icon name="plus" size={13} />
              附件
            </button>
            <span className="composer-context">
              <Icon name="lock" size={12} />
              {draftPermissionMode === 'workspace_auto' ? '自动放行安全操作' : '变更需审批'}
            </span>
          </div>
          <div className="composer-submit-group">
            <button
              type="submit"
              className="send-button"
              aria-label="发送指令"
              title="发送指令 (Enter，Shift+Enter 换行)"
              disabled={disabled || !message.trim()}
            >
              <span>发送</span>
              <Icon name="send" size={13} />
            </button>
          </div>
        </div>
      </SubmitForm>
    </div>
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
  onOpenArtifact,
  onOpenPath,
  onUndoChange,
}: {
  snapshot: WorkbenchSnapshot
  detail: RunDetailView | undefined
  runLoading: boolean
  selectedWorkspace: WorkspaceItem | undefined
  inspectorOpen: boolean
  onInspector: () => void
  onCreate: (prompt: string, mode: 'plan' | 'execute', permissionMode: RunPermissionMode, modelId?: string, attachmentIds?: string[]) => void
  onSettings: () => void
  onSend: (message: string, permissionMode: RunPermissionMode, attachmentIds?: string[]) => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onRename: () => void
  onExport: () => void
  onDelete: () => void
  onApproval: (approval: ApprovalItem, decision: 'approve' | 'edit' | 'reject', scope?: ApprovalScopeChoice, editedArguments?: JsonRecord) => void
  onBindChrome: () => void
  onRevealArtifact: (id: string) => void
  onOpenArtifact: (id: string) => void
  onOpenPath: (path: string) => void
  onUndoChange: (id: string) => void
}) {
  const [inspectorTab, setInspectorTab] = useState<WorkInspectorTab>('details')
  if (!detail && runLoading) return <main className="main-pane centered"><Spinner size={24} /></main>
  if (!detail) return <main className="main-pane"><WelcomeComposer workspace={selectedWorkspace} models={snapshot.models} defaultMode={snapshot.settings.defaultExecutionMode === 'plan' ? 'plan' : 'execute'} defaultPermissionMode="approval" onSubmit={onCreate} onOpenSettings={onSettings} skills={snapshot.skills} /></main>
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
            onOpenArtifact={onOpenArtifact}
            onOpenPath={onOpenPath}
          />
        </div>
        <RunComposer
          runId={detail.id}
          workspaceId={detail.workspaceId ?? selectedWorkspace?.id}
          permissionMode={detail.permissionMode ?? 'approval'}
          disabled={inputDisabled}
          onSend={onSend}
          skills={snapshot.skills}
        />
      </main>
      {inspectorOpen && <WorkInspector detail={detail} snapshot={snapshot} requestedTab={inspectorTab} onBindChrome={onBindChrome} onOpenSettings={onSettings} onRevealArtifact={onRevealArtifact} onOpenArtifact={onOpenArtifact} onOpenPath={onOpenPath} onUndoChange={onUndoChange} />}
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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  useResolvedTheme(snapshot.settings.theme)

  useEffect(() => {
    if (selectedWorkspaceId && snapshot.workspaces.some((item) => item.id === selectedWorkspaceId)) return
    setSelectedWorkspaceId(snapshot.workspaces.find((item) => item.selected)?.id ?? snapshot.workspaces[0]?.id)
  }, [selectedWorkspaceId, snapshot.workspaces])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandPaletteOpen((value) => !value)
      }
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

  const createRun = async (prompt: string, mode: 'plan' | 'execute', permissionMode: RunPermissionMode, modelProfileId?: string, attachmentIds: string[] = []) => {
    if (!selectedWorkspaceId) { notify('info', '请先添加工作区'); setView('settings'); return }
    if (!modelProfileId) { notify('info', '请先配置模型'); setView('settings'); return }
    const objective = mode === 'plan' ? `仅制定可执行计划，不执行任何修改：\n\n${prompt}` : prompt
    const result = await perform(() => bridge.createRun({
      workspaceId: selectedWorkspaceId,
      objective,
      mode,
      accessMode: 'approval',
      permissionMode,
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

  const sendMessage = async (content: string, permissionMode: RunPermissionMode, attachmentIds: string[] = []) => {
    if (!selectedRunId) return
    const runId = selectedRunId
    const optimisticEventId = workbench.appendOptimisticUserMessage(runId, content, attachmentIds)
    await perform(() => bridge.sendMessage(runId, content, 'approval', attachmentIds, permissionMode))
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
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
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
          onCreate={(prompt, mode, permissionMode, modelId, attachmentIds) => void createRun(prompt, mode, permissionMode, modelId, attachmentIds)}
          onSettings={() => setView('settings')}
          onSend={(message, permissionMode, attachmentIds) => void sendMessage(message, permissionMode, attachmentIds)}
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
          onOpenArtifact={(id) => void perform(async () => {
            const result = await bridge.openArtifact(id) as { success?: boolean; error?: string } | undefined
            if (result && result.success === false && result.error) notify('error', '打开文件失败', result.error)
          }, undefined, { refresh: false })}
          onOpenPath={(path) => void perform(async () => {
            const result = await bridge.openPath(path) as { success?: boolean; error?: string } | undefined
            if (result && result.success === false && result.error) notify('error', '打开文件失败', result.error)
          }, undefined, { refresh: false })}
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
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        runs={snapshot.runs}
        workspaces={snapshot.workspaces}
        currentWorkspaceId={selectedWorkspaceId}
        skills={snapshot.skills}
        onSelectRun={(runId) => {
          setSelectedRunId(runId)
          setView('tasks')
        }}
        onSelectWorkspace={(wsId) => {
          void switchWorkspace(wsId)
        }}
        onNewRun={() => {
          setSelectedRunId(undefined)
          setView('tasks')
        }}
        onOpenSettings={() => {
          setView('settings')
        }}
        onToggleSidebar={() => {
          setSidebarOpen((v) => !v)
        }}
      />
      <Toasts items={toasts} onDismiss={dismissToast} />
    </div>
  )
}
