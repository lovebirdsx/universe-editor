import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ConfigurationTarget,
  IConfigurationService,
  ILoggerService,
  ILayoutService,
  IOutputService,
  IQuickInputService,
  InstantiationService,
  LogLevel,
  MenuId,
  MenuRegistry,
  NullLogger,
  PartId,
  ServiceCollection,
  registerAction2,
  type IDisposable,
  type IQuickPickItem,
  type IStorageService,
} from '@universe-editor/platform'
import { ILogFilesService, type LogFileDescriptor } from '../../../shared/ipc/services.js'
import { OutputService } from '../../services/output/OutputService.js'
import {
  OpenLogsFolderAction,
  RefreshLogOutputAction,
  SetLogLevelAction,
  ShowLogsAction,
  ShowOutputChannelAction,
} from '../logActions.js'

const descriptor: LogFileDescriptor = {
  id: '20260521T100000/main.log',
  name: 'Main',
  channelId: 'main',
  sessionStartedAt: '2026-05-21 10:00:00',
  size: 12,
  modifiedTime: 1,
}

function makeLayoutService() {
  return {
    _serviceBrand: undefined,
    setVisible: vi.fn(),
    getPart: vi.fn(() => ({ focus: vi.fn() })),
  }
}

function makeLogFilesService(overrides: Partial<ReturnType<typeof baseLogFilesService>> = {}) {
  return { ...baseLogFilesService(), ...overrides }
}

function baseLogFilesService() {
  return {
    _serviceBrand: undefined,
    listLogFiles: vi.fn().mockResolvedValue([descriptor]),
    readLogFile: vi.fn().mockResolvedValue('hello log'),
    resolveLogPath: vi.fn().mockResolvedValue('/userData/logs/20260521T100000/main.log'),
    openLogsFolder: vi.fn().mockResolvedValue(undefined),
    setLogLevel: vi.fn().mockResolvedValue(undefined),
    getLogLevel: vi.fn().mockResolvedValue(LogLevel.Info),
  }
}

async function runCommand(id: string, services: ServiceCollection): Promise<void> {
  const inst = new InstantiationService(services)
  await inst.invokeFunction(async (accessor) => {
    await CommandsRegistry.getCommand(id)!.handler(accessor)
  })
}

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

