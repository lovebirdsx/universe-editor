/*---------------------------------------------------------------------------------------------
 *  Tests for WindowTitleContribution
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IEditorGroupsService,
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
import { AcpSessionEditorInput } from '../../services/acp/session/acpSessionEditorInput.js'
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
  const dormantObs = observableValue<boolean>('test.dormant', false)
  const pendingElicitation = observableValue<unknown>('test.elicitation', undefined)
  const pendingPermission = observableValue<unknown>('test.permission', undefined)
  const sessionIdOnAgent = observableValue<string | undefined>('test.sid', id)
  const session = {
    id,
    title,
    status: statusObs,
    isDormant: dormantObs,
    pendingElicitation,
    pendingPermission,
    backgroundTaskCount: observableValue<number>('test.btc', 0),
    sessionIdOnAgent,
  } as unknown as IAcpSession
  return {
    session,
    statusObs,
    dormantObs,
    pendingElicitation,
    pendingPermission,
    sessionIdOnAgent,
  }
}

/**
 * Minimal IEditorGroupsService: one movable `mainPart.activeGroup`, with the
 * model / active-editor events the title contribution subscribes to. Session
 * tabs are identified by `instanceof AcpSessionEditorInput`, so the harness
 * builds real prototypes rather than plain objects. Each group owns its own
 * emitters and counts live subscriptions, so rebinding can be checked for
 * listener leaks rather than inferred from an idempotent title recompute.
 */
function makeGroupsStub() {
  interface FakeGroup {
    activeEditor: unknown
    onDidChangeModel(listener: (event: unknown) => void): { dispose(): void }
    onDidActiveEditorChange(listener: () => void): { dispose(): void }
    subscriptions(): number
  }
  interface GroupListeners {
    readonly model: Emitter<unknown>
    readonly activeEditor: Emitter<void>
    subscriptions: number
  }

  const listeners = new Map<FakeGroup, GroupListeners>()
  const activeGroupEmitter = new Emitter<FakeGroup>()

  const makeGroup = (): FakeGroup => {
    const state: GroupListeners = {
      model: new Emitter<unknown>(),
      activeEditor: new Emitter<void>(),
      subscriptions: 0,
    }
    const group: FakeGroup = {
      activeEditor: undefined,
      onDidChangeModel(listener) {
        state.subscriptions++
        const sub = state.model.event(listener)
        return {
          dispose: () => {
            state.subscriptions--
            sub.dispose()
          },
        }
      },
      onDidActiveEditorChange(listener) {
        state.subscriptions++
        const sub = state.activeEditor.event(listener)
        return {
          dispose: () => {
            state.subscriptions--
            sub.dispose()
          },
        }
      },
      subscriptions: () => state.subscriptions,
    }
    listeners.set(group, state)
    return group
  }

  const first = makeGroup()
  const mainPart = {
    isMain: true,
    activeGroup: first,
    onDidActiveGroupChange: activeGroupEmitter.event,
  }
  const service = { mainPart, activeGroup: first } as unknown as IEditorGroupsService

  const fireActive = (group: FakeGroup): void => {
    const state = listeners.get(group)
    state?.model.fire({ kind: 'active' })
    state?.activeEditor.fire()
  }

  return {
    service,
    group: first,
    setActiveEditor(editor: unknown) {
      mainPart.activeGroup.activeEditor = editor
      fireActive(mainPart.activeGroup)
    },
    switchGroup(next: FakeGroup) {
      mainPart.activeGroup = next
      activeGroupEmitter.fire(next)
    },
    newGroup: makeGroup,
  }
}

function sessionInput(sessionId: string): AcpSessionEditorInput {
  return Object.assign(Object.create(AcpSessionEditorInput.prototype), {
    sessionId,
  }) as AcpSessionEditorInput
}

function makeAcpStubs() {
  const activeSession = observableValue<IAcpSession | undefined>('test.active', undefined)
  const sessionsObs = observableValue<readonly IAcpSession[]>('test.sessions', [])
  const byId = new Map<string, IAcpSession>()
  const sessions = {
    _serviceBrand: undefined,
    activeSession,
    sessions: sessionsObs,
    getById: (sessionId: string) => byId.get(sessionId),
  } as unknown as IAcpSessionService
  const entries = observableValue<readonly unknown[]>('test.entries', [])
  const titles = new Map<string, string>()
  const history = {
    _serviceBrand: undefined,
    entries,
    get: (sessionId: string) => {
      const title = titles.get(sessionId)
      return title === undefined ? undefined : { title }
    },
  } as unknown as IAcpSessionHistoryService
  return {
    sessions,
    history,
    activeSession: activeSession as ISettableObservable<IAcpSession | undefined>,
    register(session: IAcpSession) {
      byId.set(session.id, session)
      const durable = session.sessionIdOnAgent.get()
      if (durable !== undefined) byId.set(durable, session)
      sessionsObs.set(
        [...sessionsObs.get().filter((existing) => existing.id !== session.id), session],
        undefined,
      )
    },
    rename(sessionId: string, title: string) {
      titles.set(sessionId, title)
      entries.set([...entries.get()], undefined)
    },
  }
}

function makeContribution(ws: IWorkspaceServiceType) {
  const acp = makeAcpStubs()
  const groups = makeGroupsStub()
  const services = new ServiceCollection()
  services.set(IWorkspaceService, ws)
  services.set(IAcpSessionService, acp.sessions)
  services.set(IAcpSessionHistoryService, acp.history)
  services.set(IEditorGroupsService, groups.service)
  const inst = new InstantiationService(services)
  return { contribution: inst.createInstance(WindowTitleContribution), acp, groups }
}

