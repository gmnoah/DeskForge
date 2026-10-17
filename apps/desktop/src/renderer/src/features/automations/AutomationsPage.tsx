import { t, useLocale, getLocale } from '../../i18n'
import { useState } from 'react'
import { Cron } from 'croner'
import { bridge } from '../../bridge'
import { Icon } from '../../icons'
import type { AutomationItem, JsonRecord, WorkbenchSnapshot } from '../../types'
import { EmptyState, Field, IconButton, Modal, PageHeader, SubmitForm, Toggle } from '../../ui'

type Perform = <T>(
  action: () => Promise<T>,
  successTitle?: string,
  options?: { refresh?: boolean; refreshRun?: boolean },
) => Promise<T | undefined>

function formatDate(value?: string, includeDate = false) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(getLocale(), includeDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }).format(date)
}

export function AutomationsPage({ snapshot, workspaceId, perform, onRunCreated }: { snapshot: WorkbenchSnapshot; workspaceId: string | undefined; perform: Perform; onRunCreated: (value: unknown) => void }) {
  useLocale()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [scheduleType, setScheduleType] = useState<'once' | 'interval' | 'cron'>('cron')
  const [scheduleValue, setScheduleValue] = useState('0 9 * * 1-5')
  const defaultModel = snapshot.models.find((model) => model.isDefault) ?? snapshot.models[0]
  const timezone = typeof snapshot.settings.timezone === 'string' ? snapshot.settings.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone
  const schedulePreview = (() => {
    try {
      const reference = new Date()
      if (scheduleType === 'once') {
        const next = new Date(scheduleValue)
        if (!Number.isFinite(next.getTime())) throw new Error(t('请选择有效的运行时间'))
        if (next.getTime() <= reference.getTime()) throw new Error(t('运行时间必须晚于现在'))
        return { normalized: `once:${next.toISOString()}`, next }
      }
      if (scheduleType === 'interval') {
        const minutes = Number(scheduleValue)
        if (!Number.isFinite(minutes) || minutes < 1) throw new Error(t('间隔至少为 1 分钟'))
        const everyMs = Math.max(60_000, Math.round(minutes * 60_000))
        return { normalized: `interval:${everyMs}`, next: new Date(reference.getTime() + everyMs) }
      }
      const expression = scheduleValue.trim().replace(/\s+/g, ' ')
      const next = new Cron(expression, { paused: true, timezone }).nextRun(reference)
      if (!next) throw new Error(t('Cron 表达式没有可计算的下一次运行'))
      return { normalized: `cron:${expression}@${timezone}`, next }
    } catch (error) {
      return { error: error instanceof Error ? error.message : t('无法解析日程') }
    }
  })()
  const save = async () => {
    if (!workspaceId || !defaultModel) return
    let schedule: JsonRecord
    if (scheduleType === 'once') schedule = { type: 'once', runAt: new Date(scheduleValue).toISOString() }
    else if (scheduleType === 'interval') schedule = { type: 'interval', everyMs: Math.max(60_000, Number(scheduleValue) * 60_000) }
    else schedule = { type: 'cron', expression: scheduleValue.trim(), timezone }
    const result = await perform(() => bridge.saveAutomation({
      workspaceId,
      name: name.trim(),
      enabled: true,
      objective: prompt.trim(),
      modelProfileId: defaultModel.id,
      schedule,
    }), t('自动化已保存'))
    if (result !== undefined) { setOpen(false); setName(''); setPrompt('') }
  }
  return (
    <main className="management-page">
      <PageHeader title={t('自动化')} description={t('让重复工作按时间在本机运行；需要你决定的操作仍会暂停。')} action={<button className="button primary" type="button" onClick={() => setOpen(true)} disabled={!workspaceId || !defaultModel}><Icon name="plus" />{t('新建自动化')}</button>} />
      {(!workspaceId || !defaultModel) && <div className="inline-notice warning"><Icon name="warning" /><span>{t('创建自动化前，需要先添加工作区和默认模型。')}</span></div>}
      <div className="automation-list">
        {snapshot.automations.map((automation) => <AutomationRow key={automation.id} automation={automation} perform={perform} onRunCreated={onRunCreated} />)}
      </div>
      {snapshot.automations.length === 0 && <EmptyState icon="clock" title={t('还没有自动化')} description={t('可以按一次时间、固定间隔或 Cron 表达式启动工作。显式退出应用后不会继续运行。')} action={<button type="button" className="button secondary" disabled={!workspaceId || !defaultModel} onClick={() => setOpen(true)}>{t('创建第一个自动化')}</button>} />}
      <Modal open={open} onClose={() => setOpen(false)} title={t('新建自动化')} description={t('所有时间使用 {0}。保存前请确认下一次触发符合预期。', { 0: timezone })}>
        <SubmitForm className="modal-form" onSubmit={() => void save()}>
          <Field label={t('名称')}><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('每日项目健康检查')} autoFocus /></Field>
          <Field label={t('要完成的工作')}><textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t('检查依赖、安全告警和测试状态，并生成可诊断报告。')} /></Field>
          <Field label={t('触发方式')}><div className="segmented-control">{(['once', 'interval', 'cron'] as const).map((type) => <button type="button" key={type} className={scheduleType === type ? 'is-active' : ''} onClick={() => { setScheduleType(type); setScheduleValue(type === 'cron' ? '0 9 * * 1-5' : type === 'interval' ? '60' : new Date(Date.now() + 3600_000).toISOString().slice(0, 16)) }}>{type === 'once' ? t('一次性') : type === 'interval' ? t('固定间隔') : 'Cron'}</button>)}</div></Field>
          {scheduleType === 'once' && <Field label={t('运行时间')}><input type="datetime-local" value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} /></Field>}
          {scheduleType === 'interval' && <Field label={t('间隔（分钟）')}><input type="number" min="1" value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} /></Field>}
          {scheduleType === 'cron' && <Field label={t('Cron 表达式')} hint={t('时区：{0}', { 0: timezone })}><input className="mono" value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} /></Field>}
          <div className={`schedule-preview ${schedulePreview.error ? 'is-error' : ''}`}>
            <span><strong>{t('系统时区')}</strong>{timezone}</span>
            <span><strong>{t('规范化日程')}</strong>{schedulePreview.normalized ?? '—'}</span>
            <span><strong>{t('下次运行')}</strong>{schedulePreview.next ? formatDate(schedulePreview.next.toISOString(), true) : schedulePreview.error}</span>
          </div>
          <div className="modal-actions"><button className="button secondary" type="button" onClick={() => setOpen(false)}>{t('取消')}</button><button className="button primary" type="submit" disabled={!name.trim() || !prompt.trim() || !scheduleValue || Boolean(schedulePreview.error)}>{t('保存自动化')}</button></div>
        </SubmitForm>
      </Modal>
    </main>
  )
}