describe('logActions', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    vi.clearAllMocks()
  })

  it('ShowLogsAction picks a log, reads it, and activates a Log output channel', async () => {
    disposables.push(registerAction2(ShowLogsAction))
    const output = new OutputService(makeStorage())
    const layout = makeLayoutService()
    const pick = vi.fn(async (items: readonly IQuickPickItem[]) => items[0])
    const logFiles = makeLogFilesService()
    const services = new ServiceCollection()
    services.set(ILogFilesService, logFiles as never)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    services.set(IOutputService, output)
    services.set(ILayoutService, layout as never)

    await runCommand(ShowLogsAction.ID, services)

    expect(logFiles.listLogFiles).toHaveBeenCalledTimes(1)
    expect(logFiles.readLogFile).toHaveBeenCalledWith(descriptor.id, 1024 * 1024)
    expect(output.activeChannelName.get()).toBe('Main')
    expect(output.activeChannelContent.get()).toBe('hello log')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
  })

  it('ShowLogsAction does nothing after the user cancels the quick pick', async () => {
    disposables.push(registerAction2(ShowLogsAction))
    const output = new OutputService(makeStorage())
    const layout = makeLayoutService()
    const pick = vi.fn().mockResolvedValue(undefined)
    const logFiles = makeLogFilesService()
    const services = new ServiceCollection()
    services.set(ILogFilesService, logFiles as never)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    services.set(IOutputService, output)
    services.set(ILayoutService, layout as never)

    await runCommand(ShowLogsAction.ID, services)

    expect(logFiles.readLogFile).not.toHaveBeenCalled()
    expect(output.getChannels()).toHaveLength(0)
    expect(layout.setVisible).not.toHaveBeenCalled()
  })

  it('ShowLogsAction opens a message in Output when no logs exist', async () => {
    disposables.push(registerAction2(ShowLogsAction))
    const output = new OutputService(makeStorage())
    const layout = makeLayoutService()
    const pick = vi.fn()
    const logFiles = makeLogFilesService({
      listLogFiles: vi.fn().mockResolvedValue([]),
    })
    const services = new ServiceCollection()
    services.set(ILogFilesService, logFiles as never)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    services.set(IOutputService, output)
    services.set(ILayoutService, layout as never)

    await runCommand(ShowLogsAction.ID, services)

    expect(pick).not.toHaveBeenCalled()
    expect(output.activeChannelName.get()).toBe('Logs')
    expect(output.activeChannelContent.get()).toContain('No log files found.')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
  })

  it('OpenLogsFolderAction calls the main-side log files service and appears in Help tools', async () => {
    disposables.push(registerAction2(OpenLogsFolderAction))
    const logFiles = makeLogFilesService()
    const services = new ServiceCollection()
    services.set(ILogFilesService, logFiles as never)

    await runCommand(OpenLogsFolderAction.ID, services)

    expect(logFiles.openLogsFolder).toHaveBeenCalledTimes(1)
    const entry = MenuRegistry.getMenuItems(MenuId.MenubarHelpMenu).find(
      (item) => 'command' in item && item.command === OpenLogsFolderAction.ID,
    )
    expect(entry).toMatchObject({ group: '5_tools' })
  })

  it('RefreshLogOutputAction re-reads the log file matching the active Log (X) channel', async () => {
    disposables.push(registerAction2(RefreshLogOutputAction))
    const output = new OutputService(makeStorage())
    const layout = makeLayoutService()
    const logFiles = makeLogFilesService()
    output.createChannel(`${descriptor.name}`, 'log')
    output.setActiveChannel(`${descriptor.name}`)
    const services = new ServiceCollection()
    services.set(ILogFilesService, logFiles as never)
    services.set(IOutputService, output)
    services.set(ILayoutService, layout as never)

    await runCommand(RefreshLogOutputAction.ID, services)

    expect(logFiles.listLogFiles).toHaveBeenCalledTimes(1)
    expect(logFiles.readLogFile).toHaveBeenCalledWith(descriptor.id, 1024 * 1024)
    expect(output.activeChannelContent.get()).toBe('hello log')
  })

  it('RefreshLogOutputAction is a no-op when no Log channel is active', async () => {
    disposables.push(registerAction2(RefreshLogOutputAction))
    const output = new OutputService(makeStorage())
    const layout = makeLayoutService()
    const logFiles = makeLogFilesService()
    const services = new ServiceCollection()
    services.set(ILogFilesService, logFiles as never)
    services.set(IOutputService, output)
    services.set(ILayoutService, layout as never)

    await runCommand(RefreshLogOutputAction.ID, services)

    expect(logFiles.listLogFiles).not.toHaveBeenCalled()
    expect(logFiles.readLogFile).not.toHaveBeenCalled()
  })

  it('SetLogLevelAction updates renderer and main logger levels', async () => {
    disposables.push(registerAction2(SetLogLevelAction))
    const info = vi.fn()
    const loggerService = {
      _serviceBrand: undefined,
      createLogger: vi.fn(() => ({ ...new NullLogger(), info })),
      setLevel: vi.fn(),
      getLevel: vi.fn(() => LogLevel.Info),
    }
    const pick = vi.fn(async (items: readonly (IQuickPickItem & { level: LogLevel })[]) =>
      items.find((item) => item.level === LogLevel.Debug),
    )
    const logFiles = makeLogFilesService()
    const configurationService = {
      _serviceBrand: undefined,
      get: vi.fn(),
      update: vi.fn(),
      loadLayer: vi.fn(),
      getLayerSnapshot: vi.fn(() => ({})),
      getValueOrigin: vi.fn(),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    }
    const services = new ServiceCollection()
    services.set(ILogFilesService, logFiles as never)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    services.set(ILoggerService, loggerService as never)
    services.set(IConfigurationService, configurationService as never)

    await runCommand(SetLogLevelAction.ID, services)

    expect(logFiles.getLogLevel).toHaveBeenCalledTimes(1)
    expect(logFiles.setLogLevel).toHaveBeenCalledWith(LogLevel.Debug)
    expect(loggerService.setLevel).toHaveBeenCalledWith(LogLevel.Debug)
    expect(configurationService.update).toHaveBeenCalledWith(
      'logging.level',
      'debug',
      ConfigurationTarget.User,
    )
    expect(info).toHaveBeenCalledWith('Log level set to Debug')
  })

  it('ShowOutputChannelAction sorts All first and activates the chosen channel', async () => {
    disposables.push(registerAction2(ShowOutputChannelAction))
    const output = new OutputService(makeStorage())
    output.createChannel('Main', 'log')
    output.createChannel('Console', 'log')
    output.createChannel('All', 'aggregated')
    const layout = makeLayoutService()
    const pick = vi.fn(async (items: readonly IQuickPickItem[]) => {
      // First option must be 'All' (sorted to top).
      expect(items[0]?.label).toBe('All')
      return items.find((item) => item.label === 'Console')
    })
    const services = new ServiceCollection()
    services.set(IOutputService, output)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    services.set(ILayoutService, layout as never)

    await runCommand(ShowOutputChannelAction.ID, services)

    expect(pick).toHaveBeenCalledTimes(1)
    expect(output.activeChannelName.get()).toBe('Console')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
  })

  it('ShowOutputChannelAction does nothing when the user cancels the pick', async () => {
    disposables.push(registerAction2(ShowOutputChannelAction))
    const output = new OutputService(makeStorage())
    output.createChannel('Main', 'log')
    const before = output.activeChannelName.get()
    const layout = makeLayoutService()
    const pick = vi.fn().mockResolvedValue(undefined)
    const services = new ServiceCollection()
    services.set(IOutputService, output)
    services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)
    services.set(ILayoutService, layout as never)

    await runCommand(ShowOutputChannelAction.ID, services)

    expect(output.activeChannelName.get()).toBe(before)
    expect(layout.setVisible).not.toHaveBeenCalled()
  })
})
