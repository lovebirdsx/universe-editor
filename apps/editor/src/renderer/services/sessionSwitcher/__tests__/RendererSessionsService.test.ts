/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Event,
  GroupDirection,
  InstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  ServiceCollection,
  observableValue,
  type IEditorGroup,
  type IInstantiationService,
} from '@universe-editor/platform'
import { RendererSessionsService } from '../RendererSessionsService.js'
import { FakeWindowFocusService } from '../../windows/testing/fakeWindowFocusService.js'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../../acp/session/acpSessionHistory.js'
import { AcpSessionEditorInput } from '../../acp/session/acpSessionEditorInput.js'
import { revealSessionEditorTab } from '../../acp/session/revealSessionEditorTab.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../acp/session/acpSessionService.js'
import type { AcpSessionStatus } from '../../acp/session/acpSession.js'
import {
  IAcpChatWidgetService,
  type IAcpChatWidgetService as IAcpChatWidgetServiceType,
} from '../../acp/session/acpChatWidgetService.js'

class FakeSessionService {
  declare readonly _serviceBrand: undefined
  readonly sessions = observableValue<readonly IAcpSession[]>('test.sessions', [])
  readonly activeSessionId = observableValue<string | undefined>('test.activeSessionId', undefined)
  readonly activeSession = observableValue<IAcpSession | undefined>('test.activeSession', undefined)
  readonly onDidCloseSession = Event.None
  readonly setActive = vi.fn((sessionId: string) => {
    const session = this.getById(sessionId)
    if (!session) return
    this.activeSessionId.set(session.id, undefined)
    this.activeSession.set(session, undefined)
  })

  private readonly _sessions = new Map<string, IAcpSession>()

  add(session: IAcpSession): void {
    this._sessions.set(session.id, session)
    this.sessions.set([...this._sessions.values()], undefined)
  }

  createSession(): Promise<IAcpSession> {
    throw new Error('not implemented')
  }
  resumeSession(): Promise<IAcpSession> {
    throw new Error('not implemented')
  }
  closeSession(): Promise<void> {
    throw new Error('not implemented')
  }
  getById(sessionId: string): IAcpSession | undefined {
    const direct = this._sessions.get(sessionId)
    if (direct) return direct
    // Mirrors AcpSessionService._findSession: both the local id and the
    // agent-issued id resolve to the same session.
    for (const session of this._sessions.values()) {
      if (session.sessionIdOnAgent.get() === sessionId) return session
    }
    return undefined
  }
  tryRestoreActiveSession(): Promise<void> {
    return Promise.resolve()
  }
  requestHydrateIfNeeded(): void {}
  refreshSessions(): Promise<void> {
    return Promise.resolve()
  }
  deleteOnAgent(): Promise<'ok'> {
    return Promise.resolve('ok')
  }
}

class FakeChatWidgetService {
  declare readonly _serviceBrand: undefined
  readonly lastFocusedWidget = undefined
  readonly focusSessionInput = vi.fn(() => true)
  readonly focusSession = vi.fn(() => true)
  register(): never {
    throw new Error('not implemented')
  }
}

function makeHistory(
  initial: readonly AcpSessionHistoryEntry[] = [],
): IAcpSessionHistoryServiceType {
  const entries = observableValue<readonly AcpSessionHistoryEntry[]>('test.history', initial)
  return {
    _serviceBrand: undefined,
    entries,
    get: (id: string) => entries.get().find((entry) => entry.id === id),
    list: () => entries.get(),
    initialize: () => Promise.resolve(),
  } as unknown as IAcpSessionHistoryServiceType
}

function makeHistoryEntry(
  id: string,
  overrides: Partial<AcpSessionHistoryEntry> = {},
): AcpSessionHistoryEntry {
  return {
    id,
    agentId: 'fake',
    sessionIdOnAgent: id,
    title: `History ${id}`,
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  }
}

