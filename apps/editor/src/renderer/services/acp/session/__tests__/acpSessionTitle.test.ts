import { describe, expect, it } from 'vitest'
import { observableValue } from '@universe-editor/platform'
import {
  formatWindowTitle,
  resolveLiveSessionTitle,
  truncateSessionTitle,
} from '../acpSessionTitle.js'
import type { IAcpSessionHistoryService } from '../acpSessionHistory.js'
import type { IAcpSession, IAcpSessionService } from '../acpSessionService.js'

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

describe('resolveLiveSessionTitle', () => {
  const makeHistory = (rows: Record<string, string>): IAcpSessionHistoryService =>
    ({ get: (id: string) => (rows[id] ? { title: rows[id] } : undefined) }) as never

  const makeSessions = (
    localId: string,
    agentId: string | undefined,
    lockedTitle: string,
  ): IAcpSessionService => {
    const session = {
      id: localId,
      title: lockedTitle,
      sessionIdOnAgent: observableValue<string | undefined>('sid', agentId),
    } as unknown as IAcpSession
    return { getById: (id: string) => (id === localId ? session : undefined) } as never
  }

  it('resolves the local uuid through sessionIdOnAgent into the history title', () => {
    // 回归保护：tab 用本地 uuid 查询，history 按 agent id 建 key——必须经 live.sessionIdOnAgent 桥接。
    const history = makeHistory({ 'agent-id': 'AI 生成的标题' })
    const sessions = makeSessions('local-uuid', 'agent-id', 'Claude 09:30')
    expect(resolveLiveSessionTitle(history, sessions, 'local-uuid')).toBe('AI 生成的标题')
  })

  it('falls back to the locked live title while still connecting (no agent id yet)', () => {
    const history = makeHistory({})
    const sessions = makeSessions('local-uuid', undefined, 'Claude 09:30')
    expect(resolveLiveSessionTitle(history, sessions, 'local-uuid')).toBe('Claude 09:30')
  })

  it('resolves directly by agent id for resumed sessions', () => {
    const history = makeHistory({ 'agent-id': '历史标题' })
    const sessions = makeSessions('agent-id', 'agent-id', 'Claude 09:30')
    expect(resolveLiveSessionTitle(history, sessions, 'agent-id')).toBe('历史标题')
  })
})
