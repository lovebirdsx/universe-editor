import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  Event,
  IDialogService,
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  Severity,
  observableValue,
  registerAction2,
  runWithInvocationModifiers,
  type IDisposable,
} from '@universe-editor/platform'
import { RewindAgentSessionAction, ForkAgentSessionAction } from '../agentRewindActions.js'
import {
  AcpForeignWorktreeError,
  IAcpSessionService,
  type AcpMessage,
  type IAcpSession,
  type RewindFilesResult,
} from '../../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../services/acp/session/acpSessionHistory.js'
import { IAcpChatWidgetService } from '../../services/acp/session/acpChatWidgetService.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { AcpSessionEditorInput } from '../../services/acp/session/acpSessionEditorInput.js'
import { AcpPromptReplaceInbox } from '../../services/acp/session/acpPromptReplaceInbox.js'
import type { SelectionContext } from '../../services/acp/promptContext.js'
import { FORK_TIP_ITEM_ID } from '../agentRewindPickItems.js'
import { ACP_SESSION_EDITOR_ACTIVE_WHEN } from '../_agentShared.js'

const SELECTION: SelectionContext = {
  uri: 'file:///repo/src/a.ts',
  relPath: 'src/a.ts',
  text: 'const answer = 42',
  startLine: 7,
  endLine: 7,
  languageId: 'typescript',
}

function userTurn(id: string, messageId: string, text: string): AcpMessage {
  return { id, role: 'user', blocks: [], text, streaming: false, messageId } as AcpMessage
}

function agentTurn(id: string, text: string): AcpMessage {
  return { id, role: 'agent', blocks: [], text, streaming: false } as AcpMessage
}

interface FakeSessionOpts {
  readonly rewindSupported?: boolean
  readonly forkSupported?: boolean
  readonly messageText?: string
  readonly messageId?: string
  readonly messages?: readonly AcpMessage[]
  readonly selectionContexts?: readonly SelectionContext[]
  readonly status?: 'idle' | 'running'
  readonly backgroundTasks?: number
  readonly readOnly?: boolean
}

function fakeSession(id: string, opts: FakeSessionOpts = {}): IAcpSession {
  const messageId = opts.messageId ?? 'mid-1'
  const messages: readonly AcpMessage[] = opts.messages ?? [
    {
      id: 'm1',
      role: 'user',
      blocks: [],
      text: opts.messageText ?? 'hello',
      streaming: false,
      messageId,
      ...(opts.selectionContexts !== undefined
        ? { selectionContexts: opts.selectionContexts }
        : {}),
    },
  ]
  return {
    id,
    agentId: opts.rewindSupported ? 'claude-code' : 'fake',
    readOnly: opts.readOnly ?? false,
    rewindSupported: observableValue<boolean>('t.rewind', opts.rewindSupported ?? false),
    forkSupported: observableValue<boolean>('t.fork', opts.forkSupported ?? false),
    status: observableValue<string>('t.status', opts.status ?? 'idle'),
    sessionIdOnAgent: observableValue<string | undefined>('t.sid', undefined),
    isDormant: observableValue<boolean>('t.dormant', false),
    backgroundTaskCount: observableValue<number>('t.bg', opts.backgroundTasks ?? 0),
    pendingElicitation: observableValue('t.pe', undefined),
    pendingPermission: observableValue('t.pp', undefined),
    messages: observableValue('t.messages', messages),
  } as unknown as IAcpSession
}

interface Harness {
  readonly service: {
    getById: ReturnType<typeof vi.fn>
    rewindSession: ReturnType<typeof vi.fn>
    forkSession: ReturnType<typeof vi.fn>
    setActive: ReturnType<typeof vi.fn>
    activeSessionId: ReturnType<typeof observableValue<string | undefined>>
    activeSession: ReturnType<typeof observableValue<IAcpSession | undefined>>
  }
  readonly dialog: { confirm: ReturnType<typeof vi.fn> }
  readonly notify: ReturnType<typeof vi.fn>
  readonly openEditor: ReturnType<typeof vi.fn>
  readonly quickInput: { pick: ReturnType<typeof vi.fn> }
  readonly focusSessionInput: ReturnType<typeof vi.fn>
  readonly groups: EditorGroupsService
  run(commandId: string, arg?: unknown): Promise<unknown>
}