function AutomationRow({ automation, perform, onRunCreated }: { automation: AutomationItem; perform: Perform; onRunCreated: (value: unknown) => void }) {
  useLocale()
  const runNow = async () => {
    const result = await perform(() => bridge.runAutomation(automation.id), t('自动化已开始运行'))
    if (result !== undefined) onRunCreated(result)
  }
  return (
    <article className="automation-row">
      <div className="automation-icon"><Icon name="clock" /></div>
      <div className="automation-main"><div><h3>{automation.name}</h3><span className={automation.enabled ? 'active-label' : ''}>{automation.enabled ? t('已启用') : t('已暂停')}</span></div><p>{automation.prompt}</p><div className="automation-meta"><span><Icon name="clock" size={13} />{automation.schedule || t('未记录日程')}</span><span>{t('下次：')}{formatDate(automation.nextRunAt, true)}</span>{automation.lastRunAt && <span>{t('上次：')}{formatDate(automation.lastRunAt, true)}</span>}</div></div>
      <div className="automation-controls"><Toggle checked={automation.enabled} label={t('{0} {1}', { 0: automation.enabled ? t('暂停') : t('启用'), 1: automation.name })} onChange={(enabled) => void perform(() => bridge.toggleAutomation(automation.id, enabled), enabled ? t('自动化已启用') : t('自动化已暂停'))} /><IconButton icon="play" label={t('立即运行')} onClick={() => void runNow()} /><IconButton icon="trash" label={t('删除自动化')} onClick={() => void perform(() => bridge.removeAutomation(automation.id), t('自动化已删除'))} /></div>
    </article>
  )
}
