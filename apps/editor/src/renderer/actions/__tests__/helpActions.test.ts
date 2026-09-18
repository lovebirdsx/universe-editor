import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IDialogService,
  INotificationService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  Severity,
  registerAction2,
  type IConfirmOptions,
  type IConfirmResult,
  type IDisposable,
} from '@universe-editor/platform'
import { IDiagnosticsService, type HeapSnapshotStatus } from '../../../shared/ipc/services.js'
import {
  OpenExtensionDocsAction,
  OpenHeapSnapshotsFolderAction,
  ShowReleaseNotesAction,
  StartHeapSnapshotDiagnosticsAction,
  StopHeapSnapshotDiagnosticsAction,
  confirmHeapSnapshotStart,
} from '../helpActions.js'

function helpMenuEntry(commandId: string) {
  return MenuRegistry.getMenuItems(MenuId.MenubarHelpMenu).find(
    (item) => 'command' in item && item.command === commandId,
  )
}

function paletteEntry(commandId: string) {
  return MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
    (item) => 'command' in item && item.command === commandId,
  )
}

describe('helpActions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers Show Release Notes in the Help menu', () => {
    disposables.push(registerAction2(ShowReleaseNotesAction))

    expect(helpMenuEntry(ShowReleaseNotesAction.ID)).toMatchObject({ group: '0_docs', order: 4 })
  })

  it('registers Extension Development in the Help menu ahead of Release Notes', () => {
    disposables.push(registerAction2(OpenExtensionDocsAction))

    expect(helpMenuEntry(OpenExtensionDocsAction.ID)).toMatchObject({
      group: '0_docs',
      order: 3,
    })
  })
})

const STATUS: HeapSnapshotStatus = {
  active: true,
  phase: 'baseline',
  attempts: 0,
  attemptLimit: 2,
  appAttempts: 0,
  appAttemptLimit: 4,
  artifacts: 0,
  bytes: 0,
}

function makeDialogs(choice: IConfirmResult['choice']): IDialogService & {
  options: IConfirmOptions[]
} {
  const options: IConfirmOptions[] = []
  return {
    _serviceBrand: undefined,
    options,
    confirm: (opts) => {
      options.push(opts)
      return Promise.resolve({ confirmed: choice === 'primary', choice })
    },
    prompt: () => Promise.resolve(undefined),
  }
}

function makeNotifications(): INotificationService & {
  messages: Array<{ severity: Severity; message: string; sticky?: boolean }>
} {
  const messages: Array<{ severity: Severity; message: string; sticky?: boolean }> = []
  return {
    ...({} as INotificationService),
    messages,
    notify: (options: { severity: Severity; message: string; sticky?: boolean }) => {
      messages.push(options)
      return { close: () => {} } as never
    },
  }
}

