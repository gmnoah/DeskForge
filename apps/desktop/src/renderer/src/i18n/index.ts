import { useSyncExternalStore } from 'react'
import english from './en-US.json'

export type Locale = 'zh-CN' | 'en-US'
export type TranslationParams = Record<string, string | number | boolean | null | undefined>
const translations: Readonly<Record<string, string>> = english
const listeners = new Set<() => void>()
let locale: Locale = 'zh-CN'

export function normalizeLocale(value: unknown): Locale {
  return typeof value === 'string' && /^en(?:[-_]|$)/i.test(value) ? 'en-US' : 'zh-CN'
}

export function getLocale(): Locale { return locale }

/** The database setting is authoritative; no renderer storage or network is used. */
export function setLocale(value: unknown): void {
  const next = normalizeLocale(value)
  if (typeof document !== 'undefined') document.documentElement.lang = next
  if (next === locale) return
  locale = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale)
}

/** Chinese source strings are stable keys. Unknown text is preserved verbatim. */
export function translate(source: string, language: Locale, params: TranslationParams = {}): string {
  const template = language === 'en-US' ? translations[source] ?? source : source
  return template.replace(/\{(\d+)\}/g, (placeholder, key: string) => {
    const value = params[key]
    return value === undefined || value === null ? placeholder : String(value)
  })
}

export function t(source: string, params?: TranslationParams): string {
  return translate(source, locale, params)
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value)
}
