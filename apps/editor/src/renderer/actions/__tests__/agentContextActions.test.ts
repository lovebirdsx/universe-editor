import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  IQuickInputService,
  IWorkspaceService,
  ServiceCollection,
  URI,
  observableValue,
  registerAction2,
  type Action2,
  type IDisposable,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  AddSelectionToExistingAgentChatAction,
  AddSelectionToNewAgentChatAction,
  SendCommitToAgentChatAction,
} from '../agentContextActions.js'
import {
  createChatTarget,
  listChatTargets,
  resolveExistingChatTarget,
  type RevealServices,
} from '../_agentChatTarget.js'
import {
  IAcpSessionService,
  type IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { IAcpChatWidgetService } from '../../services/acp/session/acpChatWidgetService.js'
import { AcpSessionEditorInput } from '../../services/acp/session/acpSessionEditorInput.js'
import { AcpPromptContextInbox } from '../../services/acp/session/acpPromptContextInbox.js'
import { AcpPromptTextInbox } from '../../services/acp/session/acpPromptTextInbox.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'

const disposables: IDisposable[] = []

beforeEach(() => {
  // revealSessionChat's second focus pass is rAF-guarded (node has none); stub it
  // so these tests also cover that pass actually running.
  vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
    cb(0)
    return 0
  })
})

afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
  vi.unstubAllGlobals()
  AcpPromptTextInbox._resetForTests()
  AcpPromptContextInbox._resetForTests()
  FileEditorRegistry._resetForTests()
})

function fakeSelection(startLineNumber: number, endLineNumber: number, isEmpty = false) {
  return { startLineNumber, endLineNumber, isEmpty: () => isEmpty }
}

function fakeEditor(
  selections: readonly ReturnType<typeof fakeSelection>[],
  valuesByLine: Record<number, string>,
  languageId?: string,
) {
  return {
    getSelections: () => selections,
    getModel: () => ({
      getValueInRange: (sel: { startLineNumber: number }) =>
        valuesByLine[sel.startLineNumber] ?? '',
      getLanguageId: () => languageId,
    }),
  }
}

interface FakeSessionOptions {
  readonly id: string
  readonly title?: string
  readonly cwd?: string
  readonly agentId?: string
  readonly status?: string
  readonly isDormant?: boolean
  readonly readOnly?: boolean
}

function fakeSession(options: FakeSessionOptions): IAcpSession {
  return {
    id: options.id,
    agentId: options.agentId ?? 'claude',
    title: options.title ?? options.id,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    readOnly: options.readOnly ?? false,
    status: observableValue('t.status', options.status ?? 'idle'),
    isDormant: observableValue('t.dormant', options.isDormant ?? false),
    pendingElicitation: observableValue('t.elicitation', undefined),
    pendingPermission: observableValue('t.permission', undefined),
    backgroundTaskCount: observableValue('t.background', 0),
  } as unknown as IAcpSession
}

function noopGroups() {
  return {
    _serviceBrand: undefined,
    groups: [],
    activeGroup: {},
    activeGroupForOpen: { openEditor: vi.fn() },
    activateGroup: vi.fn(),
  } as unknown as IEditorGroupsService
}

interface RevealHarness {
  readonly services: RevealServices
  readonly createSession: ReturnType<typeof vi.fn>
  readonly pick: ReturnType<typeof vi.fn>
  readonly quickInput: IQuickInputService
}

function revealServices(
  sessions: readonly IAcpSession[],
  activeId?: string,
  overrides?: { groups?: IEditorGroupsService },
): RevealHarness {
  const created = fakeSession({ id: 'created-1' })
  const createSession = vi.fn(async () => created)
  const service = {
    _serviceBrand: undefined,
    sessions: observableValue<readonly IAcpSession[]>('t.sessions', sessions),
    activeSession: observableValue<IAcpSession | undefined>(
      't.active',
      sessions.find((s) => s.id === activeId),
    ),
    createSession,
    getById: (id: string) =>
      sessions.find((s) => s.id === id) ?? (id === created.id ? created : undefined),
  } as unknown as IAcpSessionService
  const pick = vi.fn()
  return {
    services: {
      sessions: service,
      registry: {
        _serviceBrand: undefined,
        defaultAgentId: () => 'claude',
      } as unknown as IAcpAgentRegistry,
      widgets: {
        _serviceBrand: undefined,
        focusSessionInput: vi.fn(),
        focusSession: vi.fn(),
      } as unknown as IAcpChatWidgetService,
      groups: overrides?.groups ?? noopGroups(),
      inst: {
        _serviceBrand: undefined,
        createInstance: vi.fn(),
      } as unknown as IInstantiationService,
    },
    createSession,
    pick,
    quickInput: { _serviceBrand: undefined, pick } as unknown as IQuickInputService,
  }
}

