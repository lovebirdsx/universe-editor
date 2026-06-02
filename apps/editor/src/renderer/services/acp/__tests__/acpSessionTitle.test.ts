import { describe, expect, it } from 'vitest'
import { formatWindowTitle, truncateSessionTitle } from '../acpSessionTitle.js'

describe('truncateSessionTitle', () => {
  it('leaves short titles unchanged', () => {
    expect(truncateSessionTitle('修复登录Bug')).toBe('修复登录Bug')
  })

  it('truncates to 24 chars with an ellipsis', () => {
    const long = 'a'.repeat(40)
    const out = truncateSessionTitle(long)
    expect(out).toHaveLength(24)
    expect(out.endsWith('…')).toBe(true)
    expect(out).toBe(`${'a'.repeat(23)}…`)
  })
})

describe('formatWindowTitle', () => {
  it('returns appName when there is no workspace', () => {
    expect(formatWindowTitle({ appName: 'Universe Editor' })).toBe('Universe Editor')
  })

  it('falls back to "name - parent" without an active session', () => {
    expect(
      formatWindowTitle({
        appName: 'Universe Editor',
        workspaceName: 'universe-editor3',
        parent: 'D:\\git_project',
      }),
    ).toBe('universe-editor3 - D:\\git_project')
  })

  it('appends the session segment (workspace-first, parent dropped)', () => {
    expect(
      formatWindowTitle({
        appName: 'Universe Editor',
        workspaceName: 'universe-editor3',
        parent: 'D:\\git_project',
        symbol: '🟢',
        sessionTitle: '修复登录Bug',
      }),
    ).toBe('universe-editor3 — 🟢 修复登录Bug')
  })

  it('omits the session segment when the symbol is empty (closed)', () => {
    expect(
      formatWindowTitle({
        appName: 'Universe Editor',
        workspaceName: 'universe-editor3',
        parent: 'D:\\git_project',
        symbol: '',
        sessionTitle: '修复登录Bug',
      }),
    ).toBe('universe-editor3 - D:\\git_project')
  })
})