function makeSession(
  id: string,
  opts: {
    agentId?: string
    status?: AcpSessionStatus
    dormant?: boolean
    /** `null` = the handshake has not issued a durable id yet. */
    durableId?: string | null
  } = {},
): IAcpSession {
  const durableId = opts.durableId === null ? undefined : (opts.durableId ?? id)
  return {
    id,
    agentId: opts.agentId ?? 'fake',
    title: `Session ${id}`,
    status: observableValue<AcpSessionStatus>('test.status', opts.status ?? 'idle'),
    isDormant: observableValue<boolean>('test.dormant', opts.dormant ?? false),
    pendingElicitation: observableValue<unknown>('test.elicitation', undefined),
    pendingPermission: observableValue<unknown>('test.permission', undefined),
    backgroundTaskCount: observableValue<number>('test.btc', 0),
    sessionIdOnAgent: observableValue<string | undefined>('test.sid', durableId),
    ensureAwake: vi.fn(() => Promise.resolve('ready')),
  } as unknown as IAcpSession
}

interface Harness {
  svc: RendererSessionsService
  sessions: FakeSessionService
  history: IAcpSessionHistoryServiceType
  groups: EditorGroupsService
  widgets: FakeChatWidgetService
  instantiation: IInstantiationService
}

function makeHarness(historyEntries: readonly AcpSessionHistoryEntry[] = []): Harness {
  const sessions = new FakeSessionService()
  const history = makeHistory(historyEntries)
  const groups = new EditorGroupsService()
  const widgets = new FakeChatWidgetService()
  const services = new ServiceCollection()
  services.set(IAcpSessionService, sessions as unknown as IAcpSessionServiceType)
  services.set(IAcpSessionHistoryService, history)
  services.set(IAcpChatWidgetService, widgets as unknown as IAcpChatWidgetServiceType)
  services.set(IWorkspaceService, {
    _serviceBrand: undefined,
    current: null,
    onDidChangeWorkspace: Event.None,
  } as unknown as IWorkspaceService)
  services.set(IUriIdentityService, { _serviceBrand: undefined } as unknown as IUriIdentityService)
  const instantiation = new InstantiationService(services)
  const svc = new RendererSessionsService(
    sessions as unknown as IAcpSessionServiceType,
    history,
    groups,
    instantiation,
    widgets as unknown as IAcpChatWidgetServiceType,
    new FakeWindowFocusService(),
  )
  return { svc, sessions, history, groups, widgets, instantiation }
}

/** Open a real session tab in `group`, as the workbench would. */
function openSessionTab(
  h: Harness,
  group: IEditorGroup,
  sessionId: string,
  activate = true,
): AcpSessionEditorInput {
  const input = h.instantiation.createInstance(AcpSessionEditorInput, sessionId, 'fake', undefined)
  group.openEditor(input, { activate, pinned: true })
  return input
}

function sessionTabs(groups: EditorGroupsService): AcpSessionEditorInput[] {
  return groups.groups
    .flatMap((group) => group.editors)
    .filter((editor): editor is AcpSessionEditorInput => editor instanceof AcpSessionEditorInput)
}