function makeHarness(overrides: Partial<Harness['service']> = {}): Harness {
  const service = {
    getById: vi.fn(),
    rewindSession: vi.fn().mockResolvedValue({ canRewind: true } satisfies RewindFilesResult),
    forkSession: vi.fn(),
    setActive: vi.fn(),
    activeSessionId: observableValue<string | undefined>('t.activeId', undefined),
    activeSession: observableValue<IAcpSession | undefined>('t.activeSession', undefined),
    ...overrides,
  }
  const dialog = { confirm: vi.fn().mockResolvedValue({ confirmed: true }) }
  const notify = vi.fn()
  const openEditor = vi.fn()
  const quickInput = { pick: vi.fn().mockResolvedValue(undefined) }
  const focusSessionInput = vi.fn()

  const services = new ServiceCollection()
  services.set(IAcpSessionService, service as unknown as IAcpSessionService)
  services.set(IDialogService, dialog as unknown as IDialogService)
  services.set(INotificationService, { notify } as unknown as INotificationService)
  services.set(IEditorService, {
    openEditor,
    activeEditor: observableValue<unknown>('t.active', undefined),
  } as unknown as IEditorService)
  services.set(IQuickInputService, quickInput as unknown as IQuickInputService)
  services.set(IAcpChatWidgetService, { focusSessionInput } as unknown as IAcpChatWidgetService)
  services.set(IAcpSessionHistoryService, {
    get: () => undefined,
    entries: observableValue('t.entries', []),
  } as unknown as IAcpSessionHistoryService)
  services.set(IWorkspaceService, {
    _serviceBrand: undefined,
    current: null,
    onDidChangeWorkspace: Event.None,
  } as unknown as IWorkspaceService)
  services.set(IUriIdentityService, { _serviceBrand: undefined } as unknown as IUriIdentityService)
  const groups = new EditorGroupsService()
  services.set(IEditorGroupsService, groups)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)

  return {
    service,
    dialog,
    notify,
    openEditor,
    quickInput,
    focusSessionInput,
    groups,
    run: async (commandId, arg) => {
      let result: unknown
      await inst.invokeFunction(async (accessor) => {
        result = await CommandsRegistry.getCommand(commandId)!.handler(accessor, arg)
      })
      return result
    },
  }
}

function pickFirst<T extends { id?: string }>(items: readonly T[]): T | undefined {
  return items[0]
}

