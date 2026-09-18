/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent session action tests. Guards the Choose Agent semantics (picking an agent
 *  only persists it as the default — creating a session is the job of the dedicated
 *  `+` button / `workbench.action.agent.newSession`) and the side-task navigation
 *  commands (open-side-task / go-to-parent-session).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  Event,
  GroupDirection,
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  IQuickInputService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  constObservable,
  observableValue,
  registerAction2,
  type IDisposable,
  type ISettableObservable,
} from '@universe-editor/platform'
import {
  GoToParentSessionAction,
  OpenSideTaskAction,
  SelectAgentAction,
  SwitchSessionAction,
  SwitchSessionReverseAction,
} from '../agentSessionActions.js'
import {
  ISessionSwitcherService,
  type SessionSummary,
} from '../../../shared/ipc/sessionSwitcher.js'
import { IAcpAgentRegistry, type IAcpAgentDescriptor } from '../../services/acp/acpAgentRegistry.js'
import {
  IAcpSessionService,
  type IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
} from '../../services/acp/session/acpSessionHistory.js'
import { IAcpChatWidgetService } from '../../services/acp/session/acpChatWidgetService.js'
import { AcpSessionEditorInput } from '../../services/acp/session/acpSessionEditorInput.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'

const AGENTS: readonly IAcpAgentDescriptor[] = [
  { id: 'claude-code', name: 'Claude Code', command: 'claude', args: [] },
  { id: 'codex', name: 'Codex', command: 'codex', args: [] },
]

function makeRegistry(agents: readonly IAcpAgentDescriptor[] = AGENTS) {
  return {
    _serviceBrand: undefined,
    list: () => agents,
    defaultAgentId: () => 'claude-code',
    defaultAgentIdObs: constObservable('claude-code'),
    setDefaultAgentId: vi.fn(),
    health: vi.fn().mockResolvedValue({ available: true }),
  }
}

async function run(
  registry: ReturnType<typeof makeRegistry>,
  picked: { id: string; label: string } | undefined,
): Promise<MockInstance> {
  const dispose = registerAction2(SelectAgentAction)
  const pick = vi.fn().mockResolvedValue(picked)
  try {
    const services = new ServiceCollection()
    services.set(IAcpAgentRegistry, registry as never)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      await Promise.resolve(CommandsRegistry.getCommand(SelectAgentAction.ID)!.handler(accessor))
    })
  } finally {
    dispose.dispose()
  }
  return pick
}

/** The `iconId`s the action handed to the quick pick, in row order. */
function rowIconIds(pick: MockInstance): (string | undefined)[] {
  const args = pick.mock.calls[0] as readonly [readonly { iconId?: string }[]] | undefined
  return (args?.[0] ?? []).map((item) => item.iconId)
}

describe('SelectAgentAction', () => {
  it('persists the picked agent as the default', async () => {
    const registry = makeRegistry()
    await run(registry, { id: 'codex', label: 'Codex' })
    expect(registry.setDefaultAgentId).toHaveBeenCalledWith('codex')
  })

  it('does nothing when the pick is cancelled', async () => {
    const registry = makeRegistry()
    await run(registry, undefined)
    expect(registry.setDefaultAgentId).not.toHaveBeenCalled()
  })

  it('gives every row an agent logo (descriptor icon → id map → bot)', async () => {
    const registry = makeRegistry([
      { id: 'claude-code', name: 'Claude Code', command: 'claude', args: [] },
      { id: 'codex', name: 'Codex', command: 'codex', args: [] },
      { id: 'custom', name: 'Custom', command: 'custom-acp', args: [], icon: 'claude' },
      { id: 'mystery', name: 'Mystery', command: 'mystery-acp', args: [] },
    ])
    const pick = await run(registry, undefined)
    expect(rowIconIds(pick)).toEqual(['claude', 'openai', 'claude', 'bot'])
  })

  it('declares no dependency on the session service (selection only)', () => {
    // Regression guard: the action previously created a session right after the
    // pick; its accessor surface must stay free of IAcpSessionService so the
    // "only switch the default agent" contract can't silently regress.
    const src = SelectAgentAction.prototype.run.toString()
    expect(src).not.toContain('IAcpSessionService')
    expect(src).not.toContain('createSession')
  })
})