function makeDiagnostics(overrides: Record<string, unknown> = {}) {
  return {
    _serviceBrand: undefined,
    getHeapSnapshotStatus: vi.fn().mockResolvedValue({ ...STATUS, active: false, phase: 'off' }),
    startHeapSnapshotRound: vi.fn().mockResolvedValue(STATUS),
    stopHeapSnapshotRound: vi
      .fn()
      .mockResolvedValue({ ...STATUS, active: false, phase: 'stopped' }),
    revealHeapSnapshotsFolder: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function runCommand(id: string, services: ServiceCollection): Promise<void> {
  const inst = new InstantiationService(services)
  await inst.invokeFunction(async (accessor) => {
    await CommandsRegistry.getCommand(id)!.handler(accessor)
  })
}

describe('heap snapshot commands', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    vi.clearAllMocks()
  })

  function registerAll(): void {
    disposables.push(registerAction2(StartHeapSnapshotDiagnosticsAction))
    disposables.push(registerAction2(StopHeapSnapshotDiagnosticsAction))
    disposables.push(registerAction2(OpenHeapSnapshotsFolderAction))
  }

  const HELP_MENU_ORDERS: Readonly<Record<string, number>> = {
    [StartHeapSnapshotDiagnosticsAction.ID]: 5,
    [StopHeapSnapshotDiagnosticsAction.ID]: 6,
    [OpenHeapSnapshotsFolderAction.ID]: 7,
  }

  it('puts the three commands in the Help menu, below the developer tools', () => {
    // They are reachable from the menubar like every other Help entry; the consent
    // dialog the start command raises is the same one the palette raises, so a menubar
    // placement costs nothing and is how the feature is meant to be found.
    registerAll()
    for (const [id, order] of Object.entries(HELP_MENU_ORDERS)) {
      expect(CommandsRegistry.getCommand(id), id).toBeDefined()
      expect(paletteEntry(id), id).toBe(true)
      expect(helpMenuEntry(id), id).toMatchObject({ group: '5_tools', order })
    }
  })

  it('omits the icon these Help entries would otherwise turn into a column', () => {
    // `registerAction2` copies `desc.icon` into every declared menu slot, and the Help
    // dropdown switches on an icon column for the whole group as soon as one entry has
    // one (`iconCoverage.test.ts` asserts all menubar menus stay icon-free). The icon
    // buys nothing here either: the command palette never reads command icons.
    registerAll()
    for (const id of Object.keys(HELP_MENU_ORDERS)) {
      expect(helpMenuEntry(id)?.icon, id).toBeUndefined()
    }
  })

  it('spells out the freeze, the contents, the scope and what stopping does', async () => {
    const dialogs = makeDialogs('cancel')
    await confirmHeapSnapshotStart(dialogs)
    const options = dialogs.options[0]
    expect(options?.type).toBe('warning')
    expect(options?.detail).toContain('Only this window')
    expect(options?.detail).toContain('pauses this window')
    expect(options?.detail).toContain('credentials')
    expect(options?.detail).toContain('never uploaded automatically')
    // The one people get wrong: stop ends the diagnosis, not the capture already running.
    expect(options?.detail).toContain('does not cancel a snapshot that has already started')
  })

  it('does not arm anything when the consent dialog is dismissed', async () => {
    registerAll()
    const diagnostics = makeDiagnostics()
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(IDialogService, makeDialogs('cancel') as never)
    services.set(INotificationService, notifications as never)

    await runCommand(StartHeapSnapshotDiagnosticsAction.ID, services)

    expect(diagnostics.startHeapSnapshotRound).not.toHaveBeenCalled()
    expect(notifications.messages).toEqual([])
  })

  it('arms the round and leaves the report to the round’s own events', async () => {
    // 开局有一条轮次事件（「内存诊断已开启…」）；命令再报一次就是两条通知说同一件事。
    registerAll()
    const diagnostics = makeDiagnostics()
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(IDialogService, makeDialogs('primary') as never)
    services.set(INotificationService, notifications as never)

    await runCommand(StartHeapSnapshotDiagnosticsAction.ID, services)

    expect(diagnostics.startHeapSnapshotRound).toHaveBeenCalledTimes(1)
    expect(notifications.messages).toEqual([])
  })

  it('answers a second start with the current status instead of another round', async () => {
    // 已武装时再点一次不重置额度，也不该再弹一次同意框；用户要的是「现在怎么样了」。
    registerAll()
    const diagnostics = makeDiagnostics({
      getHeapSnapshotStatus: vi.fn().mockResolvedValue(STATUS),
    })
    const dialogs = makeDialogs('primary')
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(IDialogService, dialogs as never)
    services.set(INotificationService, notifications as never)

    await runCommand(StartHeapSnapshotDiagnosticsAction.ID, services)

    expect(diagnostics.startHeapSnapshotRound).not.toHaveBeenCalled()
    expect(dialogs.options).toEqual([])
    expect(notifications.messages[0]?.severity).toBe(Severity.Info)
    expect(notifications.messages[0]?.sticky).toBeFalsy()
    expect(notifications.messages[0]?.message).toContain('0/2')
  })

  it('reports why a start was refused through the round’s event, not twice', async () => {
    // 拒绝（额度用尽 / 没有可采集的渲染进程）走的是轮次的停止事件，命令不再复述。
    registerAll()
    const diagnostics = makeDiagnostics({
      startHeapSnapshotRound: vi.fn().mockResolvedValue({
        ...STATUS,
        active: false,
        phase: 'stopped',
        code: 'app-quota-exhausted',
      }),
    })
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(IDialogService, makeDialogs('primary') as never)
    services.set(INotificationService, notifications as never)

    await runCommand(StartHeapSnapshotDiagnosticsAction.ID, services)

    expect(diagnostics.startHeapSnapshotRound).toHaveBeenCalledTimes(1)
    expect(notifications.messages).toEqual([])
  })

  it('says so when this build has no snapshot service behind the command', async () => {
    // 没有事件可等的唯一结局：用户点了「开始」，但没人接这一单。
    registerAll()
    const diagnostics = makeDiagnostics({
      startHeapSnapshotRound: vi.fn().mockResolvedValue({ ...STATUS, active: false, phase: 'off' }),
    })
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(IDialogService, makeDialogs('primary') as never)
    services.set(INotificationService, notifications as never)

    await runCommand(StartHeapSnapshotDiagnosticsAction.ID, services)

    expect(notifications.messages[0]?.severity).toBe(Severity.Error)
    expect(notifications.messages[0]?.message).toContain('nothing was started')
  })

  it('surfaces a service call that failed instead of doing nothing visible', async () => {
    registerAll()
    const diagnostics = makeDiagnostics({
      startHeapSnapshotRound: vi.fn().mockRejectedValue(new Error('channel closed')),
    })
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(IDialogService, makeDialogs('primary') as never)
    services.set(INotificationService, notifications as never)

    await runCommand(StartHeapSnapshotDiagnosticsAction.ID, services)

    expect(notifications.messages[0]?.severity).toBe(Severity.Error)
    expect(notifications.messages[0]?.message).toContain('channel closed')
  })

  it('reports a failing stop the same way', async () => {
    registerAll()
    const diagnostics = makeDiagnostics({
      stopHeapSnapshotRound: vi.fn().mockRejectedValue(new Error('channel closed')),
    })
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(INotificationService, notifications as never)

    await runCommand(StopHeapSnapshotDiagnosticsAction.ID, services)

    expect(notifications.messages[0]?.severity).toBe(Severity.Error)
    expect(notifications.messages[0]?.message).toContain('channel closed')
  })

  it('never says "stopped" while a capture is still being written', async () => {
    // `takeHeapSnapshot` cannot be cancelled: claiming it stopped would have the user
    // believe the freeze ended while the window is still paused.
    registerAll()
    const diagnostics = makeDiagnostics({
      stopHeapSnapshotRound: vi.fn().mockResolvedValue({ ...STATUS, phase: 'capturing' }),
    })
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(INotificationService, notifications as never)

    await runCommand(StopHeapSnapshotDiagnosticsAction.ID, services)

    expect(notifications.messages[0]?.severity).toBe(Severity.Warning)
    expect(notifications.messages[0]?.sticky).toBe(true)
    expect(notifications.messages[0]?.message).toContain('cannot be cancelled')
  })

  it('reports a plain stop as a status', async () => {
    registerAll()
    const diagnostics = makeDiagnostics()
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(INotificationService, notifications as never)

    await runCommand(StopHeapSnapshotDiagnosticsAction.ID, services)

    expect(diagnostics.stopHeapSnapshotRound).toHaveBeenCalledTimes(1)
    expect(notifications.messages[0]?.severity).toBe(Severity.Info)
    expect(notifications.messages[0]?.sticky).toBeFalsy()
  })

  it('surfaces a snapshot folder the OS refused to open', async () => {
    registerAll()
    const diagnostics = makeDiagnostics({
      revealHeapSnapshotsFolder: vi.fn().mockRejectedValue(new Error('no handler registered')),
    })
    const notifications = makeNotifications()
    const services = new ServiceCollection()
    services.set(IDiagnosticsService, diagnostics as never)
    services.set(INotificationService, notifications as never)

    await runCommand(OpenHeapSnapshotsFolderAction.ID, services)

    expect(notifications.messages[0]?.severity).toBe(Severity.Error)
    expect(notifications.messages[0]?.message).toContain('no handler registered')
  })
})
