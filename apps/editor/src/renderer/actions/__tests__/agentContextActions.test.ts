import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ICommandService,
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  IQuickInputService,
  IUriIdentityService,
  IWorkspaceService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  UriIdentityService,
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
  SendChangelistToAgentChatAction,
  SendCommitToAgentChatAction,
  SendContextToAgentChatAction,
  SendExplorerResourceToAgentChatAction,
  SendScmResourceToAgentChatAction,
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
import { AcpPromptRefInbox } from '../../services/acp/session/acpPromptRefInbox.js'
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
  AcpPromptRefInbox._resetForTests()
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

describe('SendContextToAgentChatAction', () => {
  const session = { id: 'sess-1', agentId: 'claude' } as unknown as IAcpSession

  async function runAction(arg: unknown, activeSession: IAcpSession | undefined): Promise<void> {
    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      activeSession: observableValue<IAcpSession | undefined>('t.active', activeSession),
      createSession: vi.fn(),
      getById: () => undefined,
    } as unknown as IAcpSessionService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId: () => 'claude',
    } as unknown as IAcpAgentRegistry)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      focusSessionInput: vi.fn(),
      focusSession: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    services.set(IEditorGroupsService, noopGroups())
    services.set(IInstantiationService, {
      _serviceBrand: undefined,
      createInstance: vi.fn(),
    } as unknown as IInstantiationService)
    const accessor = { get: (id: unknown) => services.get(id as never) } as ServicesAccessor
    await new SendContextToAgentChatAction().run(accessor, arg as never)
  }

  it('registers the command', () => {
    disposables.push(registerAction2(SendContextToAgentChatAction))
    expect(CommandsRegistry.getCommand(SendContextToAgentChatAction.ID)).toBeDefined()
  })

  it('deposits the caller-composed text verbatim', async () => {
    await runAction({ text: 'Perforce changelist 1234: fix the parser' }, session)
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual(['Perforce changelist 1234: fix the parser'])
  })

  it('is a no-op without text', async () => {
    await runAction({ text: '   ' }, session)
    await runAction(undefined, session)
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual([])
  })
})

describe('SendChangelistToAgentChatAction', () => {
  const session = { id: 'sess-1', agentId: 'claude' } as unknown as IAcpSession
  const CAPABILITY = 'perforce.getChangelistDescription'

  async function runAction(
    arg: unknown,
    options: { readonly description?: string; readonly capability?: boolean } = {},
  ): Promise<string[]> {
    const executed: string[] = []
    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      activeSession: observableValue<IAcpSession | undefined>('t.active', session),
      createSession: vi.fn(),
      getById: () => undefined,
    } as unknown as IAcpSessionService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId: () => 'claude',
    } as unknown as IAcpAgentRegistry)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      focusSessionInput: vi.fn(),
      focusSession: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    services.set(IEditorGroupsService, noopGroups())
    services.set(IInstantiationService, {
      _serviceBrand: undefined,
      createInstance: vi.fn(),
    } as unknown as IInstantiationService)
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: async (id: string) => {
        executed.push(id)
        return options.description
      },
    } as unknown as ICommandService)
    if (options.capability !== false) {
      disposables.push(
        CommandsRegistry.registerCommand(CAPABILITY, () => options.description ?? ''),
      )
    }
    const accessor = { get: (id: unknown) => services.get(id as never) } as ServicesAccessor
    await new SendChangelistToAgentChatAction().run(accessor, arg as never)
    return executed
  }

  it('registers the command on the SCM group-header menu', () => {
    disposables.push(registerAction2(SendChangelistToAgentChatAction))
    expect(CommandsRegistry.getCommand(SendChangelistToAgentChatAction.ID)).toBeDefined()
  })

  it('reads the description through the p4 capability and formats a changelist entry', async () => {
    const executed = await runAction(
      { sourceControlId: 'perforce', scmResourceGroupId: 'cl:1234' },
      { description: 'fix the parser\n\nlong body' },
    )
    expect(executed).toEqual([CAPABILITY])
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual(['Perforce changelist 1234: fix the parser'])
  })

  it('handles a shelved group id like a plain changelist', async () => {
    await runAction({ scmResourceGroupId: 'shelved:4321' }, { description: '' })
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual(['Perforce changelist 4321'])
  })

  it('stays out of the way when the p4 capability is missing (no p4 extension active)', async () => {
    const executed = await runAction(
      { scmResourceGroupId: 'cl:1234' },
      { capability: false, description: 'unused' },
    )
    expect(executed).toEqual([])
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual([])
  })

  it('ignores a group id that wraps no changelist (the default group)', async () => {
    const executed = await runAction({ scmResourceGroupId: 'default' }, { description: 'x' })
    expect(executed).toEqual([])
    expect(AcpPromptTextInbox.drain('sess-1')).toEqual([])
  })
})

