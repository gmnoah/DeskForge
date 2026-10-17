import { localizeModelError } from '../../i18n/model-errors'
import { t } from '../../i18n'
import type { JsonRecord } from '../../types'

export interface ConnectionTestView {
  tone: 'success' | 'error'
  title: string
  detail?: string
  suggestion?: string
  technical?: string
  notice?: string
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Present a models:test(-draft) result in the selected interface language. */
export function describeConnectionTest(result: unknown): ConnectionTestView {
  const source = result && typeof result === 'object' ? result as JsonRecord : {}
  const latency = typeof source.latencyMs === 'number' ? `${Math.max(0, Math.round(source.latencyMs))} ms` : undefined
  const modelId = text(source.modelId)
  if (source.ok === true) {
    const notice = text(source.notice)
    return {
      tone: 'success',
      title: t('连接成功'),
      detail: [modelId ? t('模型 {0} 可用', { 0: modelId }) : t('模型可用'), latency ? t('耗时 {0}', { 0: latency }) : undefined].filter(Boolean).join(' · '),
      ...(notice ? { notice } : {}),
    }
  }
  const error = source.error && typeof source.error === 'object' ? source.error as JsonRecord : {}
  const details = error.details && typeof error.details === 'object' ? error.details as JsonRecord : {}
  const localized = localizeModelError(error)
  const suggestion = text(localized.suggestion)
  const technical = text(details.raw)
  return {
    tone: 'error',
    title: text(localized.message) ?? t('连接测试失败'),
    ...(suggestion ? { suggestion } : {}),
    ...(technical ? { technical } : {}),
  }
}

/** A thrown error (e.g. missing key) rendered with the same shape. */
export function connectionTestFailure(error: unknown): ConnectionTestView {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return { tone: 'error', title: message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || t('连接测试失败') }
}
