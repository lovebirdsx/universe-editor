import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IDialogService,
  IEditorService,
  IInstantiationService,
  INotificationService,
  IViewsService,
  ILayoutService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  registerAction2,
  CommandsRegistry,
  type IDisposable,
} from '@universe-editor/platform'
import { RewindAgentSessionAction, ForkAgentSessionAction } from '../agentRewindActions.js'
import {
  AcpForeignWorktreeError,
  IAcpSessionService,
  type IAcpSession,
  type RewindFilesResult,
} from '../../services/acp/acpSessionService.js'
import { IAcpChatLocationService } from '../../services/acp/acpChatLocationService.js'
import { IAcpSessionHistoryService } from '../../services/acp/acpSessionHistory.js'
import { AcpPromptReplaceInbox } from '../../services/acp/acpPromptReplaceInbox.js'

interface FakeSessionOpts {
  readonly rewindSupported?: boolean
  readonly forkSupported?: boolean
  readonly messageText?: string
  readonly messageId?: string
}

function fakeSession(id: string, opts: FakeSessionOpts = {}): IAcpSession {
  const messageId = opts.messageId ?? 'mid-1'
  return {
    id,
    agentId: opts.rewindSupported ? 'claude-code' : 'fake',
    rewindSupported: opts.rewindSupported ?? false,
    forkSupported: observableValue<boolean>('t.fork', opts.forkSupported ?? false),
    messages: observableValue('t.messages', [
      {
        id: 'm1',
        role: 'user',
        blocks: [],
        text: opts.messageText ?? 'hello',
        streaming: false,
        messageId,
      },
    ]),
  } as unknown as IAcpSession
}

interface Harness {
  readonly service: {
    getById: ReturnType<typeof vi.fn>
    rewindSession: ReturnType<typeof vi.fn>
    forkSession: ReturnType<typeof vi.fn>
    setActive: ReturnType<typeof vi.fn>
  }
  readonly dialog: { confirm: ReturnType<typeof vi.fn> }
  readonly notify: ReturnType<typeof vi.fn>
  readonly openEditor: ReturnType<typeof vi.fn>
  readonly location: { location: ReturnType<typeof observableValue<'editor' | 'sidebar'>> }
  run(commandId: string, arg?: unknown): Promise<void>
}

function makeHarness(overrides: Partial<Harness['service']> = {}): Harness {
  const service = {
    getById: vi.fn(),
    rewindSession: vi.fn().mockResolvedValue({ canRewind: true } satisfies RewindFilesResult),
    forkSession: vi.fn(),
    setActive: vi.fn(),
    ...overrides,
  }
  const dialog = { confirm: vi.fn().mockResolvedValue({ confirmed: true }) }
  const notify = vi.fn()
  const openEditor = vi.fn()
  const location = { location: observableValue<'editor' | 'sidebar'>('t.loc', 'editor') }

  const services = new ServiceCollection()
  services.set(IAcpSessionService, service as unknown as IAcpSessionService)
  services.set(IDialogService, dialog as unknown as IDialogService)
  services.set(INotificationService, { notify } as unknown as INotificationService)
  services.set(IEditorService, {
    openEditor,
    activeEditor: observableValue<unknown>('t.active', undefined),
  } as unknown as IEditorService)
  services.set(IAcpChatLocationService, location as unknown as IAcpChatLocationService)
  services.set(ILayoutService, {
    getVisible: () => true,
    toggleVisible: vi.fn(),
  } as unknown as ILayoutService)
  services.set(IViewsService, {
    openViewContainer: vi.fn().mockResolvedValue(undefined),
  } as unknown as IViewsService)
  services.set(IAcpSessionHistoryService, {
    get: () => undefined,
    entries: observableValue('t.entries', []),
  } as unknown as IAcpSessionHistoryService)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)

  return {
    service,
    dialog,
    notify,
    openEditor,
    location,
    run: async (commandId, arg) => {
      await inst.invokeFunction((accessor) =>
        Promise.resolve(CommandsRegistry.getCommand(commandId)!.handler(accessor, arg)),
      )
    },
  }
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

    await h.run(RewindAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    // dry run first, then the real rewind (discard files → empty options).
    expect(h.service.rewindSession).toHaveBeenNthCalledWith(1, 's1', 'mid-1', { dryRun: true })
    expect(h.dialog.confirm).toHaveBeenCalledTimes(1)
    expect(h.service.rewindSession).toHaveBeenNthCalledWith(2, 's1', 'mid-1', {})
    expect(AcpPromptReplaceInbox.drain('s1')).toBe('do the thing')
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
    expect(AcpPromptReplaceInbox.drain('s1')).toBe('retry this')
  })

  it('rewind aborts when the user cancels the three-button dialog', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: true }))
    h.service.rewindSession.mockResolvedValueOnce({ canRewind: true, filesChanged: ['a.ts'] })
    h.dialog.confirm.mockResolvedValue({ choice: 'cancel', confirmed: false })

    await h.run(RewindAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(h.service.rewindSession).toHaveBeenCalledTimes(1) // dry run only
    expect(AcpPromptReplaceInbox.drain('s1')).toBeUndefined()
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

    await h.run(RewindAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(h.service.rewindSession).not.toHaveBeenCalled()
    expect(h.dialog.confirm).not.toHaveBeenCalled()
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

  it('fork creates a new session and opens it as an editor', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.forkSession.mockResolvedValue(fakeSession('s2'))

    await h.run(ForkAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(h.service.forkSession).toHaveBeenCalledWith('s1', 'mid-1')
    expect(h.openEditor).toHaveBeenCalledTimes(1)
  })

  it('fork surfaces a friendly notice for a foreign worktree', async () => {
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.forkSession.mockRejectedValue(new AcpForeignWorktreeError('s1', '/a', '/b'))

    await h.run(ForkAgentSessionAction.ID, { sessionId: 's1', messageId: 'mid-1' })

    expect(h.openEditor).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('both commands ignore calls without a messageId', async () => {
    disposables.push(registerAction2(RewindAgentSessionAction))
    disposables.push(registerAction2(ForkAgentSessionAction))
    const h = makeHarness()
    h.service.getById.mockReturnValue(fakeSession('s1', { rewindSupported: true }))

    await h.run(RewindAgentSessionAction.ID, { sessionId: 's1' })
    await h.run(ForkAgentSessionAction.ID, { sessionId: 's1' })

    expect(h.service.rewindSession).not.toHaveBeenCalled()
    expect(h.service.forkSession).not.toHaveBeenCalled()
  })
})
