import { useEffect, useRef } from 'react'
import { Icon } from '../../icons'
import type { WorkspaceFileItem } from '../../types'

export interface FileMentionMenuProps {
  files: WorkspaceFileItem[]
  query: string
  selectedIndex: number
  loading?: boolean | undefined
  onSelect: (file: WorkspaceFileItem) => void
}

function getFileBadge(file: WorkspaceFileItem): string {
  if (file.isDirectory) return 'DIR'
  if (file.extension) return file.extension.slice(0, 4).toUpperCase()
  return 'FILE'
}

export function FileMentionMenu({
  files,
  query,
  selectedIndex,
  loading = false,
  onSelect,
}: FileMentionMenuProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!listRef.current) return
    const activeItem = listRef.current.querySelector<HTMLElement>('.file-mention-item.is-selected')
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  return (
    <div className="file-mention-menu" role="listbox" aria-label="工作区文件引用">
      <div className="file-mention-header">
        <span className="file-mention-title">
          <Icon name="folder" size={13} />
          <span>引用当前工作区文件</span>
        </span>
        <small className="file-mention-count">
          {loading ? '搜索中…' : `${files.length} 个结果`}
        </small>
      </div>

      <div className="file-mention-list" ref={listRef}>
        {files.length === 0 ? (
          <div className="file-mention-empty">
            {loading ? '正在搜索工作区文件…' : query ? `未找到与 “${query}” 匹配的文件` : '工作区内暂无文件'}
          </div>
        ) : (
          files.map((file, index) => {
            const isSelected = index === selectedIndex
            const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''

            return (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`file-mention-item ${isSelected ? 'is-selected' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  onSelect(file)
                }}
              >
                <div className="file-mention-main">
                  <span className="file-mention-badge">
                    {getFileBadge(file)}
                  </span>
                  <span className="file-mention-name">{file.name}</span>
                </div>
                {dir && <span className="file-mention-path" title={dir}>{dir}</span>}
              </button>
            )
          })
        )}
      </div>

      <div className="file-mention-footer">
        <span>↑↓ 选择</span>
        <span>↵ / Tab 补全</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  )
}
