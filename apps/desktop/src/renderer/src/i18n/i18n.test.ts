import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import english from './en-US.json'
import { getLocale, normalizeLocale, setLocale, t, translate } from './index'
import { localizeModelError } from './model-errors'
import { MODEL_PROVIDER_META } from '../features/settings/model-meta'
import { normalizeSessionHit } from '../bridge'

afterEach(() => setLocale('zh-CN'))

describe('interface localization', () => {
  it('supports legacy locales, Chinese defaults and exact unknown-text fallback', () => {
    expect(normalizeLocale('en-GB')).toBe('en-US')
    expect(normalizeLocale('zh-Hans')).toBe('zh-CN')
    expect(normalizeLocale(undefined)).toBe('zh-CN')
    setLocale('en-US')
    expect(getLocale()).toBe('en-US')
    expect(t('设置')).toBe('Settings')
    expect(t('用户自定义内容 {0}')).toBe('用户自定义内容 {0}')
    expect(normalizeSessionHit({ runId: 'fixture', title: '我的项目' }).title).toBe('我的项目')
  })

  it('interpolates reordered values without recursively replacing user content', () => {
    expect(translate('移除附件 {0}', 'en-US', { 0: '用户内容 {1}' })).toBe('Remove attachment 用户内容 {1}')
    expect(translate('移除附件 {0}', 'zh-CN', { 0: 'report.pdf' })).toBe('移除附件 report.pdf')
    expect(translate('移除附件 {0}', 'en-US')).toBe('Remove attachment {0}')
  })

  it('localizes classified model errors while preserving unknown diagnostics', () => {
    const error = { code: 'MODEL_AUTH_FAILED', message: '原始错误', suggestedAction: '原始建议' }
    expect(localizeModelError(error).message).toBe('原始错误')
    setLocale('en-US')
    expect(localizeModelError(error).message).toBe('The model provider rejected the API key.')
    expect(localizeModelError({ code: 'UNKNOWN', message: 'provider raw detail' }).message).toBe('provider raw detail')
    expect(error.message).toBe('原始错误')
  })

  it('updates static label maps after multiple language changes', () => {
    expect(MODEL_PROVIDER_META.custom.name).toBe('自定义')
    setLocale('en-US')
    expect(MODEL_PROVIDER_META.custom.name).toBe('Custom')
    setLocale('zh-CN')
    expect(MODEL_PROVIDER_META.custom.name).toBe('自定义')
  })

  it('keeps all placeholders and covers every literal translation call', () => {
    const dictionary: Record<string, string> = english
    const parameters = (value: string) => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort()
    for (const [key, value] of Object.entries(dictionary)) {
      expect(value.trim(), key).not.toBe('')
      expect(parameters(value), key).toEqual(parameters(key))
    }
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    function check(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory() && entry.name !== 'i18n') check(path)
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
          function visit(node: ts.Node): void {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
              const key = node.arguments[0]
              if (key && ts.isStringLiteral(key)) expect(dictionary[key.text], `${path}: ${key.text}`).toBeDefined()
            }
            ts.forEachChild(node, visit)
          }
          visit(source)
        }
      }
    }
    check(root)
  })
})
