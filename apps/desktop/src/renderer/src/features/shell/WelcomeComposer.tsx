import { useEffect, useRef, useState } from 'react'
import { bridge, errorMessage } from '../../bridge'
import { BrandMark, Icon } from '../../icons'
import type { ModelProfileItem, RunPermissionMode, SkillItem, WorkspaceFileItem, WorkspaceItem } from '../../types'
import { SubmitForm } from '../../ui'
import { SlashCommandMenu } from './SlashCommandMenu'
import { FileMentionMenu } from './FileMentionMenu'

function getMentionMatch(text: string, cursorPosition: number): { query: string; start: number } | null {
  const beforeCursor = text.slice(0, cursorPosition)
  const match = beforeCursor.match(/(?:^|[\s\n])@([^\s@]*)$/)
  if (!match) return null
  const query = match[1] ?? ''
  const atIndex = beforeCursor.length - query.length - 1
  return { query, start: atIndex }
}

export interface WelcomeComposerProps {
  workspace: WorkspaceItem | undefined
  models: ModelProfileItem[]
  defaultMode: 'plan' | 'execute'
  defaultPermissionMode: RunPermissionMode
  onSubmit: (prompt: string, mode: 'plan' | 'execute', permissionMode: RunPermissionMode, modelId?: string, attachmentIds?: string[]) => void
  onOpenSettings: () => void
  skills?: SkillItem[]
}

const SUGGESTIONS = [
  { icon: 'folder' as const, text: '整理当前工作区并告诉我项目状态' },
  { icon: 'terminal' as const, text: '检查项目并运行最相关的验证' },
  { icon: 'globe' as const, text: '通过 Chrome 调研资料并整理来源' },
]

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