describe('resource → Agent Chat actions', () => {
  const workspace = URI.file('/ws')
  const fileA = URI.file('/ws/src/a.ts')
  const fileB = URI.file('/ws/src/b.ts')
  const folder = URI.file('/ws/src')

  function target(uri: URI, isDirectory = false) {
    return { target: uri, resource: uri, parent: URI.joinPath(uri, '..'), isDirectory }
  }

  function resourceHarness(
    options: {
      readonly workspaceFolder?: URI
      readonly activeSession?: IAcpSession
    } = {},
  ) {
    const created = fakeSession({ id: 'created-1' })
    const createSession = vi.fn(async () => created)
    const services = new ServiceCollection()
    services.set(IWorkspaceService, {
      _serviceBrand: undefined,
      current: options.workspaceFolder ? { folder: options.workspaceFolder, name: 'ws' } : null,
    } as unknown as IWorkspaceService)
    services.set(IUriIdentityService, new UriIdentityService('linux'))
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      activeSession: observableValue<IAcpSession | undefined>('t.active', options.activeSession),
      createSession,
      getById: (id: string) => (id === created.id ? created : undefined),
    } as unknown as IAcpSessionService)
    services.set(IAcpAgentRegistry, {
      _serviceBrand: undefined,
      defaultAgentId: () => 'claude',
    } as unknown as IAcpAgentRegistry)
    services.set(IAcpChatWidgetService, {
      _serviceBrand: undefined,
      focusSessionInput: vi.fn(),
      focusSession: vi.fn(),
    } as unknown as IAcpChatWidgetService)
    services.set(IEditorGroupsService, noopGroups())
    services.set(IInstantiationService, {
      _serviceBrand: undefined,
      createInstance: vi.fn(),
    } as unknown as IInstantiationService)
    return {
      createSession,
      async run(Ctor: new () => Action2, args: readonly unknown[]): Promise<void> {
        const accessor = { get: (id: unknown) => services.get(id as never) } as ServicesAccessor
        await new Ctor().run(accessor, ...args)
      },
    }
  }

  describe('SendExplorerResourceToAgentChatAction', () => {
    it('registers the command and its Explorer menu slot', () => {
      disposables.push(registerAction2(SendExplorerResourceToAgentChatAction))
      expect(CommandsRegistry.getCommand(SendExplorerResourceToAgentChatAction.ID)).toBeDefined()
      const item = MenuRegistry.getMenuItems(MenuId.ExplorerContext).find(
        (entry) => 'command' in entry && entry.command === SendExplorerResourceToAgentChatAction.ID,
      )
      expect(item).toMatchObject({ group: '7_agent', order: 2 })
    })

    it('deposits a file as a workspace-relative @-mention ref', async () => {
      const active = fakeSession({ id: 'sess-1', cwd: '/ws' })
      const harness = resourceHarness({ workspaceFolder: workspace, activeSession: active })
      await harness.run(SendExplorerResourceToAgentChatAction, [
        target(fileA),
        [{ resource: fileA }],
      ])

      expect(harness.createSession).not.toHaveBeenCalled()
      expect(AcpPromptRefInbox.drain('sess-1')).toEqual([
        expect.objectContaining({ kind: 'file', label: 'src/a.ts', uri: fileA.toString() }),
      ])
    })

    it('deposits a folder as a single folder ref', async () => {
      const active = fakeSession({ id: 'sess-1', cwd: '/ws' })
      const harness = resourceHarness({ workspaceFolder: workspace, activeSession: active })
      await harness.run(SendExplorerResourceToAgentChatAction, [
        target(folder, true),
        [{ resource: folder, isDirectory: true }],
      ])
      expect(AcpPromptRefInbox.drain('sess-1')).toEqual([
        expect.objectContaining({ kind: 'folder', label: 'src', uri: folder.toString() }),
      ])
    })

    it('sends the whole multi-selection with each entry keeping its own kind', async () => {
      const active = fakeSession({ id: 'sess-1', cwd: '/ws' })
      const harness = resourceHarness({ workspaceFolder: workspace, activeSession: active })
      await harness.run(SendExplorerResourceToAgentChatAction, [
        target(fileA),
        [{ resource: fileA }, { resource: folder, isDirectory: true }, { resource: fileB }],
      ])
      expect(AcpPromptRefInbox.drain('sess-1').map((ref) => [ref.kind, ref.label])).toEqual([
        ['file', 'src/a.ts'],
        ['folder', 'src'],
        ['file', 'src/b.ts'],
      ])
    })

    it('ignores the workspace root and never creates a session for it', async () => {
      const harness = resourceHarness({ workspaceFolder: workspace })
      await harness.run(SendExplorerResourceToAgentChatAction, [
        target(workspace, true),
        [{ resource: workspace, isDirectory: true }],
      ])
      expect(AcpPromptRefInbox.drain('created-1')).toEqual([])
      expect(harness.createSession).not.toHaveBeenCalled()
    })

    it('labels refs relative to a narrowed session cwd', async () => {
      const active = fakeSession({ id: 'sess-1', cwd: '/ws/sub' })
      const harness = resourceHarness({ workspaceFolder: workspace, activeSession: active })
      const inside = URI.file('/ws/sub/x.ts')
      const outside = URI.file('/ws/y.ts')
      await harness.run(SendExplorerResourceToAgentChatAction, [
        target(inside),
        [{ resource: inside }, { resource: outside }],
      ])
      expect(AcpPromptRefInbox.drain('sess-1').map((ref) => ref.label)).toEqual([
        'x.ts',
        '/ws/y.ts',
      ])
    })

    it('creates a session when none is active', async () => {
      const harness = resourceHarness({ workspaceFolder: workspace })
      await harness.run(SendExplorerResourceToAgentChatAction, [target(fileA)])
      expect(harness.createSession).toHaveBeenCalledTimes(1)
      expect(AcpPromptRefInbox.drain('created-1')).toHaveLength(1)
    })

    it('treats an image file as a plain file ref', async () => {
      const active = fakeSession({ id: 'sess-1', cwd: '/ws' })
      const harness = resourceHarness({ workspaceFolder: workspace, activeSession: active })
      const image = URI.file('/ws/assets/photo.png')
      await harness.run(SendExplorerResourceToAgentChatAction, [target(image)])
      expect(AcpPromptRefInbox.drain('sess-1')).toEqual([
        expect.objectContaining({ kind: 'file', label: 'assets/photo.png' }),
      ])
    })
  })

  describe('SendScmResourceToAgentChatAction', () => {
    it('registers the command on both SCM row menus', () => {
      disposables.push(registerAction2(SendScmResourceToAgentChatAction))
      expect(CommandsRegistry.getCommand(SendScmResourceToAgentChatAction.ID)).toBeDefined()
      for (const menuId of [
        MenuId.ScmResourceStateContext,
        MenuId.ScmResourceFolderContext,
      ] as const) {
        const item = MenuRegistry.getMenuItems(menuId).find(
          (entry) => 'command' in entry && entry.command === SendScmResourceToAgentChatAction.ID,
        )
        expect(item).toMatchObject({ group: '4_agent', order: 1 })
      }
    })

    it('deposits a file row plus its multi-selection', async () => {
      const active = fakeSession({ id: 'sess-1', cwd: '/ws' })
      const harness = resourceHarness({ workspaceFolder: workspace, activeSession: active })
      const primary = { resourceUri: '/ws/src/a.ts', scmResourceGroupId: 'changes' }
      await harness.run(SendScmResourceToAgentChatAction, [
        primary,
        [
          { resourceUri: '/ws/src/a.ts', scmResourceGroupId: 'changes' },
          { resourceUri: '/ws/src/b.ts', scmResourceGroupId: 'changes' },
        ],
      ])
      expect(AcpPromptRefInbox.drain('sess-1').map((ref) => [ref.kind, ref.label])).toEqual([
        ['file', 'src/a.ts'],
        ['file', 'src/b.ts'],
      ])
    })

    it('dedupes repeated paths', async () => {
      const active = fakeSession({ id: 'sess-1', cwd: '/ws' })
      const harness = resourceHarness({ workspaceFolder: workspace, activeSession: active })
      const arg = { resourceUri: '/ws/src/a.ts', scmResourceGroupId: 'changes' }
      await harness.run(SendScmResourceToAgentChatAction, [arg, [arg, { ...arg }]])
      expect(AcpPromptRefInbox.drain('sess-1')).toHaveLength(1)
    })

    it('filters rows the provider marks as having no host file', async () => {
      const active = fakeSession({ id: 'sess-1', cwd: '/ws' })
      const harness = resourceHarness({ workspaceFolder: workspace, activeSession: active })
      const depot = {
        resourceUri: '//depot/branch_x/a.ts',
        scmResourceGroupId: 'shelved:1',
        noHostFile: true,
      }
      await harness.run(SendScmResourceToAgentChatAction, [
        depot,
        [depot, { resourceUri: '/ws/src/b.ts', scmResourceGroupId: 'shelved:1' }],
      ])
      expect(AcpPromptRefInbox.drain('sess-1')).toEqual([
        expect.objectContaining({ label: 'src/b.ts' }),
      ])
    })

    it('never creates a session when every row is filtered out', async () => {
      const harness = resourceHarness({ workspaceFolder: workspace })
      const depot = {
        resourceUri: '//depot/branch_x/a.ts',
        scmResourceGroupId: 'shelved:1',
        noHostFile: true,
      }
      await harness.run(SendScmResourceToAgentChatAction, [depot, [depot]])
      expect(harness.createSession).not.toHaveBeenCalled()
      expect(AcpPromptRefInbox.drain('created-1')).toEqual([])
    })

    it('expands a folder row into its subtree files', async () => {
      const active = fakeSession({ id: 'sess-1', cwd: '/ws' })
      const harness = resourceHarness({ workspaceFolder: workspace, activeSession: active })
      await harness.run(SendScmResourceToAgentChatAction, [
        { resourceUri: '/ws/src', isDirectory: true, scmResourceGroupId: 'changes' },
        [
          { resourceUri: '/ws/src/a.ts', scmResourceGroupId: 'changes' },
          { resourceUri: '/ws/src/b.ts', scmResourceGroupId: 'changes' },
        ],
      ])
      expect(AcpPromptRefInbox.drain('sess-1').map((ref) => [ref.kind, ref.label])).toEqual([
        ['file', 'src/a.ts'],
        ['file', 'src/b.ts'],
      ])
    })

    it('sends nothing for an empty folder row', async () => {
      const harness = resourceHarness({ workspaceFolder: workspace })
      await harness.run(SendScmResourceToAgentChatAction, [
        { resourceUri: '/ws/empty', isDirectory: true, scmResourceGroupId: 'changes' },
        [],
      ])
      expect(harness.createSession).not.toHaveBeenCalled()
    })

    it('reattaches a remote authority to host paths', async () => {
      const remoteFolder = URI.parse('remote-ssh://host/repo')
      const active = fakeSession({ id: 'sess-1', cwd: '/repo' })
      const harness = resourceHarness({
        workspaceFolder: remoteFolder,
        activeSession: active,
      })
      const arg = { resourceUri: '/repo/src/a.ts', scmResourceGroupId: 'changes' }
      await harness.run(SendScmResourceToAgentChatAction, [arg, [arg]])
      expect(AcpPromptRefInbox.drain('sess-1')).toEqual([
        expect.objectContaining({
          label: 'src/a.ts',
          uri: 'remote-ssh://host/repo/src/a.ts',
        }),
      ])
    })
  })
})
