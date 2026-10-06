import { describe, expect, it } from 'vitest'
import { chainStatus, EMPTY_AUDIT_FILTERS, toAuditFilters } from './audit-view'

const chain = { valid: true, checkedEntries: 10, hashedEntries: 9, legacyEntries: 1, brokenIds: [], linkBreakIds: [], checkedAt: '2026-10-06T09:00:00.000Z' }

describe('audit view helpers', () => {
  it('maps the filter form to IPC filters, dropping empty values', () => {
    expect(toAuditFilters(EMPTY_AUDIT_FILTERS)).toEqual({ limit: 500 })
    const filters = toAuditFilters({ runId: 'run-1', category: 'approval', outcome: 'auto_approved', from: '2026-10-06T08:00', to: 'invalid', text: '  npm  ' }, 100)
    expect(filters).toMatchObject({ limit: 100, runId: 'run-1', category: 'approval', outcome: 'auto_approved', text: 'npm' })
    expect(filters.from).toMatch(/^2026-10-06T\d\d:00:00\.000Z$/)
    expect(filters.to).toBeUndefined()
  })

  it('summarizes chain verification states', () => {
    expect(chainStatus(chain)).toMatchObject({ tone: 'ok', title: '哈希链校验通过' })
    expect(chainStatus({ ...chain, linkBreakIds: ['4'] }).tone).toBe('warning')
    expect(chainStatus({ ...chain, valid: false, brokenIds: ['2', '3'] })).toMatchObject({ tone: 'danger', title: '哈希链校验失败：2 条记录内容与签名不符' })
  })
})
