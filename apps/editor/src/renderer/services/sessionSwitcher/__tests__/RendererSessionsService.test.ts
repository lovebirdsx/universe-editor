/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Event,
  InstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  ServiceCollection,
  observableValue,
  type IEditorInput,
  type IEditorService,
  type IInstantiationService,
  type IObservable,
} from '@universe-editor/platform'
import { RendererSessionsService } from '../RendererSessionsService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../../acp/session/acpSessionHistory.js'
import {
  IAcpChatLocationService,
  type AcpChatLocation,
} from '../../acp/session/acpChatLocationService.js'
import { AcpSessionEditorInput } from '../../acp/session/acpSessionEditorInput.js'
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
    const session = this._sessions.get(sessionId)
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
    return this._sessions.get(sessionId)
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

class FakeChatLocation {
  declare readonly _serviceBrand: undefined
  readonly location: IObservable<AcpChatLocation> = observableValue<AcpChatLocation>(
    'test.location',
    'sidebar',
  )
  readonly isMigrating = false
  readonly setLocation = vi.fn()
  initialize(): Promise<void> {
    return Promise.resolve()
  }
  toggle(): void {}
}

class FakeEditorService {
  declare readonly _serviceBrand: undefined
  readonly openEditors = observableValue<readonly IEditorInput[]>('test.openEditors', [])
  readonly activeEditorId = observableValue<string | undefined>('test.activeEditorId', undefined)
  readonly activeEditor = observableValue<IEditorInput | undefined>('test.activeEditor', undefined)
  readonly opened: Array<{ input: IEditorInput; options: unknown }> = []
  openEditor(input: IEditorInput, options?: unknown): void {
    this.opened.push({ input, options })
    this.activeEditor.set(input, undefined)
    this.activeEditorId.set(input.id, undefined)
  }
  closeEditor(): void {}
  closeAllEditors(): void {}
}

class FakeChatWidgetService {
  declare readonly _serviceBrand: undefined
  readonly lastFocusedWidget = undefined
  readonly focusSessionInput = vi.fn(() => true)
  register(): never {
    throw new Error('not implemented')
  }
}

function makeHistory(): IAcpSessionHistoryServiceType {
  return {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.history', []),
    get: () => undefined,
    list: () => [],
    initialize: () => Promise.resolve(),
  } as unknown as IAcpSessionHistoryServiceType
}

function makeSession(
  id: string,
  opts: { agentId?: string; status?: AcpSessionStatus; dormant?: boolean } = {},
): IAcpSession {
  return {
    id,
    agentId: opts.agentId ?? 'fake',
    title: `Session ${id}`,
    status: observableValue<AcpSessionStatus>('test.status', opts.status ?? 'idle'),
    isDormant: observableValue<boolean>('test.dormant', opts.dormant ?? false),
    pendingElicitation: observableValue<unknown>('test.elicitation', undefined),
    pendingPermission: observableValue<unknown>('test.permission', undefined),
    backgroundTaskCount: observableValue<number>('test.btc', 0),
    sessionIdOnAgent: observableValue<string | undefined>('test.sid', id),
    ensureAwake: vi.fn(() => Promise.resolve('ready')),
  } as unknown as IAcpSession
}

function makeHarness(): {
  svc: RendererSessionsService
  sessions: FakeSessionService
  location: FakeChatLocation
  editor: FakeEditorService
  widgets: FakeChatWidgetService
  instantiation: IInstantiationService
} {
  const sessions = new FakeSessionService()
  const history = makeHistory()
  const location = new FakeChatLocation()
  const editor = new FakeEditorService()
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
    location as unknown as IAcpChatLocationService,
    editor as unknown as IEditorService,
    instantiation,
    widgets as unknown as IAcpChatWidgetServiceType,
  )
  return { svc, sessions, location, editor, widgets, instantiation }
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
    expect(h.location.setLocation).toHaveBeenCalledWith('editor')
    expect(h.editor.opened).toHaveLength(1)
    const opened = h.editor.opened[0]!
    expect(opened.input).toBeInstanceOf(AcpSessionEditorInput)
    expect((opened.input as AcpSessionEditorInput).sessionId).toBe('s1')
    expect(opened.options).toEqual({ activate: true, pinned: true })
    expect(h.widgets.focusSessionInput).toHaveBeenCalledWith('s1')
  })

  it('reveal is a no-op for an unknown session', async () => {
    const h = makeHarness()

    await h.svc.reveal('missing')

    expect(h.sessions.setActive).not.toHaveBeenCalled()
    expect(h.location.setLocation).not.toHaveBeenCalled()
    expect(h.editor.opened).toHaveLength(0)
  })

  it('reveal wakes a dormant session in the background', async () => {
    const h = makeHarness()
    const session = makeSession('s1', { status: 'closed', dormant: true })
    h.sessions.add(session)

    await h.svc.reveal('s1')

    expect(vi.mocked(session.ensureAwake)).toHaveBeenCalledOnce()
    expect(h.editor.opened).toHaveLength(1)
  })

  it('reveal leaves an awake session untouched', async () => {
    const h = makeHarness()
    const session = makeSession('s1')
    h.sessions.add(session)

    await h.svc.reveal('s1')

    expect(vi.mocked(session.ensureAwake)).not.toHaveBeenCalled()
  })

  describe('listSessions', () => {
    it('includes a dormant session with the dormant display status', async () => {
      const h = makeHarness()
      h.sessions.add(makeSession('s1', { status: 'closed', dormant: true }))

      const list = await h.svc.listSessions()

      expect(list).toEqual([
        { sessionId: 's1', title: 'Session s1', status: 'dormant', agentId: 'fake' },
      ])
    })

    it('excludes a genuinely closed session but keeps live ones', async () => {
      const h = makeHarness()
      h.sessions.add(makeSession('gone', { status: 'closed' }))
      h.sessions.add(makeSession('live', { status: 'running' }))

      const list = await h.svc.listSessions()

      expect(list.map((s) => s.sessionId)).toEqual(['live'])
      expect(list[0]!.status).toBe('running')
    })
  })
})
