import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../icons'
import type { RunItem, SkillItem, WorkspaceItem } from '../../types'

export interface PaletteItem {
  id: string
  category: 'action' | 'run' | 'workspace' | 'skill'
  categoryLabel: string
  label: string
  sublabel?: string
  icon: IconName
  action: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  runs: RunItem[]
  workspaces: WorkspaceItem[]
  currentWorkspaceId?: string | undefined
  skills: SkillItem[]
  onSelectRun: (runId: string) => void
  onSelectWorkspace: (workspaceId: string) => void
  onNewRun: () => void
  onOpenSettings: () => void
  onToggleSidebar: () => void
}

export function CommandPalette({
  open,
  onClose,
  runs,
  workspaces,
  currentWorkspaceId,
  skills,
  onSelectRun,
  onSelectWorkspace,
  onNewRun,
  onOpenSettings,
  onToggleSidebar,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      const frame = requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
      return () => cancelAnimationFrame(frame)
    }
    return undefined
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase()

    const actionItems: PaletteItem[] = [
      {
        id: 'action-new-run',
        category: 'action',
        categoryLabel: '快捷指令',
        label: '新建工作会话',
        sublabel: '开始一项新的本地工作 (⌘N)',
        icon: 'plus',
        action: () => {
          onClose()
          onNewRun()
        },
      },
      {
        id: 'action-settings',
        category: 'action',
        categoryLabel: '快捷指令',
        label: '设置与偏好',
        sublabel: '配置模型密钥与工作区权限 (⌘,)',
        icon: 'settings',
        action: () => {
          onClose()
          onOpenSettings()
        },
      },
      {
        id: 'action-sidebar',
        category: 'action',
        categoryLabel: '快捷指令',
        label: '切换侧边栏',
        sublabel: '显示或收起会话导航栏 (⌘\\)',
        icon: 'panelRight',
        action: () => {
          onClose()
          onToggleSidebar()
        },
      },
    ]

    const runItems: PaletteItem[] = runs.map((run) => ({
      id: `run-${run.id}`,
      category: 'run',
      categoryLabel: '工作会话',
      label: run.title || '未命名工单',
      sublabel: run.status === 'completed' ? '已完成' : run.status === 'running' ? '进行中' : '会话记录',
      icon: 'file',
      action: () => {
        onClose()
        onSelectRun(run.id)
      },
    }))

    const workspaceItems: PaletteItem[] = workspaces.map((ws) => ({
      id: `ws-${ws.id}`,
      category: 'workspace',
      categoryLabel: '切换工作区',
      label: ws.name,
      sublabel: ws.path + (ws.id === currentWorkspaceId ? ' (当前)' : ''),
      icon: 'folder',
      action: () => {
        onClose()
        onSelectWorkspace(ws.id)
      },
    }))

    const skillItems: PaletteItem[] = skills
      .filter((s) => s.enabled !== false)
      .map((skill) => ({
        id: `skill-${skill.name}`,
        category: 'skill',
        categoryLabel: '技能扩展',
        label: `/${skill.name}`,
        sublabel: skill.description || '本地或全局技能',
        icon: 'skill',
        action: () => {
          onClose()
          onNewRun()
        },
      }))

    if (!q) {
      return [
        ...actionItems,
        ...runItems.slice(0, 5),
        ...workspaceItems,
        ...skillItems.slice(0, 4),
      ]
    }

    const filteredActions = actionItems.filter(
      (item) => item.label.toLowerCase().includes(q) || item.sublabel?.toLowerCase().includes(q),
    )
    const filteredRuns = runItems.filter(
      (item) => item.label.toLowerCase().includes(q) || item.sublabel?.toLowerCase().includes(q),
    )
    const filteredWorkspaces = workspaceItems.filter(
      (item) => item.label.toLowerCase().includes(q) || item.sublabel?.toLowerCase().includes(q),
    )
    const filteredSkills = skillItems.filter(
      (item) => item.label.toLowerCase().includes(q) || item.sublabel?.toLowerCase().includes(q),
    )

    return [...filteredActions, ...filteredRuns, ...filteredWorkspaces, ...filteredSkills]
  }, [query, runs, workspaces, currentWorkspaceId, skills, onClose, onNewRun, onOpenSettings, onToggleSidebar, onSelectRun, onSelectWorkspace])

  useEffect(() => {
    setSelectedIndex(0)
  }, [items.length])

  useEffect(() => {
    if (!listRef.current) return
    const activeEl = listRef.current.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((prev) => (items.length > 0 ? (prev + 1) % items.length : 0))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((prev) => (items.length > 0 ? (prev - 1 + items.length) % items.length : 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const selected = items[selectedIndex]
      if (selected) {
        selected.action()
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
  }

  if (!open) return null

  return (
    <div className="modal-backdrop command-palette-backdrop" role="presentation" onClick={onClose}>
      <section
        className="command-palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="快速操作命令面板"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="command-palette-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索操作、会话、工作区或技能 (⌘K / Esc 退出)…"
            aria-label="搜索命令"
          />
          {query && (
            <button
              type="button"
              className="command-palette-clear"
              onClick={() => setQuery('')}
              aria-label="清除搜索"
            >
              ×
            </button>
          )}
        </div>

        <div className="command-palette-list" ref={listRef} role="listbox">
          {items.length === 0 ? (
            <div className="command-palette-empty">没有找到匹配的结果</div>
          ) : (
            items.map((item, index) => {
              const isSelected = index === selectedIndex
              const isFirstInCategory = index === 0 || items[index - 1]?.category !== item.category
              return (
                <div key={item.id}>
                  {isFirstInCategory && (
                    <div className="command-palette-group-title">
                      {item.categoryLabel}
                    </div>
                  )}
                  <button
                    type="button"
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    className={`command-palette-item${isSelected ? ' is-selected' : ''}`}
                    onClick={() => item.action()}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className="palette-item-icon">
                      <Icon name={item.icon} size={15} />
                    </span>
                    <span className="palette-item-text">
                      <span className="palette-item-label">{item.label}</span>
                      {item.sublabel && <span className="palette-item-sublabel">{item.sublabel}</span>}
                    </span>
                    {isSelected && <span className="palette-item-shortcut">↵ 执行</span>}
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="command-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 浏览</span>
          <span><kbd>↵</kbd> 选择</span>
          <span><kbd>esc</kbd> 关闭</span>
        </div>
      </section>
    </div>
  )
}
