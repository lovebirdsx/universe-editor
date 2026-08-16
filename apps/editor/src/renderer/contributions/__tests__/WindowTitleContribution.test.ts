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
import { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../services/acp/session/acpSessionHistory.js'
import type { AcpSessionStatus, IAcpSession } from '../../services/acp/session/acpSession.js'

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
  const pendingElicitation = observableValue<unknown>('test.elicitation', undefined)
  const pendingPermission = observableValue<unknown>('test.permission', undefined)
  const session = {
    id,
    title,
    status: statusObs,
    pendingElicitation,
    pendingPermission,
    backgroundTaskCount: observableValue<number>('test.btc', 0),
    sessionIdOnAgent: observableValue<string | undefined>('test.sid', id),
  } as unknown as IAcpSession
  return { session, statusObs, pendingElicitation, pendingPermission }
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
    delete (window as unknown as { ipc?: unknown }).ipc
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
    const { session, pendingElicitation } = makeSessionStub('s1', '修复登录Bug', 'running')

    acp.activeSession.set(session, undefined)
    pendingElicitation.set({ request: {} }, undefined)
    expect(document.title).toBe('myProject — ◆ 修复登录Bug')

    pendingElicitation.set(undefined, undefined)
    expect(document.title).toBe('myProject — ● 修复登录Bug')

    contribution.dispose()
  })

  it('prepends the remote marker and uses the server-side parent path for remote workspaces', () => {
    const folder = URI.from({
      scheme: 'remote-ssh',
      authority: 'wsl+ubuntu-24.04',
      path: '/home/x/proj',
    })
    const ws = makeWorkspaceStub({ folder, name: 'proj' })
    const { contribution } = makeContribution(ws)

    expect(document.title).toBe('⇄ proj - /home/x')

    contribution.dispose()
  })

  it('prepends the remote marker to the session segment for remote workspaces', () => {
    const folder = URI.from({
      scheme: 'remote-ssh',
      authority: 'myhost',
      path: '/home/x/proj',
    })
    const ws = makeWorkspaceStub({ folder, name: 'proj' })
    const { contribution, acp } = makeContribution(ws)
    const { session } = makeSessionStub('s1', '修复登录Bug', 'running')

    acp.activeSession.set(session, undefined)
    expect(document.title).toBe('⇄ proj — ● 修复登录Bug')

    contribution.dispose()
  })

  it('prepends the remote marker for an empty window scoped to a remote argv authority', () => {
    const argvAuthority = { remoteAuthority: 'wsl+ubuntu-24.04' }
    ;(window as unknown as { ipc?: unknown }).ipc = argvAuthority
    const ws = makeWorkspaceStub(null)
    const { contribution } = makeContribution(ws)

    expect(document.title).toBe('⇄ Universe Editor')

    contribution.dispose()
  })

  it('does not prepend a remote marker for local workspaces', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution } = makeContribution(ws)

    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)
    expect(document.title).not.toContain('⇄')

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
