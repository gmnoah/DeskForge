import { useEffect, useRef } from 'react'
import { Icon } from '../../icons'
import type { SkillItem } from '../../types'

export interface SlashCommandMenuProps {
  skills: SkillItem[]
  query: string
  selectedIndex: number
  onSelect: (skill: SkillItem) => void
}

export function SlashCommandMenu({ skills, query, selectedIndex, onSelect }: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null)

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = skills.filter((skill) => {
    if (skill.enabled === false) return false
    if (!normalizedQuery) return true
    return (
      skill.name.toLowerCase().includes(normalizedQuery) ||
      (skill.description && skill.description.toLowerCase().includes(normalizedQuery))
    )
  })

  useEffect(() => {
    if (!listRef.current) return
    const activeItem = listRef.current.querySelector<HTMLElement>('.slash-menu-item.is-selected')
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (filtered.length === 0) return null

  return (
    <div className="slash-command-menu" role="listbox" aria-label="可用 Skills">
      <div className="slash-menu-header">
        <span className="slash-menu-title">
          <Icon name="skill" size={13} />
          <span>调用全局 / 本地技能</span>
        </span>
        <small className="slash-menu-count">{filtered.length} 个可用</small>
      </div>
      <div className="slash-menu-list" ref={listRef}>
        {filtered.map((skill, index) => {
          const isSelected = index === selectedIndex
          return (
            <button
              key={skill.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={`slash-menu-item ${isSelected ? 'is-selected' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(skill)
              }}
            >
              <div className="slash-menu-row">
                <span className="slash-menu-cmd">/{skill.name}</span>
                {skill.version && <span className="slash-menu-version">v{skill.version}</span>}
              </div>
              {skill.description && <p className="slash-menu-desc">{skill.description}</p>}
            </button>
          )
        })}
      </div>
      <div className="slash-menu-footer">
        <span>↑↓ 选择</span>
        <span>↵ 补全</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  )
}