/** A history row. `id` doubles as the durable `sessionIdOnAgent`, matching the
 *  real service, where `sideTaskOf` links are keyed by the durable id. */
function sideTaskRow(id: string, sideTaskOf?: string, lastUsedAt = 1): AcpSessionHistoryEntry {
  return {
    id,
    agentId: 'fake',
    sessionIdOnAgent: id,
    title: id,
    createdAt: 1,
    lastUsedAt,
    ...(sideTaskOf !== undefined ? { sideTaskOf } : {}),
  }
}

/** A resident session. `sessionIdOnAgent` mirrors the real dual-id split: the
 *  local uuid is what the instance answers to, the agent-issued id is what
 *  history rows are keyed by. */
function liveSession(id: string, sessionIdOnAgent?: string): IAcpSession {
  return {
    id,
    agentId: 'fake',
    sessionIdOnAgent: observableValue<string | undefined>('t.sid', sessionIdOnAgent),
  } as unknown as IAcpSession
}

interface SideTaskHarness {
  readonly groups: EditorGroupsService
  readonly pick: ReturnType<typeof vi.fn>
  readonly addGroup: MockInstance<EditorGroupsService['addGroup']>
  readonly inst: InstantiationService
  /** The stubbed `IEditorService.activeEditor` — the real service derives it from
   *  the groups, so tests that open a tab must set it by hand. */
  readonly activeEditor: ISettableObservable<unknown>
  activeEditorId(): string | undefined
  run(commandId: string, arg?: unknown): Promise<void>
  dispose(): void
}

function makeSideTaskHarness(
  options: {
    readonly rows?: readonly AcpSessionHistoryEntry[]
    /** Sessions that `getById` answers for — by local id AND by durable id. */
    readonly live?: readonly IAcpSession[]
    readonly pickResult?: { id: string } | undefined
    readonly activeEditor?: unknown
  } = {},
): SideTaskHarness {
  const rows = options.rows ?? []
  const live = options.live ?? []
  const history = {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('t.entries', rows),
    list: () => rows,
    get: (id: string) => rows.find((row) => row.id === id),
  } as unknown as IAcpSessionHistoryService
  const sessions = {
    _serviceBrand: undefined,
    getById: (id: string) => live.find((s) => s.id === id || s.sessionIdOnAgent.get() === id),
    activeSession: observableValue<IAcpSession | undefined>('t.active', undefined),
  } as unknown as IAcpSessionService
  const groups = new EditorGroupsService()
  const addGroup = vi.spyOn(groups, 'addGroup')
  const pick = vi.fn().mockResolvedValue(options.pickResult)
  const activeEditor = observableValue<unknown>('t.editor', options.activeEditor)

  const services = new ServiceCollection()
  services.set(IAcpSessionService, sessions)
  services.set(IAcpSessionHistoryService, history)
  services.set(IEditorGroupsService, groups)
  services.set(IEditorService, { activeEditor } as unknown as IEditorService)
  services.set(IQuickInputService, {
    _serviceBrand: undefined,
    pick,
  } as unknown as IQuickInputService)
  services.set(IAcpChatWidgetService, {
    _serviceBrand: undefined,
    register: () => ({ dispose() {} }),
    lastFocusedWidget: undefined,
  } as unknown as IAcpChatWidgetService)
  services.set(IWorkspaceService, {
    _serviceBrand: undefined,
    current: null,
    onDidChangeWorkspace: Event.None,
  } as unknown as IWorkspaceService)
  services.set(IUriIdentityService, { _serviceBrand: undefined } as unknown as IUriIdentityService)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)

  const disposables: IDisposable[] = [
    registerAction2(OpenSideTaskAction),
    registerAction2(GoToParentSessionAction),
  ]

  return {
    groups,
    pick,
    addGroup,
    inst,
    activeEditor,
    activeEditorId: () => {
      const active = groups.activeGroup.activeEditor
      return active instanceof AcpSessionEditorInput ? active.sessionId : undefined
    },
    run: async (commandId, arg) => {
      await inst.invokeFunction((accessor) =>
        Promise.resolve(CommandsRegistry.getCommand(commandId)!.handler(accessor, arg)),
      )
    },
    dispose: () => {
      while (disposables.length > 0) disposables.pop()?.dispose()
    },
  }
}