describe('RendererSessionsService', () => {
  it('reveal opens and activates the selected session editor even when the session is already active', async () => {
    const h = makeHarness()
    const session = makeSession('s1')
    h.sessions.add(session)
    h.sessions.setActive(session.id)
    h.sessions.setActive.mockClear()

    await h.svc.reveal(session.id)

    expect(h.sessions.setActive).toHaveBeenCalledWith('s1')
    const tabs = sessionTabs(h.groups)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.sessionId).toBe('s1')
    expect(h.groups.activeGroup.activeEditor).toBe(tabs[0])
    expect(h.widgets.focusSessionInput).toHaveBeenCalledWith('s1')
  })

  it('reveal is a no-op for an unknown session', async () => {
    const h = makeHarness()

    await h.svc.reveal('missing')

    expect(h.sessions.setActive).not.toHaveBeenCalled()
    expect(sessionTabs(h.groups)).toHaveLength(0)
  })

  it('reveal opens a history-backed tab when no live session exists', async () => {
    const h = makeHarness([
      makeHistoryEntry('durable-1', { agentId: 'helper', title: 'Restored chat' }),
    ])
    h.sessions.setActive.mockClear()

    await h.svc.reveal('durable-1')

    expect(h.sessions.setActive).not.toHaveBeenCalled()
    const tabs = sessionTabs(h.groups)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.sessionId).toBe('durable-1')
    expect(tabs[0]!.agentId).toBe('helper')
    expect(tabs[0]!.getName()).toBe('Restored chat')
    expect(h.groups.activeGroup.activeEditor).toBe(tabs[0])
    expect(h.widgets.focusSessionInput).toHaveBeenCalledWith('durable-1')
  })

  it('reveal activates the group holding a restored tab without duplicating it', async () => {
    const h = makeHarness([makeHistoryEntry('durable-1')])
    const left = h.groups.activeGroup
    const right = h.groups.addGroup(left, GroupDirection.Right)
    const tab = openSessionTab(h, right, 'durable-1')
    h.groups.activateGroup(left)

    await h.svc.reveal('durable-1')

    expect(h.groups.activeGroup).toBe(right)
    expect(right.activeEditor).toBe(tab)
    expect(sessionTabs(h.groups)).toHaveLength(1)
  })

  it('reveal wakes a dormant session in the background', async () => {
    const h = makeHarness()
    const session = makeSession('s1', { status: 'closed', dormant: true })
    h.sessions.add(session)

    await h.svc.reveal('s1')

    expect(vi.mocked(session.ensureAwake)).toHaveBeenCalledOnce()
    expect(sessionTabs(h.groups)).toHaveLength(1)
  })

  it('reveal leaves an awake session untouched', async () => {
    const h = makeHarness()
    const session = makeSession('s1')
    h.sessions.add(session)

    await h.svc.reveal('s1')

    expect(vi.mocked(session.ensureAwake)).not.toHaveBeenCalled()
  })

  it('reveal focuses the group already holding the session tab instead of duplicating it', async () => {
    const h = makeHarness()
    h.sessions.add(makeSession('s1'))
    const left = h.groups.activeGroup
    const right = h.groups.addGroup(left, GroupDirection.Right)
    const tab = openSessionTab(h, right, 's1')
    h.groups.activateGroup(left)

    await h.svc.reveal('s1')

    expect(h.groups.activeGroup).toBe(right)
    expect(right.editors).toHaveLength(1)
    expect(right.activeEditor).toBe(tab)
    expect(left.editors).toHaveLength(0)
    expect(sessionTabs(h.groups)).toHaveLength(1)
  })

  it('reveal re-activates a session tab that already sits in the active group', async () => {
    const h = makeHarness()
    h.sessions.add(makeSession('s1'))
    const left = h.groups.activeGroup
    const other = openSessionTab(h, left, 's2')
    const tab = openSessionTab(h, left, 's1', false)
    expect(left.activeEditor).toBe(other)

    await h.svc.reveal('s1')

    expect(left.editors).toHaveLength(2)
    expect(left.activeEditor).toBe(tab)
  })

  it('reveal activates the holding group even when the active group is locked', async () => {
    const h = makeHarness()
    h.sessions.add(makeSession('s1'))
    const left = h.groups.activeGroup
    const right = h.groups.addGroup(left, GroupDirection.Right)
    // Both groups hold a tab: `lock()` fires a model change, and an *empty*
    // group is auto-closed on the next microtask — which `await reveal` reaches.
    openSessionTab(h, left, 's2')
    const tab = openSessionTab(h, right, 's1')
    h.groups.activateGroup(left)
    left.lock(true)

    await h.svc.reveal('s1')

    expect(h.groups.count).toBe(2)
    expect(h.groups.activeGroup).toBe(right)
    expect(right.activeEditor).toBe(tab)
    expect(left.editors).toHaveLength(1)
    expect(sessionTabs(h.groups)).toHaveLength(2)
  })

  it('reveal falls back to the lock-aware target group when every group is locked', async () => {
    const h = makeHarness()
    h.sessions.add(makeSession('s1'))
    const left = h.groups.activeGroup
    const right = h.groups.addGroup(left, GroupDirection.Right)
    openSessionTab(h, left, 's2')
    openSessionTab(h, right, 's3')
    h.groups.activateGroup(left)
    left.lock(true)
    right.lock(true)

    await h.svc.reveal('s1')

    expect(h.groups.count).toBe(3)
    expect(h.groups.activeGroup.editors).toHaveLength(1)
    const revealed = h.groups.activeGroup.activeEditor
    expect(revealed).toBeInstanceOf(AcpSessionEditorInput)
    expect((revealed as AcpSessionEditorInput).sessionId).toBe('s1')
    expect(sessionTabs(h.groups)).toHaveLength(3)
  })

  describe('revealSessionEditorTab', () => {
    it('reveals an existing tab even without a resident session instance', () => {
      const h = makeHarness()
      const left = h.groups.activeGroup
      const right = h.groups.addGroup(left, GroupDirection.Right)
      const tab = openSessionTab(h, right, 's1')
      h.groups.activateGroup(left)

      revealSessionEditorTab(h.groups, h.instantiation, 's1', undefined)

      expect(h.groups.activeGroup).toBe(right)
      expect(right.activeEditor).toBe(tab)
      expect(sessionTabs(h.groups)).toHaveLength(1)
    })

    it('opens nothing when the session has neither a tab nor a resident instance', () => {
      const h = makeHarness()

      revealSessionEditorTab(h.groups, h.instantiation, 'ghost', undefined)

      expect(sessionTabs(h.groups)).toHaveLength(0)
    })
  })

  describe('listSessions', () => {
    it('includes a dormant session with the dormant display status', async () => {
      const h = makeHarness()
      h.sessions.add(makeSession('s1', { status: 'closed', dormant: true }))

      const list = await h.svc.listSessions()

      expect(list).toEqual([
        {
          sessionId: 's1',
          agentSessionId: 's1',
          title: 'Session s1',
          status: 'dormant',
          agentId: 'fake',
        },
      ])
    })

    it('excludes a genuinely closed session but keeps live ones', async () => {
      const h = makeHarness()
      h.sessions.add(makeSession('gone', { status: 'closed' }))
      h.sessions.add(makeSession('live', { status: 'running' }))

      const list = await h.svc.listSessions()

      expect(list.map((s) => s.sessionId)).toEqual(['live'])
      expect(list[0]!.status).toBe('running')
      expect(list[0]!.agentSessionId).toBe('live')
    })

    it('lists a restored tab that has no live session as dormant', async () => {
      const h = makeHarness([makeHistoryEntry('durable-1', { title: 'Restored chat' })])
      openSessionTab(h, h.groups.activeGroup, 'durable-1')

      const list = await h.svc.listSessions()

      expect(list).toEqual([
        {
          sessionId: 'durable-1',
          agentSessionId: 'durable-1',
          title: 'Restored chat',
          status: 'dormant',
          agentId: 'fake',
        },
      ])
    })

    it('does not list a live session twice through its history row', async () => {
      const h = makeHarness([makeHistoryEntry('durable-1', { title: 'History title' })])
      h.sessions.add(makeSession('local-1', { durableId: 'durable-1', status: 'running' }))
      openSessionTab(h, h.groups.activeGroup, 'local-1')

      const list = await h.svc.listSessions()

      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        sessionId: 'local-1',
        agentSessionId: 'durable-1',
        status: 'running',
      })
      expect(list[0]!.title).toBe('History title')
    })

    it('lists a connecting session once before it has a durable id', async () => {
      const h = makeHarness()
      h.sessions.add(makeSession('local-1', { durableId: null, status: 'connecting' }))
      openSessionTab(h, h.groups.activeGroup, 'local-1')

      const list = await h.svc.listSessions()

      expect(list.map((s) => s.sessionId)).toEqual(['local-1'])
      expect(list[0]!.agentSessionId).toBeUndefined()
    })

    it('does not resurface a just-closed session through its still-open tab', async () => {
      const h = makeHarness([makeHistoryEntry('s1')])
      h.sessions.add(makeSession('s1', { status: 'closed' }))
      openSessionTab(h, h.groups.activeGroup, 's1')

      const list = await h.svc.listSessions()

      expect(list).toEqual([])
    })
  })
})