export function WelcomeComposer({
  workspace,
  models,
  defaultMode,
  defaultPermissionMode,
  onSubmit,
  onOpenSettings,
  skills = [],
}: WelcomeComposerProps) {
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<'plan' | 'execute'>(defaultMode)
  const [permissionMode, setPermissionMode] = useState<RunPermissionMode>(defaultPermissionMode)
  const [modelId, setModelId] = useState(models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? '')
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string }>>([])
  const [attachmentError, setAttachmentError] = useState<string>()
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [matchedFiles, setMatchedFiles] = useState<WorkspaceFileItem[]>([])
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentionMatch, setMentionMatch] = useState<{ query: string; start: number } | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const fileMentions = files.map((f) => `@${f.name}`).join(' ')
    setPrompt((prev) => (prev ? `${prev} ${fileMentions} ` : `${fileMentions} `))
    textareaRef.current?.focus()
  }

  const mentionedFiles = extractMentions(prompt)

  const handleRemoveMention = (filePath: string) => {
    const escaped = filePath.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    const regex = new RegExp(`@${escaped}(?:\\s|$)`, 'g')
    setPrompt((prev) => prev.replace(regex, '').trim())
  }

  const handleTriggerMention = () => {
    if (!workspace) return
    const cursor = textareaRef.current?.selectionStart ?? prompt.length
    const before = prompt.slice(0, cursor)
    const after = prompt.slice(cursor)
    const needsSpace = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n')
    const inserted = needsSpace ? ' @' : '@'
    const nextPrompt = before + inserted + after
    const nextCursor = before.length + inserted.length
    setPrompt(nextPrompt)
    setMentionDismissed(false)
    checkMention(nextPrompt, nextCursor)
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(nextCursor, nextCursor)
      }
    })
  }

  const handleTriggerSlash = () => {
    if (!prompt.startsWith('/')) {
      const nextPrompt = `/${prompt}`
      setPrompt(nextPrompt)
      setSlashDismissed(false)
      setSlashIndex(0)
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(nextPrompt.length, nextPrompt.length)
        }
      })
    } else {
      setSlashDismissed(false)
      textareaRef.current?.focus()
    }
  }

  useEffect(() => {
    if (!models.some((model) => model.id === modelId)) {
      setModelId(models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? '')
    }
  }, [modelId, models])

  useEffect(() => { setPermissionMode(defaultPermissionMode) }, [defaultPermissionMode])

  const isSlashActive = prompt.startsWith('/') && !prompt.includes(' ') && !slashDismissed
  const slashQuery = isSlashActive ? prompt.slice(1).toLowerCase() : ''
  const availableSkills = skills.filter((s) => s.enabled !== false)
  const matchingSkills = isSlashActive
    ? availableSkills.filter((s) => !slashQuery || s.name.toLowerCase().includes(slashQuery) || (s.description && s.description.toLowerCase().includes(slashQuery)))
    : []

  const isMentionActive = Boolean(workspace && mentionMatch && !mentionDismissed && !isSlashActive)

  const checkMention = (text: string, cursor: number) => {
    if (!workspace) {
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
    if (!workspace || !mentionMatch || mentionDismissed) {
      setMatchedFiles([])
      return
    }
    let cancelled = false
    setMentionLoading(true)
    const timeout = setTimeout(async () => {
      try {
        const results = await bridge.searchWorkspaceFiles(workspace.id, mentionMatch.query, 30)
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
  }, [workspace?.id, mentionMatch?.query, mentionDismissed])

  const handleSelectSkill = (skill: SkillItem) => {
    setPrompt(`/${skill.name} `)
    setSlashDismissed(false)
    textareaRef.current?.focus()
  }

  const handleSelectFile = (file: WorkspaceFileItem) => {
    if (!textareaRef.current) return
    const cursor = textareaRef.current.selectionStart ?? prompt.length
    const match = getMentionMatch(prompt, cursor)
    if (!match) return

    const beforeAt = prompt.slice(0, match.start)
    const afterCursor = prompt.slice(cursor)
    const insertText = `@${file.path} `
    const nextPrompt = beforeAt + insertText + afterCursor
    const nextCursor = beforeAt.length + insertText.length

    setPrompt(nextPrompt)
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

  const handlePromptChange = (val: string, cursor: number) => {
    setPrompt(val)
    if (val.startsWith('/') && !val.includes(' ')) {
      setSlashDismissed(false)
      setSlashIndex(0)
    }
    checkMention(val, cursor)
  }

  const submit = () => {
    if (prompt.trim() && workspace && models.length > 0) {
      onSubmit(prompt.trim(), mode, permissionMode, modelId || undefined, attachments.map((attachment) => attachment.id))
      setSlashDismissed(false)
      setMentionDismissed(false)
    }
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
    <div className="welcome-view">
      <div className="welcome-hero">
        <div className="hero-orb"><BrandMark size={31} /></div>
        <span className="welcome-kicker">安静的本地工作台</span>
        <h1>从这里开始一项工作</h1>
        <p>交代目标。DeskForge 在本机读取资料、执行操作，并把结果和依据整理好。它是独立项目，不是 WorkBuddy，也不是腾讯的产品。</p>
      </div>
      {!workspace && (
        <div className="inline-notice warning"><Icon name="warning" /><span>开始前需要选择一个工作区。</span><button type="button" onClick={onOpenSettings}>选择工作区</button></div>
      )}
      {models.length === 0 && (
        <div className="inline-notice warning"><Icon name="key" /><span>还没有可用的模型配置。</span><button type="button" onClick={onOpenSettings}>添加模型</button></div>
      )}
      <SubmitForm
        className={`hero-composer ${isDragOver ? 'is-drag-over' : ''}`}
        onSubmit={submit}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="composer-drop-overlay">
            <Icon name="file" size={20} />
            <span>释放文件以添加 @ 引用</span>
          </div>
        )}
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
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => handlePromptChange(event.target.value, event.target.selectionStart)}
          onKeyUp={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              checkMention(event.currentTarget.value, event.currentTarget.selectionStart)
            }
          }}
          onClick={(event) => checkMention(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyDown={handleKeyDown}
          placeholder="描述你想完成的工作（输入 / 调用技能，@ 关联工作区文件，Enter 发送）…"
          rows={4}
        />
        {(mentionedFiles.length > 0 || attachments.length > 0) && (
          <div className="composer-context-chips" aria-label="已关联上下文">
            <span className="context-chips-title">
              <Icon name="layers" size={12} />
              <span>上下文:</span>
            </span>
            {mentionedFiles.map((filePath) => (
              <span key={filePath} className="composer-chip mention-chip" title={`引用工作区文件: ${filePath}`}>
                <Icon name="file" size={12} />
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
                <Icon name="file" size={12} />
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
        {attachmentError && <small className="composer-error">{attachmentError}</small>}
        <div className="composer-toolbar">
          <div className="composer-options">
            <select
              className="access-mode-select permission-mode-select"
              value={permissionMode}
              onChange={(event) => setPermissionMode(event.target.value as RunPermissionMode)}
              aria-label="操作确认方式"
              title="自动处理只放行可撤销的工作区写入和验证命令；删除、敏感文件及外发仍需批准"
            >
              <option value="approval">请求批准</option>
              <option value="workspace_auto">工作区内自动处理</option>
            </select>
            <button
              type="button"
              className="composer-action-btn"
              title="引用工作区文件 (@)"
              onClick={handleTriggerMention}
              disabled={!workspace}
            >
              <span className="action-symbol">@</span>
              <span>引用文件</span>
            </button>
            <button
              type="button"
              className="composer-action-btn"
              title="调用技能 (/)"
              onClick={handleTriggerSlash}
            >
              <Icon name="skill" size={13} />
              <span>技能</span>
            </button>
            <button type="button" className="attachment-button" onClick={async () => {
              try {
                setAttachmentError(undefined)
                const imported = await bridge.importAttachments()
                setAttachments((items) => [
                  ...items,
                  ...imported
                    .filter((next) => !items.some((item) => item.id === next.id))
                    .map((item) => ({ id: item.id, name: item.name })),
                ])
              } catch (error) {
                setAttachmentError(errorMessage(error))
              }
            }}><Icon name="plus" size={14} />附件</button>
            <select value={mode} onChange={(event) => setMode(event.target.value as 'plan' | 'execute')} aria-label="执行模式">
              <option value="execute">直接处理</option>
              <option value="plan">先整理计划</option>
            </select>
            <select value={modelId} onChange={(event) => setModelId(event.target.value)} aria-label="模型">
              {models.length === 0 && <option value="">未配置模型</option>}
              {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.modelId}</option>)}
            </select>
          </div>
          <button className="send-button" type="submit" disabled={!prompt.trim() || !workspace || models.length === 0} aria-label="开始工作">
            <Icon name="arrowRight" size={18} />
          </button>
        </div>
      </SubmitForm>
      <div className="suggestion-grid">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion.text} type="button" onClick={() => setPrompt(suggestion.text)}>
            <Icon name={suggestion.icon} />
            <span>{suggestion.text}</span>
            <Icon name="arrowRight" size={15} />
          </button>
        ))}
      </div>
      <div className="local-trust"><Icon name="lock" size={14} /> 数据与操作留在本机 · 需要你决定时才会打断</div>
    </div>
  )
}