describe('listChatTargets', () => {
  it('keeps a dormant session — it wakes on send', () => {
    const dormant = fakeSession({ id: 'a', status: 'closed', isDormant: true })
    expect(listChatTargets({ sessions: observableValue('t', [dormant]) } as never)).toEqual([
      dormant,
    ])
  })

  it('drops a session the user closed', () => {
    const closed = fakeSession({ id: 'a', status: 'closed', isDormant: false })
    expect(listChatTargets({ sessions: observableValue('t', [closed]) } as never)).toEqual([])
  })

  it('drops a read-only foreign-worktree preview, whose sendPrompt is a no-op', () => {
    const preview = fakeSession({ id: 'a', readOnly: true })
    expect(listChatTargets({ sessions: observableValue('t', [preview]) } as never)).toEqual([])
  })
})

describe('add selection to an existing agent chat', () => {
  it('creates a session without asking when none is open', async () => {
    const harness = revealServices([])
    const target = await resolveExistingChatTarget(harness.services, harness.quickInput)
    expect(harness.createSession).toHaveBeenCalledTimes(1)
    expect(harness.pick).not.toHaveBeenCalled()
    expect(target?.id).toBe('created-1')
  })

  it('uses the only session without asking', async () => {
    const only = fakeSession({ id: 'solo' })
    const harness = revealServices([only], 'solo')
    const target = await resolveExistingChatTarget(harness.services, harness.quickInput)
    expect(target).toBe(only)
    expect(harness.pick).not.toHaveBeenCalled()
    expect(harness.createSession).not.toHaveBeenCalled()
  })

  it('offers the active session first, then the rest newest-first', async () => {
    const first = fakeSession({ id: 'a', title: 'First', cwd: 'X:/workspace/alpha' })
    const second = fakeSession({ id: 'b', title: 'Second' })
    const third = fakeSession({ id: 'c', title: 'Third' })
    const harness = revealServices([first, second, third], 'a')
    harness.pick.mockResolvedValue(undefined)

    await resolveExistingChatTarget(harness.services, harness.quickInput)

    const [items, options] = harness.pick.mock.calls[0] as [
      (IQuickPickItem & { sessionId: string })[],
      { placeholder: string; matchOnDescription: boolean; activeItemId?: string; id?: string },
    ]
    expect(items.map((i) => i.id)).toEqual(['a', 'c', 'b'])
    expect(items.map((i) => i.label)).toEqual(['First', 'Third', 'Second'])
    // cwd basename goes in `description` — the quick input row does not render `detail`.
    expect(items[0]?.description).toBe('alpha')
    expect(items[1]?.description).toBeUndefined()
    expect(items.map((i) => i.statusIconId)).toEqual(['idle', 'idle', 'idle'])
    expect(options.activeItemId).toBe('a')
    // Passing an `id` would switch the picker into MRU mode and reorder the list.
    expect(options.id).toBeUndefined()
  })

  it('falls back to newest-first when the active session is not a candidate', async () => {
    const first = fakeSession({ id: 'a' })
    const second = fakeSession({ id: 'b' })
    const harness = revealServices([first, second], 'preview-of-another-worktree')
    harness.pick.mockResolvedValue(undefined)

    await resolveExistingChatTarget(harness.services, harness.quickInput)

    const [items] = harness.pick.mock.calls[0] as [(IQuickPickItem & { sessionId: string })[]]
    expect(items.map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('returns the picked session', async () => {
    const first = fakeSession({ id: 'a' })
    const second = fakeSession({ id: 'b' })
    const harness = revealServices([first, second], 'b')
    harness.pick.mockResolvedValue({ id: 'a', sessionId: 'a' })

    expect(await resolveExistingChatTarget(harness.services, harness.quickInput)).toBe(first)
  })

  it('falls back to a new session when the picked chat is gone', async () => {
    const harness = revealServices([fakeSession({ id: 'a' }), fakeSession({ id: 'b' })], 'a')
    harness.pick.mockResolvedValue({ id: 'ghost', sessionId: 'ghost' })

    expect((await resolveExistingChatTarget(harness.services, harness.quickInput))?.id).toBe(
      'created-1',
    )
  })

  it('falls back to a new session when the picked chat turned read-only', async () => {
    const target = fakeSession({ id: 'a' })
    const harness = revealServices([target, fakeSession({ id: 'b' })], 'a')
    harness.pick.mockImplementation(async () => {
      // The chat is re-previewed from another worktree while the picker is open.
      Object.assign(target, { readOnly: true })
      return { id: 'a', sessionId: 'a' }
    })

    expect((await resolveExistingChatTarget(harness.services, harness.quickInput))?.id).toBe(
      'created-1',
    )
  })

  it('creates a session when the only chat is a read-only preview', async () => {
    const harness = revealServices([fakeSession({ id: 'preview', readOnly: true })], 'preview')

    expect((await resolveExistingChatTarget(harness.services, harness.quickInput))?.id).toBe(
      'created-1',
    )
    expect(harness.pick).not.toHaveBeenCalled()
  })

  it('returns undefined when the picker is dismissed', async () => {
    const harness = revealServices([fakeSession({ id: 'a' }), fakeSession({ id: 'b' })], 'a')
    harness.pick.mockResolvedValue(undefined)

    expect(await resolveExistingChatTarget(harness.services, harness.quickInput)).toBeUndefined()
  })
})

describe('add selection to a new agent chat', () => {
  it('always creates a session, even with others open', async () => {
    const existing = fakeSession({ id: 'a' })
    const harness = revealServices([existing], 'a')
    const target = await createChatTarget(harness.services)
    expect(harness.createSession).toHaveBeenCalledTimes(1)
    expect(target.id).toBe('created-1')
  })
})

describe('AddSelectionToAgentChat actions', () => {
  interface RunOptions {
    readonly pickResult?: unknown
    readonly sessions?: readonly IAcpSession[]
    readonly activeId?: string
  }

  // run() captures every service synchronously (before its first await), so a
  // plain ServiceCollection-backed accessor suffices; nothing dereferences the
  // accessor past the await.
  async function runAction(
    ActionClass: new () => Action2,
    options: RunOptions = {},
  ): Promise<void> {
    const harness = revealServices(options.sessions ?? [], options.activeId)
    harness.pick.mockResolvedValue(options.pickResult)
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(
      input,
      fakeEditor([fakeSelection(3, 5)], { 3: 'const x = 1' }, 'typescript') as never,
    )
    const services = new ServiceCollection()
    services.set(IEditorService, {
      _serviceBrand: undefined,
      activeEditor: observableValue('t.editor', input),
    } as unknown as IEditorService)
    services.set(IWorkspaceService, {
      _serviceBrand: undefined,
      current: { folder: URI.file('/workspace') },
    } as unknown as IWorkspaceService)
    services.set(IQuickInputService, harness.quickInput)
    services.set(IAcpSessionService, harness.services.sessions)
    services.set(IAcpAgentRegistry, harness.services.registry)
    services.set(IAcpChatWidgetService, harness.services.widgets)
    services.set(IEditorGroupsService, harness.services.groups)
    services.set(IInstantiationService, harness.services.inst)
    const accessor = { get: (id: unknown) => services.get(id as never) } as ServicesAccessor
    await new ActionClass().run(accessor)
  }

  const EXPECTED_CONTEXTS = [
    {
      uri: URI.file('/workspace/src/a.ts').toString(),
      relPath: 'src/a.ts',
      text: 'const x = 1',
      startLine: 3,
      endLine: 5,
      languageId: 'typescript',
    },
  ]

  it('registers both commands', () => {
    disposables.push(registerAction2(AddSelectionToExistingAgentChatAction))
    disposables.push(registerAction2(AddSelectionToNewAgentChatAction))
    expect(CommandsRegistry.getCommand(AddSelectionToExistingAgentChatAction.ID)).toBeDefined()
    expect(CommandsRegistry.getCommand(AddSelectionToNewAgentChatAction.ID)).toBeDefined()
  })

  it('deposits into the picked session, keyed by its local id', async () => {
    const first = fakeSession({ id: 'a' })
    const second = fakeSession({ id: 'b' })
    await runAction(AddSelectionToExistingAgentChatAction, {
      sessions: [first, second],
      activeId: 'b',
      pickResult: { id: 'a', sessionId: 'a' },
    })
    expect(AcpPromptContextInbox.drain('a')).toEqual(EXPECTED_CONTEXTS)
    expect(AcpPromptContextInbox.drain('b')).toEqual([])
  })

  it('creates a session to deposit into when none is open', async () => {
    await runAction(AddSelectionToExistingAgentChatAction)
    expect(AcpPromptContextInbox.drain('created-1')).toEqual(EXPECTED_CONTEXTS)
  })

  it('deposits nothing when the picker is dismissed', async () => {
    await runAction(AddSelectionToExistingAgentChatAction, {
      sessions: [fakeSession({ id: 'a' }), fakeSession({ id: 'b' })],
      activeId: 'a',
    })
    expect(AcpPromptContextInbox.drain('a')).toEqual([])
    expect(AcpPromptContextInbox.drain('b')).toEqual([])
  })

  it('deposits into a freshly created session from the new-chat command', async () => {
    await runAction(AddSelectionToNewAgentChatAction, {
      sessions: [fakeSession({ id: 'a' })],
      activeId: 'a',
    })
    expect(AcpPromptContextInbox.drain('created-1')).toEqual(EXPECTED_CONTEXTS)
    expect(AcpPromptContextInbox.drain('a')).toEqual([])
  })
})

describe('SendCommitToAgentChatAction', () => {
  const session = { id: 'sess-1', agentId: 'claude' } as unknown as IAcpSession

  // run() captures every service synchronously (before its first await), so a
  // plain ServiceCollection-backed accessor suffices; nothing dereferences the
  // accessor past the await.
  async function runAction(
    arg: unknown,
    activeSession: IAcpSession | undefined,
    overrides?: {
      groups?: IEditorGroupsService
      sessionsById?: (id: string) => IAcpSession | undefined
    },
  ): Promise<void> {
    const focusSessionInput = vi.fn()
    const createSession = vi.fn()
    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      activeSession: observableValue<IAcpSession | undefined>('t.active', activeSession),
      createSession,
      getById: overrides?.sessionsById ?? (() => undefined),
    } as unknown as IAcpSessionService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId: () => 'claude',
    } as unknown as IAcpAgentRegistry)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      focusSessionInput,
      focusSession: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    services.set(IEditorGroupsService, overrides?.groups ?? noopGroups())
    services.set(IInstantiationService, {
      _serviceBrand: undefined,
      createInstance: vi.fn(),
    } as unknown as IInstantiationService)
    const accessor = { get: (id: unknown) => services.get(id as never) } as ServicesAccessor
    await new SendCommitToAgentChatAction().run(accessor, arg as never)
  }

  it('registers the command', () => {
    disposables.push(registerAction2(SendCommitToAgentChatAction))
    expect(CommandsRegistry.getCommand(SendCommitToAgentChatAction.ID)).toBeDefined()
  })

  it('deposits the commit hash + subject as text for the active session', async () => {
    await runAction({ hash: 'abc1234def', message: 'fix: the thing' }, session)
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual(['Commit abc1234def: fix: the thing'])
  })

  it('falls back to hash-only when the subject is blank', async () => {
    await runAction({ hash: 'abc1234def', message: '   ' }, session)
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual(['Commit abc1234def'])
  })

  it('is a no-op without a hash', async () => {
    await runAction({ hash: '', message: 'x' }, session)
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual([])
  })

  it('activates an existing session editor in another group instead of opening a duplicate', async () => {
    // Fake AcpSessionEditorInput: only `instanceof` + `sessionId` matter here.
    const existing = Object.create(AcpSessionEditorInput.prototype) as AcpSessionEditorInput
    Object.defineProperty(existing, 'sessionId', { value: 'sess-1' })
    const setActive = vi.fn()
    const otherGroup = { editors: [existing], setActive }
    const activeGroup = { editors: [] }
    const activateGroup = vi.fn()
    const openEditor = vi.fn()
    const groups = {
      _serviceBrand: undefined,
      groups: [activeGroup, otherGroup],
      activeGroup,
      activeGroupForOpen: { openEditor },
      activateGroup,
    } as unknown as IEditorGroupsService

    await runAction({ hash: 'abc1234def', message: 'fix' }, session, { groups })

    expect(activateGroup).toHaveBeenCalledWith(otherGroup)
    expect(setActive).toHaveBeenCalledWith(existing)
    expect(openEditor).not.toHaveBeenCalled()
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual(['Commit abc1234def: fix'])
  })

  it('opens a new session editor when none is open in any group', async () => {
    const openEditor = vi.fn()
    const activeGroup = { editors: [] }
    const activeGroupForOpen = { openEditor }
    const groups = {
      _serviceBrand: undefined,
      groups: [activeGroup],
      activeGroup,
      activeGroupForOpen,
      activateGroup: vi.fn(),
    } as unknown as IEditorGroupsService

    await runAction({ hash: 'abc1234def', message: 'fix' }, session, {
      groups,
      sessionsById: (id) => (id === 'sess-1' ? session : undefined),
    })

    expect(openEditor).toHaveBeenCalledTimes(1)
  })
})