describe('side-task navigation commands', () => {
  let harness: SideTaskHarness | undefined

  const make = (options?: Parameters<typeof makeSideTaskHarness>[0]): SideTaskHarness => {
    harness = makeSideTaskHarness(options)
    return harness
  }

  afterEach(() => {
    harness?.dispose()
    harness = undefined
  })

  it('registers no default keybindings for either command', () => {
    make()
    const bound = KeybindingsRegistry.getAllKeybindings().map((item) => item.command)
    expect(bound).not.toContain(OpenSideTaskAction.ID)
    expect(bound).not.toContain(GoToParentSessionAction.ID)
  })

  it('maps a local session id onto its durable id before matching children', async () => {
    // The live session answers to its local uuid while `sideTaskOf` is keyed by
    // the agent-issued id — without the mapping the child list would come back
    // empty and the command would look broken.
    const h = make({
      rows: [sideTaskRow('parent-dur'), sideTaskRow('side-1', 'parent-dur', 1000)],
      live: [liveSession('local-parent', 'parent-dur')],
      pickResult: { id: 'side-1' },
    })
    await h.run(OpenSideTaskAction.ID, { sessionId: 'local-parent' })

    expect(h.pick).toHaveBeenCalledOnce()
    expect(h.pick.mock.calls[0]![0].map((item: { id: string }) => item.id)).toEqual(['side-1'])
  })

  it('lists direct children only, most recently used first', async () => {
    const h = make({
      rows: [
        sideTaskRow('parent-dur'),
        sideTaskRow('older', 'parent-dur', 1000),
        sideTaskRow('newer', 'parent-dur', 2000),
        sideTaskRow('grandchild', 'older', 3000),
      ],
      pickResult: { id: 'newer' },
    })
    await h.run(OpenSideTaskAction.ID, { sessionId: 'parent-dur' })

    expect(h.pick.mock.calls[0]![0].map((item: { id: string }) => item.id)).toEqual([
      'newer',
      'older',
    ])
  })

  it('opens the picked side task in a new right split', async () => {
    const h = make({
      rows: [sideTaskRow('parent-dur'), sideTaskRow('side-1', 'parent-dur')],
      pickResult: { id: 'side-1' },
    })
    await h.run(OpenSideTaskAction.ID, { sessionId: 'parent-dur' })

    expect(h.addGroup).toHaveBeenCalledWith(expect.anything(), GroupDirection.Right)
    expect(h.activeEditorId()).toBe('side-1')
  })

  it('prefers the resident session id so an open tab is reused, not duplicated', async () => {
    const h = make({
      rows: [sideTaskRow('parent-dur'), sideTaskRow('side-1', 'parent-dur')],
      live: [liveSession('local-side', 'side-1')],
      pickResult: { id: 'side-1' },
    })
    await h.run(OpenSideTaskAction.ID, { sessionId: 'parent-dur' })

    expect(h.activeEditorId()).toBe('local-side')
  })

  it('does nothing when the session has no side tasks', async () => {
    const h = make({ rows: [sideTaskRow('parent-dur')] })
    await h.run(OpenSideTaskAction.ID, { sessionId: 'parent-dur' })

    expect(h.pick).not.toHaveBeenCalled()
    expect(h.groups.count).toBe(1)
  })

  it('does nothing when the pick is cancelled', async () => {
    const h = make({
      rows: [sideTaskRow('parent-dur'), sideTaskRow('side-1', 'parent-dur')],
      pickResult: undefined,
    })
    await h.run(OpenSideTaskAction.ID, { sessionId: 'parent-dur' })

    expect(h.groups.count).toBe(1)
  })

  it('focuses an already-open parent tab without adding a group', async () => {
    const h = make({
      rows: [sideTaskRow('parent-dur'), sideTaskRow('side-1', 'parent-dur')],
    })
    const group = h.groups.addGroup(h.groups.activeGroup, GroupDirection.Right)
    group.openEditor(
      h.inst.createInstance(AcpSessionEditorInput, 'parent-dur', 'fake', undefined),
      {
        activate: true,
        pinned: true,
      },
    )
    h.addGroup.mockClear()

    await h.run(GoToParentSessionAction.ID, { sessionId: 'side-1' })

    expect(h.addGroup).not.toHaveBeenCalled()
    expect(h.activeEditorId()).toBe('parent-dur')
  })

  it('opens the parent in a left split when no tab exists', async () => {
    const h = make({
      rows: [sideTaskRow('parent-dur'), sideTaskRow('side-1', 'parent-dur')],
    })
    await h.run(GoToParentSessionAction.ID, { sessionId: 'side-1' })

    // `groups.groups` is push order, not visual order — the spy is what pins
    // down which side of the active group the split lands on.
    expect(h.addGroup).toHaveBeenCalledWith(expect.anything(), GroupDirection.Left)
    expect(h.activeEditorId()).toBe('parent-dur')
  })

  it('does nothing for a session that is not a side task', async () => {
    const h = make({ rows: [sideTaskRow('plain-1')] })
    await h.run(GoToParentSessionAction.ID, { sessionId: 'plain-1' })

    expect(h.addGroup).not.toHaveBeenCalled()
    expect(h.groups.count).toBe(1)
  })

  it('resolves the target from the active session editor when no argument is given', async () => {
    const h = make({
      rows: [sideTaskRow('parent-dur'), sideTaskRow('side-1', 'parent-dur')],
      pickResult: { id: 'side-1' },
    })
    const parentTab = h.inst.createInstance(AcpSessionEditorInput, 'parent-dur', 'fake', undefined)
    h.groups.activeGroup.openEditor(parentTab, { activate: true, pinned: true })
    h.activeEditor.set(parentTab, undefined)

    await h.run(OpenSideTaskAction.ID)

    expect(h.pick).toHaveBeenCalledOnce()
    expect(h.pick.mock.calls[0]![0].map((item: { id: string }) => item.id)).toEqual(['side-1'])
  })
})

