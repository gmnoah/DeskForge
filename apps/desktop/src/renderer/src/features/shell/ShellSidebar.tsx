import { useEffect, useState } from 'react'
import { bridge } from '../../bridge'
import { BrandMark, Icon, type IconName } from '../../icons'
import type { SessionSearchHitItem, ViewKey, WorkbenchSnapshot } from '../../types'
import { IconButton, StatusBadge } from '../../ui'

/** Full-text session search (title + messages) with a debounce; falls back to title filtering. */
function useSessionSearch(query: string, workspaceId: string | undefined): { hits: SessionSearchHitItem[] | undefined; searching: boolean } {
  const [state, setState] = useState<{ key: string; hits: SessionSearchHitItem[] | undefined }>({ key: '', hits: undefined })
  const trimmed = query.trim()
  const key = `${workspaceId ?? ''}\u0000${trimmed}`
  useEffect(() => {
    if (!trimmed) return undefined
    let cancelled = false
    const timer = window.setTimeout(() => {
      bridge.searchRuns(trimmed, workspaceId)
        .then((hits) => { if (!cancelled) setState({ key, hits }) })
        .catch(() => { if (!cancelled) setState({ key, hits: undefined }) })
    }, 220)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [key, trimmed, workspaceId])
  if (!trimmed) return { hits: undefined, searching: false }
  return { hits: state.key === key ? state.hits : undefined, searching: state.key !== key }
}

const NAV_ITEMS: Array<{ id: ViewKey; label: string; icon: IconName }> = [
  { id: 'tasks', label: '工作', icon: 'tasks' },
  { id: 'automations', label: '自动化', icon: 'clock' },
]

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export interface ShellSidebarProps {
  view: ViewKey
  onView: (view: ViewKey) => void
  snapshot: WorkbenchSnapshot
  selectedWorkspaceId: string | undefined
  onWorkspace: (id: string) => void
  selectedRunId: string | undefined
  onRun: (id: string) => void
  onNewTask: () => void
  search: string
  onSearch: (value: string) => void
  refreshing: boolean
  onRefresh: () => void
  onHide: () => void
  onOpenCommandPalette?: (() => void) | undefined
  resolvedTheme?: 'light' | 'dark' | undefined
  onToggleTheme?: (() => void) | undefined
  onRenameRun?: ((runId: string, currentTitle: string) => void) | undefined
  onDeleteRun?: ((runId: string) => void) | undefined
}

interface RunGroup {
  label: string
  runs: WorkbenchSnapshot['runs']
}

function groupRunsByDate(runs: WorkbenchSnapshot['runs']): RunGroup[] {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  const weekStart = todayStart - 6 * 86400000

  const today: WorkbenchSnapshot['runs'] = []
  const yesterday: WorkbenchSnapshot['runs'] = []
  const thisWeek: WorkbenchSnapshot['runs'] = []
  const older: WorkbenchSnapshot['runs'] = []

  for (const run of runs) {
    const timestamp = Date.parse(run.updatedAt ?? run.createdAt ?? '')
    if (Number.isNaN(timestamp)) {
      older.push(run)
    } else if (timestamp >= todayStart) {
      today.push(run)
    } else if (timestamp >= yesterdayStart) {
      yesterday.push(run)
    } else if (timestamp >= weekStart) {
      thisWeek.push(run)
    } else {
      older.push(run)
    }
  }

  const groups: RunGroup[] = []
  if (today.length) groups.push({ label: '今天', runs: today })
  if (yesterday.length) groups.push({ label: '昨天', runs: yesterday })
  if (thisWeek.length) groups.push({ label: '近 7 天', runs: thisWeek })
  if (older.length) groups.push({ label: '更早', runs: older })
  return groups
}

export function ShellSidebar({
  view,
  onView,
  snapshot,
  selectedWorkspaceId,
  onWorkspace,
  selectedRunId,
  onRun,
  onNewTask,
  search,
  onSearch,
  refreshing,
  onRefresh,
  onHide,
  onOpenCommandPalette,
  resolvedTheme,
  onToggleTheme,
  onRenameRun,
  onDeleteRun,
}: ShellSidebarProps) {
  const { hits, searching } = useSessionSearch(search, selectedWorkspaceId)
  const runs = snapshot.runs.filter((run) => {
    const inWorkspace = !selectedWorkspaceId || run.workspaceId === selectedWorkspaceId
    const matches = !search || run.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    return inWorkspace && matches
  })
  const showHits = Boolean(search.trim()) && hits !== undefined

  return (
    <aside className="sidebar">
      <div className="titlebar-drag sidebar-titlebar" aria-hidden="true" />
      <div className="brand-row">
        <div className="brand-mark"><BrandMark size={20} /></div>
        <div className="brand-copy"><strong>DeskForge</strong><span className="brand-tag">STUDIO FORGE</span></div>
        <IconButton icon="panelRight" label="隐藏侧栏" onClick={onHide} />
      </div>

      <div className="workspace-select-wrap">
        <Icon name="folder" size={15} />
        <select
          value={selectedWorkspaceId ?? ''}
          onChange={(event) => onWorkspace(event.target.value)}
          aria-label="当前工作区"
        >
          {snapshot.workspaces.length === 0 && <option value="">尚未挂载工作区</option>}
          {snapshot.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        <Icon name="chevronDown" size={13} />
      </div>

      <button className="new-task-button" type="button" onClick={onNewTask}>
        <Icon name="plus" size={16} />
        <span>发起新任务</span>
        <kbd>⌘N</kbd>
      </button>

      <nav className="primary-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <button key={item.id} type="button" className={view === item.id ? 'is-active' : ''} onClick={() => onView(item.id)}>
            <Icon name={item.icon} size={17} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />
      <div className="task-list-header">
        <span>最近</span>
        <div>
          <IconButton icon="refresh" label="刷新工作台" className={refreshing ? 'is-spinning' : ''} onClick={onRefresh} />
          <IconButton
            icon="search"
            label="命令面板与搜索 (⌘K)"
            onClick={() => {
              if (onOpenCommandPalette) onOpenCommandPalette()
              else document.getElementById('run-search')?.focus()
            }}
          />
        </div>
      </div>
      <div className="run-search-wrap">
        <Icon name="search" size={14} />
        <input id="run-search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索会话标题和内容" aria-label="搜索会话" />
        {search && <button type="button" aria-label="清除搜索" onClick={() => onSearch('')}><Icon name="x" size={13} /></button>}
      </div>
      <div className="task-list">
        {showHits && hits!.map((hit) => (
          <button
            type="button"
            key={hit.runId}
            className={`task-list-item session-hit ${view === 'tasks' && selectedRunId === hit.runId ? 'is-active' : ''}`}
            onClick={() => { onRun(hit.runId); onView('tasks') }}
          >
            <StatusBadge status={hit.status} compact />
            <span className="task-list-copy">
              <strong>{hit.title}</strong>
              <small className="session-hit-snippet"><em>{hit.matchedIn === 'title' ? '标题' : '内容'}</em>{hit.matchedIn === 'title' ? formatDate(hit.updatedAt) : hit.snippet}</small>
            </span>
          </button>
        ))}
        {showHits && hits!.length === 0 && <div className="sidebar-empty">没有匹配的会话</div>}
        {!showHits && groupRunsByDate(runs).map((group) => (
          <div key={group.label} className="task-group">
            <div className="task-group-title">{group.label}</div>
            {group.runs.map((run) => (
              <div
                key={run.id}
                role="button"
                tabIndex={0}
                className={`task-list-item ${view === 'tasks' && selectedRunId === run.id ? 'is-active' : ''}`}
                onClick={() => { onRun(run.id); onView('tasks') }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRun(run.id); onView('tasks') } }}
              >
                <StatusBadge status={run.status} compact />
                <span className="task-list-copy">
                  <strong>{run.title}</strong>
                  <small>{formatDate(run.updatedAt ?? run.createdAt)}</small>
                </span>
                {run.status === 'waiting_approval' && <span className="attention-dot" />}
                {(onRenameRun || onDeleteRun) && (
                  <div className="task-list-item-actions" onClick={(e) => e.stopPropagation()}>
                    {onRenameRun && (
                      <button
                        type="button"
                        className="task-action-btn"
                        title="重命名会话"
                        aria-label="重命名会话"
                        onClick={(e) => { e.stopPropagation(); onRenameRun(run.id, run.title) }}
                      >
                        <Icon name="edit" size={13} />
                      </button>
                    )}
                    {onDeleteRun && (
                      <button
                        type="button"
                        className="task-action-btn danger"
                        title="删除会话"
                        aria-label="删除会话"
                        onClick={(e) => { e.stopPropagation(); onDeleteRun(run.id) }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {!showHits && runs.length === 0 && <div className="sidebar-empty">{search ? (searching ? '正在搜索…' : '没有匹配的工作') : '最近工作会显示在这里'}</div>}
      </div>

      <div className="sidebar-footer">
        <button type="button" className={['memory', 'mcp', 'skills'].includes(view) ? 'is-active' : ''} onClick={() => onView('memory')}>
          <Icon name="layers" size={17} /><span>资料库</span>
          {snapshot.memory.some((memory) => memory.status === 'proposed') && <em className="nav-count">{snapshot.memory.filter((memory) => memory.status === 'proposed').length}</em>}
        </button>
        <div className="sidebar-footer-row">
          <button type="button" className={`sidebar-footer-nav-btn ${view === 'settings' ? 'is-active' : ''}`} onClick={() => onView('settings')}>
            <Icon name="settings" size={17} /><span>设置</span>
          </button>
          {onToggleTheme && (
            <button
              type="button"
              className="sidebar-theme-toggle"
              aria-label={resolvedTheme === 'dark' ? '切换为浅色模式' : '切换为深色模式'}
              title={resolvedTheme === 'dark' ? '切换为浅色模式 (⌘⇧L)' : '切换为深色模式 (⌘⇧L)'}
              onClick={onToggleTheme}
            >
              <Icon name={resolvedTheme === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