describe('Rewind / Fork agent session commands', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    AcpPromptReplaceInbox._resetForTests()
    vi.clearAllMocks()
  })

  it('rewind previews, confirms, rewinds and backfills the turn text', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const session = fakeSession('s1', { rewindSupported: true, messageText: 'do the thing' })
    const h = makeHarness()
    h.service.getById.mockReturnValue(session)
    h.service.rewindSession
      .mockResolvedValueOnce({
        canRewind: true,
        filesChanged: ['a.ts'],
        insertions: 3,
        deletions: 1,
      })
      .mockResolvedValueOnce({ canRewind: true })
    // File changes present → three-button dialog; primary = discard & rewind.
    h.dialog.confirm.mockResolvedValue({ choice: 'primary', confirmed: true })

    const result = await h.run(RewindAgentSessionAction.ID, {
      sessionId: 's1',
      messageId: 'mid-1',
    })

    // dry run first, then the real rewind (discard files → empty options).
    expect(h.service.rewindSession).toHaveBeenNthCalledWith(1, 's1', 'mid-1', { dryRun: true })
    expect(h.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(h.service.rewindSession).toHaveBeenNthCalledWith(2, 's1', 'mid-1', {})
    expect(AcpPromptReplaceInbox.drain('s1')).toEqual({ text: 'do the thing', contexts: [] })
    expect(h.focusSessionInput).toHaveBeenCalledWith('s1')
    expect(result).toBe(true)
  })

  it('rewind keeps file changes when the user picks the secondary button', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const session = fakeSession('s1', { rewindSupported: true, messageText: 'retry this' })
    const h = makeHarness()
    h.service.getById.mockReturnValue(session)
    h.service.rewindSession
      .mockResolvedValueOnce({
        canRewind: true,
        filesChanged: ['a.ts', 'b.ts'],
        insertions: 4,
        deletions: 2,
      })
      .mockResolvedValueOnce({ canRewind: true })
    // secondary = keep changes & rewind.
    h.dialog.confirm.mockResolvedValue({ choice: 'secondary', confirmed: false })

    await h.run(RewindAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(h.service.rewindSession).toHaveBeenNthCalledWith(2, 's1', 'mid-1', {
      rewindFiles: false,
    })
    expect(AcpPromptReplaceInbox.drain('s1')).toEqual({ text: 'retry this', contexts: [] })
  })

  it('rewind backfills the turn selection contexts with its text', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const session = fakeSession('s1', {
      rewindSupported: true,
      messageText: 'review this',
      selectionContexts: [SELECTION],
    })
    const h = makeHarness()
    h.service.getById.mockReturnValue(session)

    await h.run(RewindAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(AcpPromptReplaceInbox.drain('s1')).toEqual({
      text: 'review this',
      contexts: [SELECTION],
    })
  })

  it('rewind aborts when the user cancels the three-button dialog', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: true }))
    h.service.rewindSession.mockResolvedValueOnce({ canRewind: true, filesChanged: ['a.ts'] })
    h.dialog.confirm.mockResolvedValue({ choice: 'cancel', confirmed: false })

    const result = await h.run(RewindAgentSessionAction.ID, {
      sessionId: 's1',
      messageId: 'mid-1',
    })

    expect(h.service.rewindSession).toHaveBeenCalledTimes(1) // dry run only
    expect(AcpPromptReplaceInbox.drain('s1')).toBeUndefined()
    expect(result).toBe(false)
  })

  it('rewind aborts when the user declines confirmation', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: true }))
    h.dialog.confirm.mockResolvedValue({ confirmed: false })

    await h.run(RewindAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(h.service.rewindSession).toHaveBeenCalledTimes(1) // dry run only
    expect(AcpPromptReplaceInbox.drain('s1')).toBeUndefined()
  })

  it('rewind no-ops for an unsupported session', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: false }))

    const result = await h.run(RewindAgentSessionAction.ID, {
      sessionId: 's1',
      messageId: 'mid-1',
    })

    expect(h.service.rewindSession).not.toHaveBeenCalled()
    expect(h.dialog.confirm).not.toHaveBeenCalled()
    expect(result).toBe(false)
  })

  it('rewind warns and stops when the agent reports it cannot rewind', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: true }))
    h.service.rewindSession.mockResolvedValueOnce({ canRewind: false, error: 'too old' })

    await h.run(RewindAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(h.dialog.confirm).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('rewind stops when the dry run reports the session is gone', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: true }))
    h.service.rewindSession.mockResolvedValueOnce(undefined)

    const result = await h.run(RewindAgentSessionAction.ID, {
      sessionId: 's1',
      messageId: 'mid-1',
    })

    expect(h.dialog.confirm).not.toHaveBeenCalled()
    expect(AcpPromptReplaceInbox.drain('s1')).toBeUndefined()
    expect(result).toBe(false)
  })

  it('rewind stops without backfilling when the applied rewind returns nothing', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: true }))
    h.service.rewindSession
      .mockResolvedValueOnce({ canRewind: true })
      .mockResolvedValueOnce(undefined)

    const result = await h.run(RewindAgentSessionAction.ID, {
      sessionId: 's1',
      messageId: 'mid-1',
    })

    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(AcpPromptReplaceInbox.drain('s1')).toBeUndefined()
    expect(result).toBe(false)
  })

  it('rewind without an anchor lists user turns and rewinds the picked one', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const session = fakeSession('s1', {
      rewindSupported: true,
      messages: [
        userTurn('m1', 'mid-1', 'first turn'),
        agentTurn('m2', 'answer'),
        userTurn('m3', 'mid-2', 'second turn'),
      ],
    })
    const h = makeHarness()
    h.service.getById.mockReturnValue(session)
    h.quickInput.pick.mockImplementation(async (items: readonly { messageId?: string }[]) =>
      items.find((item) => item.messageId === 'mid-1'),
    )

    const result = await h.run(RewindAgentSessionAction.ID, { sessionId: 's1' })

    const [items] = h.quickInput.pick.mock.calls[0] as [readonly { messageId?: string }[]]
    expect(items.map((item) => item.messageId)).toEqual(['mid-1', 'mid-2'])
    expect(h.service.rewindSession).toHaveBeenNthCalledWith(1, 's1', 'mid-1', { dryRun: true })
    expect(AcpPromptReplaceInbox.drain('s1')).toEqual({ text: 'first turn', contexts: [] })
    expect(result).toBe(true)
  })

  it('rewind returns false when the picker is dismissed', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: true }))

    const result = await h.run(RewindAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.quickInput.pick).toHaveBeenCalledTimes(1)
    expect(h.service.rewindSession).not.toHaveBeenCalled()
    expect(result).toBe(false)
  })

  it('rewind without any usable user message explains instead of opening an empty picker', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(
      fakeSession('s1', { rewindSupported: true, messages: [agentTurn('m1', 'hello')] }),
    )

    const result = await h.run(RewindAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.quickInput.pick).not.toHaveBeenCalled()
    expect(h.service.rewindSession).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(result).toBe(false)
  })

  it('rewind refuses a history-only session', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()

    const result = await h.run(RewindAgentSessionAction.ID, { sessionId: 'gone' })

    expect(h.service.rewindSession).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(result).toBe(false)
  })

  it('rewind refuses a read-only foreign preview', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: true, readOnly: true }))

    const result = await h.run(RewindAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.service.rewindSession).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(result).toBe(false)
  })

  it('rewind says to open a session when the palette runs with nothing active', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()

    const result = await h.run(RewindAgentSessionAction.ID)

    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(result).toBe(false)
  })

  it('fork creates a new session and opens it as an editor', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: true }))
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))

    const result = await h.run(ForkAgentSessionAction.ID, {
      sessionId: 's1',
      messageId: 'mid-1',
    })

    expect(h.service.forkSession).toHaveBeenCalledWith('s1', 'mid-1')
    expect(h.openEditor).toHaveBeenCalledTimes(1)
    expect(result).toBe(true)
  })

  it('fork under Ctrl (palette Ctrl+Enter / Ctrl+click) opens the fork to the right', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    disposables.push(h.groups)
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: true }))
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))

    await runWithInvocationModifiers({ ctrlKey: true }, () =>
      h.run(ForkAgentSessionAction.ID, { sessionId: 's1', fromTip: true }),
    )

    expect(h.openEditor).not.toHaveBeenCalled()
    expect(h.groups.count).toBe(2)
    expect(h.groups.activeGroup.activeEditor).toBeInstanceOf(AcpSessionEditorInput)
  })

  it('fork without an anchor opens the picker and the tip row forks the whole conversation', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(
      fakeSession('s1', {
        forkSupported: true,
        messages: [
          userTurn('m1', 'mid-1', 'first turn'),
          agentTurn('m2', 'answer'),
          userTurn('m3', 'mid-2', 'second turn'),
        ],
      }),
    )
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))
    h.quickInput.pick.mockImplementation(async (items: readonly { id?: string }[]) =>
      items.find((item) => item.id === FORK_TIP_ITEM_ID),
    )

    const result = await h.run(ForkAgentSessionAction.ID, { sessionId: 's1' })

    const [items] = h.quickInput.pick.mock.calls[0] as [readonly { id?: string }[]]
    expect(items[0]?.id).toBe(FORK_TIP_ITEM_ID)
    // The first user turn has no predecessor to slice at, so it is not offered.
    expect(items.map((item) => item.id)).toEqual([FORK_TIP_ITEM_ID, 'msg:mid-2'])
    expect(h.service.forkSession).toHaveBeenCalledWith('s1', undefined)
    expect(result).toBe(true)
  })

  it('fork picker can anchor on a user message', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(
      fakeSession('s1', {
        forkSupported: true,
        messages: [userTurn('m1', 'mid-1', 'first turn'), userTurn('m2', 'mid-2', 'second turn')],
      }),
    )
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))
    h.quickInput.pick.mockResolvedValue({ id: 'msg:mid-2', messageId: 'mid-2' })

    await h.run(ForkAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.service.forkSession).toHaveBeenCalledWith('s1', 'mid-2')
  })

  it('fork picker honours Ctrl at acceptance for a side-by-side fork', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    disposables.push(h.groups)
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: true }))
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))
    h.quickInput.pick.mockImplementation(
      async (_items: readonly unknown[], options: { keyMods?: { ctrl: boolean } }) => {
        if (options.keyMods !== undefined) options.keyMods.ctrl = true
        return { id: FORK_TIP_ITEM_ID, fromTip: true }
      },
    )

    await h.run(ForkAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.openEditor).not.toHaveBeenCalled()
    expect(h.groups.count).toBe(2)
  })

  it('fork returns false when the picker is dismissed', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: true }))

    const result = await h.run(ForkAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.service.forkSession).not.toHaveBeenCalled()
    expect(result).toBe(false)
  })

  it('fork from the timeline tip skips the picker', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: true }))
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))

    const result = await h.run(ForkAgentSessionAction.ID, {
      sessionId: 's1',
      fromTip: true,
    })

    expect(h.quickInput.pick).not.toHaveBeenCalled()
    expect(h.service.forkSession).toHaveBeenCalledWith('s1', undefined)
    expect(result).toBe(true)
  })

  it('fork on a history-only row forks from its tip without a picker', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))

    const result = await h.run(ForkAgentSessionAction.ID, { sessionId: 'history-1' })

    expect(h.quickInput.pick).not.toHaveBeenCalled()
    expect(h.service.forkSession).toHaveBeenCalledWith('history-1', undefined)
    expect(result).toBe(true)
  })

  it('fork resolves the session named by an editor tab resource', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))

    await h.run(ForkAgentSessionAction.ID, {
      resource: { path: '/acp/session/s1' },
      fromTip: true,
    })

    expect(h.service.forkSession).toHaveBeenCalledWith('s1', undefined)
  })

  it('fork from the command palette targets the active session', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    const session = fakeSession('s1', { forkSupported: true })
    h.service.getById.mockReturnValue(session)
    h.service.activeSession.set(session, undefined)
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))
    h.quickInput.pick.mockImplementation(pickFirst)

    await h.run(ForkAgentSessionAction.ID)

    expect(h.service.forkSession).toHaveBeenCalledWith('s1', undefined)
  })

  it('fork warns and stops while the session is running', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: true, status: 'running' }))

    await h.run(ForkAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.service.forkSession).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  // The prompt RPC having settled is not the end of the work: forking then
  // would capture a tip the background task is still appending to.
  it('fork warns and stops while background tasks outlive the settled turn', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(
      fakeSession('s1', { forkSupported: true, status: 'idle', backgroundTasks: 1 }),
    )

    await h.run(ForkAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.service.forkSession).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('fork warns and stops for an agent without fork support', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: false }))

    const result = await h.run(ForkAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.service.forkSession).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(result).toBe(false)
  })

  it('fork warns and stops for a read-only foreign preview', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: true, readOnly: true }))

    const result = await h.run(ForkAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.service.forkSession).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(result).toBe(false)
  })

  it('fork from the palette warns when there is no forkable active session', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()

    const result = await h.run(ForkAgentSessionAction.ID)

    expect(h.service.forkSession).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(result).toBe(false)
  })

  it('fork surfaces a friendly notice for a foreign worktree', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: true }))
    h.service.forkSession.mockRejectedValue(new AcpForeignWorktreeError('s1', '/a', '/b'))

    await h.run(ForkAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(h.openEditor).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('fork maps a missing sessionCapabilities.fork to the unsupported notice', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { forkSupported: true }))
    h.service.forkSession.mockRejectedValue(
      new Error('Agent does not support sessionCapabilities.fork'),
    )

    await h.run(ForkAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(h.notify).toHaveBeenCalledWith({
      severity: Severity.Error,
      message: 'This agent does not support forking sessions.',
    })
  })
})