function sessionSummary(windowId: number, sessionId: string, title: string): SessionSummary {
  return { windowId, sessionId, title, status: 'idle', agentId: 'fake', workspaceName: 'ws' }
}

interface SwitchHarness {
  readonly pick: MockInstance
  readonly reveal: MockInstance
  run(commandId: string): Promise<void>
  dispose(): void
}

function makeSwitchHarness(
  sessions: readonly SessionSummary[],
  activeSessionId: string | undefined,
  pickResult: unknown = undefined,
  /** Overridable so a test can hold the command inside the session fan-out. */
  getAllSessions: () => Promise<readonly SessionSummary[]> = async () => sessions,
): SwitchHarness {
  const pick = vi.fn().mockResolvedValue(pickResult)
  const reveal = vi.fn().mockResolvedValue(undefined)
  const services = new ServiceCollection()
  services.set(ISessionSwitcherService, {
    _serviceBrand: undefined,
    getAllSessions: vi.fn(getAllSessions),
    reveal,
  } as unknown as ISessionSwitcherService)
  services.set(IAcpSessionService, {
    _serviceBrand: undefined,
    activeSession: constObservable(
      activeSessionId === undefined ? undefined : ({ id: activeSessionId } as IAcpSession),
    ),
  } as unknown as IAcpSessionService)
  services.set(IQuickInputService, {
    _serviceBrand: undefined,
    pick,
  } as unknown as IQuickInputService)
  const inst = new InstantiationService(services)
  const disposables: IDisposable[] = [
    registerAction2(SwitchSessionAction),
    registerAction2(SwitchSessionReverseAction),
  ]
  return {
    pick,
    reveal,
    run: async (commandId) => {
      await inst.invokeFunction((accessor) =>
        Promise.resolve(CommandsRegistry.getCommand(commandId)!.handler(accessor)),
      )
    },
    dispose: () => {
      while (disposables.length > 0) disposables.pop()?.dispose()
    },
  }
}

/** The pick options the action handed to the quick pick. */
function pickOptions(pick: MockInstance): {
  activeItemId?: string
  quickNavigate?: { modifier: string; triggerKey?: string; initialSelectionIndex?: number }
} {
  const call = pick.mock.calls[0] as readonly [unknown, Record<string, never>] | undefined
  return (call?.[1] ?? {}) as never
}

