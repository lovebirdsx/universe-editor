/*---------------------------------------------------------------------------------------------
 *  Tests for WindowTitleContribution
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
  type ISettableObservable,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { WindowTitleContribution } from '../WindowTitleContribution.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../services/acp/acpSessionHistory.js'
import type { AcpSessionStatus, IAcpSession } from '../../services/acp/acpSession.js'

function makeWorkspaceStub(initial: IWorkspace | null = null): IWorkspaceServiceType & {
  fireWorkspaceChange(workspace: IWorkspace | null): void
} {
  const wsEmitter = new Emitter<IWorkspace | null>()
  const recentEmitter = new Emitter<readonly IRecentWorkspace[]>()
  let current = initial
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: wsEmitter.event,
    get recent() {
      return []
    },
    onDidChangeRecent: recentEmitter.event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {
      current = null
    },
    async clearRecent() {},
    async removeRecent() {},
    fireWorkspaceChange(workspace: IWorkspace | null) {
      current = workspace
      wsEmitter.fire(workspace)
    },
  }
}

function makeSessionStub(id: string, title: string, status: AcpSessionStatus = 'idle') {
  const statusObs = observableValue<AcpSessionStatus>('test.status', status)
  const pendingQuestion = observableValue<unknown>('test.question', undefined)
  const pendingPermission = observableValue<unknown>('test.permission', undefined)
  const session = {
    id,
    title,
    status: statusObs,
    pendingQuestion,
    pendingPermission,
    sessionIdOnAgent: observableValue<string | undefined>('test.sid', id),
  } as unknown as IAcpSession
  return { session, statusObs, pendingQuestion, pendingPermission }
}

function makeAcpStubs() {
  const activeSession = observableValue<IAcpSession | undefined>('test.active', undefined)
  const sessions = {
    _serviceBrand: undefined,
    activeSession,
    getById: (sessionId: string) =>
      activeSession.get()?.id === sessionId ? activeSession.get() : undefined,
  } as unknown as IAcpSessionService
  const history = {
    _serviceBrand: undefined,
    entries: observableValue('test.entries', []),
    get: () => undefined,
  } as unknown as IAcpSessionHistoryService
  return {
    sessions,
    history,
    activeSession: activeSession as ISettableObservable<IAcpSession | undefined>,
  }
}

function makeContribution(
  ws: IWorkspaceServiceType,
  acp = makeAcpStubs(),
): { contribution: WindowTitleContribution; acp: ReturnType<typeof makeAcpStubs> } {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, ws)
  services.set(IAcpSessionService, acp.sessions)
  services.set(IAcpSessionHistoryService, acp.history)
  const inst = new InstantiationService(services)
  return { contribution: inst.createInstance(WindowTitleContribution), acp }
}

describe('WindowTitleContribution', () => {
  afterEach(() => {
    document.title = ''
  })

  it('sets the title to "<folder name> - <parent dir>" for the initial workspace', () => {
    const folder = URI.file('/tmp/myProject')
    const ws = makeWorkspaceStub({ folder, name: 'myProject' })
    const { contribution } = makeContribution(ws)

    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    contribution.dispose()
  })

  it('shows only appName when there is no workspace', () => {
    const ws = makeWorkspaceStub(null)
    const { contribution } = makeContribution(ws)

    expect(document.title).toBe('Universe Editor')

    contribution.dispose()
  })

  it('updates the title when the workspace changes', () => {
    const ws = makeWorkspaceStub(null)
    const { contribution } = makeContribution(ws)

    ws.fireWorkspaceChange({ folder: URI.file('/tmp/a'), name: 'a' })
    expect(document.title).toBe(`a - ${URI.file('/tmp').fsPath}`)

    ws.fireWorkspaceChange({ folder: URI.file('/work/b'), name: 'b' })
    expect(document.title).toBe(`b - ${URI.file('/work').fsPath}`)

    ws.fireWorkspaceChange(null)
    expect(document.title).toBe('Universe Editor')

    contribution.dispose()
  })

  it('appends the active session segment with a status symbol', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp } = makeContribution(ws)
    const { session, statusObs } = makeSessionStub('s1', '修复登录Bug', 'running')

    acp.activeSession.set(session, undefined)
    expect(document.title).toBe('myProject — ● 修复登录Bug')

    statusObs.set('idle', undefined)
    expect(document.title).toBe('myProject — ○ 修复登录Bug')

    statusObs.set('errored', undefined)
    expect(document.title).toBe('myProject — ✕ 修复登录Bug')

    contribution.dispose()
  })

  it('shows the ask symbol when the session is waiting on the user', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp } = makeContribution(ws)
    const { session, pendingQuestion } = makeSessionStub('s1', '修复登录Bug', 'running')

    acp.activeSession.set(session, undefined)
    pendingQuestion.set({ toolCallId: 't' }, undefined)
    expect(document.title).toBe('myProject — ◆ 修复登录Bug')

    pendingQuestion.set(undefined, undefined)
    expect(document.title).toBe('myProject — ● 修复登录Bug')

    contribution.dispose()
  })

  it('drops the session segment when the session is closed or cleared', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp } = makeContribution(ws)
    const { session, statusObs } = makeSessionStub('s1', '修复登录Bug', 'running')

    acp.activeSession.set(session, undefined)
    statusObs.set('closed', undefined)
    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    acp.activeSession.set(undefined, undefined)
    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    contribution.dispose()
  })
})