describe('Rewind / Fork command registration', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function whenFor(menu: MenuId, command: string): string | undefined {
    const when = MenuRegistry.getMenuItems(menu).find(
      (item) => 'command' in item && item.command === command,
    )?.when
    return typeof when === 'string' ? when : when?.serialize()
  }

  it('lists Rewind in the palette only while a session editor is active', () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    disposables.push(registerAction2(ForkAgentSessionAction))

    expect(whenFor(MenuId.CommandPalette, RewindAgentSessionAction.ID)).toBe(
      ACP_SESSION_EDITOR_ACTIVE_WHEN,
    )
    expect(whenFor(MenuId.CommandPalette, ForkAgentSessionAction.ID)).toBeUndefined()
  })

  it('adds both commands to the session editor tab context menu', () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    disposables.push(registerAction2(ForkAgentSessionAction))

    expect(whenFor(MenuId.EditorTabContext, RewindAgentSessionAction.ID)).toBe(
      `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
    )
    expect(whenFor(MenuId.EditorTabContext, ForkAgentSessionAction.ID)).toBe(
      `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
    )
  })

  it('binds Ctrl+Alt+Shift+Z / F only while the session editor is focused', () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    disposables.push(registerAction2(ForkAgentSessionAction))

    const context = new ContextKeyService()
    context.createKey<boolean>('editorAreaFocus', true)
    context.createKey<string>('activeEditorTypeId', AcpSessionEditorInput.TYPE_ID)

    expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+shift+z', context)).toBe(
      RewindAgentSessionAction.ID,
    )
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+shift+f', context)).toBe(
      ForkAgentSessionAction.ID,
    )

    const elsewhere = new ContextKeyService()
    elsewhere.createKey<boolean>('editorAreaFocus', false)
    elsewhere.createKey<string>('activeEditorTypeId', 'default')
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+shift+z', elsewhere)).toBeUndefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+shift+f', elsewhere)).toBeUndefined()
  })
})