describe('SwitchSessionAction', () => {
  const SESSIONS = [
    sessionSummary(1, 'a', 'Session A'),
    sessionSummary(1, 'b', 'Session B'),
    sessionSummary(2, 'c', 'Session C'),
  ]
  let harness: SwitchHarness | undefined

  const make = (
    sessions = SESSIONS,
    activeSessionId: string | undefined = 'b',
    pickResult: unknown = undefined,
  ): SwitchHarness => {
    harness = makeSwitchHarness(sessions, activeSessionId, pickResult)
    return harness
  }

  afterEach(() => {
    harness?.dispose()
    harness = undefined
  })

  // The gesture is the whole point: the panel opens locked on the row a release
  // would open, so Alt+S then letting go of Alt switches in one keystroke.
  it('asks for an Alt-driven quick-navigate picker one row past the current session', async () => {
    const h = make()
    await h.run(SwitchSessionAction.ID)

    expect(pickOptions(h.pick).quickNavigate).toEqual({
      modifier: 'alt',
      triggerKey: 's',
      initialSelectionIndex: 2,
    })
  })

  it('highlights the row before the current session for the reverse command', async () => {
    const h = make()
    await h.run(SwitchSessionReverseAction.ID)

    expect(pickOptions(h.pick).quickNavigate?.initialSelectionIndex).toBe(0)
  })

  // A quick-navigate picker takes its highlight from `initialSelectionIndex` alone —
  // the panel ignores `activeItemId` in that mode — so the current session is only an
  // anchor for the index, never a second highlight on the row a release must not open.
  it('does not also highlight the current session through activeItemId', async () => {
    const h = make()
    await h.run(SwitchSessionAction.ID)

    expect(pickOptions(h.pick).activeItemId).toBeUndefined()
  })

  it('reveals the picked session in its own window', async () => {
    const h = make(SESSIONS, 'b', {
      id: '2.c',
      label: 'Session C',
      windowId: 2,
      sessionId: 'c',
    })
    await h.run(SwitchSessionAction.ID)

    expect(h.reveal).toHaveBeenCalledWith(2, 'c')
  })

  it('reveals nothing when the picker is dismissed', async () => {
    const h = make(SESSIONS, 'b', undefined)
    await h.run(SwitchSessionAction.ID)

    expect(h.reveal).not.toHaveBeenCalled()
  })

  it('does not open a picker without any session', async () => {
    const h = make([], undefined)
    await h.run(SwitchSessionAction.ID)

    expect(h.pick).not.toHaveBeenCalled()
  })

  it('ignores a second Alt+S that lands before the first picker is up', async () => {
    // The `when` clause cannot cover this one: while `getAllSessions()` is in flight
    // the panel is not up yet, so `quickInputVisible` is still false and a held Alt
    // tapping S twice reaches the command twice. The second `pick()` would strand the
    // first promise (`_currentOnHide` is a single slot) and re-run the whole fan-out.
    let release: (value: readonly SessionSummary[]) => void = () => {}
    const gate = new Promise<readonly SessionSummary[]>((resolve) => {
      release = resolve
    })
    const h = (harness = makeSwitchHarness(SESSIONS, 'b', undefined, () => gate))

    // Both taps are in flight on purpose: awaiting the second one here would hang
    // the test instead of failing it when the guard is gone, since it parks on the
    // very gate this test is holding shut.
    const first = h.run(SwitchSessionAction.ID)
    const second = h.run(SwitchSessionAction.ID)
    release(SESSIONS)
    await Promise.all([first, second])

    expect(h.pick).toHaveBeenCalledOnce()
  })

  it('binds both directions only while no picker is open', async () => {
    // The when-clause keeps the picker's own keys from resolving while it is up:
    // otherwise the global handler swallows the repeated Alt+S the panel cycles on,
    // and the highlight would sit still.
    const contextKeyService = new ContextKeyService()
    const quickInputVisible = contextKeyService.createKey<boolean>('quickInputVisible', false)
    const h = make()
    try {
      expect(KeybindingsRegistry.resolveKeybinding('alt+s', contextKeyService)).toBe(
        SwitchSessionAction.ID,
      )
      expect(KeybindingsRegistry.resolveKeybinding('alt+shift+s', contextKeyService)).toBe(
        SwitchSessionReverseAction.ID,
      )

      quickInputVisible.set(true)
      expect(KeybindingsRegistry.resolveKeybinding('alt+s', contextKeyService)).toBeUndefined()
      expect(
        KeybindingsRegistry.resolveKeybinding('alt+shift+s', contextKeyService),
      ).toBeUndefined()
    } finally {
      h.dispose()
      harness = undefined
    }
  })
})
