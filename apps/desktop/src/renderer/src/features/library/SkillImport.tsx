import { t, useLocale } from '../../i18n'
import { useState } from 'react'
import { Icon } from '../../icons'
import type { SkillImportPreviewItem, SkillOrigin } from '../../types'
import { Field, Modal, Spinner, SubmitForm } from '../../ui'

const FILE_KIND_LABELS = { get entry() { return t('说明') }, get script() { return t('脚本') }, get reference() { return t('参考') }, get asset() { return t('资源') } } as const

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function skillOriginLabel(origin: SkillOrigin | undefined, fallback?: string): string {
  if (!origin) return fallback ? t('本地 · {0}', { 0: fallback }) : t('本地 Skill')
  if (origin.kind === 'bundled') return t('DeskForge 内置')
  if (origin.kind === 'folder') return t('文件夹 · {0}', { 0: origin.path ?? fallback ?? '' })
  const ref = origin.ref ? `@${origin.ref}` : ''
  const subpath = origin.subpath ? ` / ${origin.subpath}` : ''
  const commit = origin.commit ? ` · ${origin.commit.slice(0, 7)}` : ''
  return `Git · ${origin.url ?? ''}${ref}${subpath}${commit}`
}

export function SkillGitImportModal({ open, busy, onClose, onSubmit }: {
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (input: { url: string; ref?: string; subpath?: string }) => void
}) {
  useLocale()
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subpath, setSubpath] = useState('')
  return (
    <Modal open={open} onClose={onClose} title={t('从 Git 仓库导入 Skill')} description={t('只支持公开的 https:// 仓库。DeskForge 会浅克隆到临时目录，不运行仓库中的任何脚本或 Git 钩子，确认前不会安装。')}>
      <SubmitForm className="modal-form" onSubmit={() => { if (url.trim()) onSubmit({ url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}), ...(subpath.trim() ? { subpath: subpath.trim() } : {}) }) }}>
        <Field label={t('仓库地址')}><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/skills" autoFocus /></Field>
        <div className="field-row">
          <Field label={t('分支或标签')} hint={t('可选，默认使用仓库默认分支')}><input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" /></Field>
          <Field label={t('子目录')} hint={t('可选，SKILL.md 所在的仓库内目录')}><input value={subpath} onChange={(event) => setSubpath(event.target.value)} placeholder="skills/weekly-report" /></Field>
        </div>
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>{t('取消')}</button><button type="submit" className="button primary" disabled={!url.trim() || busy}>{busy ? <Spinner size={13} /> : <Icon name="download" size={14} />}{t('获取并预览')}</button></div>
      </SubmitForm>
    </Modal>
  )
}

export function SkillImportPreviewModal({ preview, busy, onCancel, onConfirm }: {
  preview: SkillImportPreviewItem | undefined
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  useLocale()
  if (!preview) return null
  return (
    <Modal open onClose={onCancel} title={preview.replaces ? t('更新 Skill：{0}', { 0: preview.name }) : t('安装 Skill：{0}', { 0: preview.name })} description={t('请确认以下内容。安装只复制文件，不会执行其中的脚本。')} wide>
      <div className="skill-preview">
        <div className="skill-preview-summary">
          <div><span>{t('名称')}</span><strong>{preview.name}</strong></div>
          <div><span>{t('版本')}</span><strong>{preview.replaces ? `v${preview.replaces.version} → v${preview.version}` : `v${preview.version}`}</strong></div>
          <div><span>{t('文件')}</span><strong>{preview.fileCount}{t('个 ·')}{formatBytes(preview.totalBytes)}</strong></div>
          <div><span>{t('来源')}</span><strong className="skill-preview-origin">{skillOriginLabel(preview.origin)}</strong></div>
        </div>
        <p className="skill-preview-description">{preview.description}</p>
        <div className="permission-chips">{preview.permissions.length ? preview.permissions.map((permission) => <span key={permission}>{permission}</span>) : <span>{t('无额外权限声明')}</span>}</div>
        {preview.warnings.length > 0 && <ul className="skill-preview-warnings">{preview.warnings.map((warning) => <li key={warning}><Icon name="warning" size={13} />{warning}</li>)}</ul>}
        <details className="skill-preview-section" open>
          <summary>{t('将安装的文件')}</summary>
          <ul className="skill-preview-files">
            {preview.files.map((file) => <li key={file.path} className={file.kind === 'script' ? 'is-script' : ''}><code>{file.path}</code><span>{FILE_KIND_LABELS[file.kind]}</span><small>{formatBytes(file.size)}</small></li>)}
            {preview.fileCount > preview.files.length && <li><span>{t('另有')}{preview.fileCount - preview.files.length}{t('个文件未列出')}</span></li>}
          </ul>
        </details>
        <details className="skill-preview-section">
          <summary>{t('SKILL.md 正文预览')}</summary>
          <pre>{preview.instructionsPreview}</pre>
        </details>
      </div>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onCancel}>{t('取消')}</button><button type="button" className="button primary" disabled={busy} onClick={onConfirm}>{busy ? <Spinner size={13} /> : <Icon name="check" size={14} />}{preview.replaces ? t('确认更新') : t('确认安装')}</button></div>
    </Modal>
  )
}