function showSession(
  acp: ReturnType<typeof makeAcpStubs>,
  groups: ReturnType<typeof makeGroupsStub>,
  session: IAcpSession,
  tabId: string = session.id,
): void {
  acp.register(session)
  groups.setActiveEditor(sessionInput(tabId))
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
    const { contribution, acp, groups } = makeContribution(ws)
    const { session, statusObs } = makeSessionStub('s1', '修复登录Bug', 'running')

    showSession(acp, groups, session)
    expect(document.title).toBe('myProject — ● 修复登录Bug')

    statusObs.set('idle', undefined)
    expect(document.title).toBe('myProject — ○ 修复登录Bug')

    statusObs.set('errored', undefined)
    expect(document.title).toBe('myProject — ✕ 修复登录Bug')

    contribution.dispose()
  })

  it('shows the ask symbol when the session is waiting on the user', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp, groups } = makeContribution(ws)
    const { session, pendingElicitation } = makeSessionStub('s1', '修复登录Bug', 'running')

    showSession(acp, groups, session)
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
    const { contribution, acp, groups } = makeContribution(ws)
    const { session } = makeSessionStub('s1', '修复登录Bug', 'running')

    showSession(acp, groups, session)
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

  it('drops the session segment when the session is closed or the tab is cleared', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp, groups } = makeContribution(ws)
    const { session, statusObs } = makeSessionStub('s1', '修复登录Bug', 'running')

    showSession(acp, groups, session)
    statusObs.set('closed', undefined)
    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    groups.setActiveEditor(undefined)
    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    contribution.dispose()
  })

  it('keeps the session segment with a moon symbol while the session is dormant', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp, groups } = makeContribution(ws)
    const { session, statusObs, dormantObs } = makeSessionStub('s1', '修复登录Bug', 'idle')

    showSession(acp, groups, session)
    expect(document.title).toBe('myProject — ○ 修复登录Bug')

    // Idle reaper seals the session: dormant first, then status closed.
    dormantObs.set(true, undefined)
    statusObs.set('closed', undefined)
    expect(document.title).toBe('myProject — ☾ 修复登录Bug')

    // Waking goes through connecting back to idle.
    dormantObs.set(false, undefined)
    statusObs.set('connecting', undefined)
    expect(document.title).toBe('myProject — ◌ 修复登录Bug')

    contribution.dispose()
  })

  // Regression: the global activeSession follows focus across windows, so an
  // auxiliary window's session used to leak into the main window's title (and
  // thus into Alt+Tab). The title must only reflect this window's main part.
  it('ignores the globally active session when it lives in another window', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp, groups } = makeContribution(ws)
    const { session } = makeSessionStub('s1', '辅助窗口会话', 'running')

    acp.activeSession.set(session, undefined)
    groups.setActiveEditor({})

    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    contribution.dispose()
  })

  it('follows the active editor of the main part', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp, groups } = makeContribution(ws)
    const a = makeSessionStub('a', '会话A', 'running').session
    const b = makeSessionStub('b', '会话B', 'running').session

    showSession(acp, groups, a)
    expect(document.title).toBe('myProject — ● 会话A')

    showSession(acp, groups, b)
    expect(document.title).toBe('myProject — ● 会话B')

    groups.setActiveEditor({})
    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    contribution.dispose()
  })

  it('rebinds to the new active group when the group changes', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp, groups } = makeContribution(ws)
    const a = makeSessionStub('a', '会话A', 'running').session
    const b = makeSessionStub('b', '会话B', 'running').session

    showSession(acp, groups, a)
    expect(document.title).toBe('myProject — ● 会话A')
    // Two listeners: onDidChangeModel + onDidActiveEditorChange.
    expect(groups.group.subscriptions()).toBe(2)

    const second = groups.newGroup()
    groups.switchGroup(second)
    // The old group must be released, not merely shadowed.
    expect(groups.group.subscriptions()).toBe(0)
    expect(second.subscriptions()).toBe(2)
    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    showSession(acp, groups, b)
    expect(document.title).toBe('myProject — ● 会话B')

    contribution.dispose()
  })

  // Restored session tabs mount before AcpSession registers; the title must
  // recompute when the session lands in the registry, without a tab switch.
  it('recomputes when the session registers after its tab is restored', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp, groups } = makeContribution(ws)
    const { session } = makeSessionStub('s1', '恢复的会话', 'running')

    groups.setActiveEditor(sessionInput('s1'))
    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    acp.register(session)
    expect(document.title).toBe('myProject — ● 恢复的会话')

    contribution.dispose()
  })

  it('follows a session rename', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp, groups } = makeContribution(ws)
    const { session } = makeSessionStub('s1', '原名', 'running')

    showSession(acp, groups, session)
    expect(document.title).toBe('myProject — ● 原名')

    acp.rename('s1', '改名后')
    expect(document.title).toBe('myProject — ● 改名后')

    contribution.dispose()
  })

  it('resolves a session tab opened with its durable agent id', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/myProject'), name: 'myProject' })
    const { contribution, acp, groups } = makeContribution(ws)
    const { session, sessionIdOnAgent } = makeSessionStub('local-id', '恢复的会话', 'running')
    sessionIdOnAgent.set('durable-id', undefined)

    showSession(acp, groups, session, 'durable-id')
    expect(document.title).toBe('myProject — ● 恢复的会话')

    contribution.dispose()
  })
})
