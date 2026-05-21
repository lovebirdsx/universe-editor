/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Developer log viewing and log-level commands.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ILoggerService,
  ILayoutService,
  IOutputService,
  IQuickInputService,
  LogLevel,
  MenuId,
  PartId,
  localize,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { ILogFilesService, type LogFileDescriptor } from '../../shared/ipc/services.js'

const LOG_READ_MAX_BYTES = 1024 * 1024
const EMPTY_LOG_CHANNEL = 'Log'

interface LogFileQuickPickItem extends IQuickPickItem {
  readonly descriptor: LogFileDescriptor
}

interface LogLevelQuickPickItem extends IQuickPickItem {
  readonly level: LogLevel
}

let lastLogFileId: string | undefined

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function channelNameForLog(descriptor: LogFileDescriptor): string {
  return `Log (${descriptor.name})`
}

function revealOutputPanel(layoutService: ILayoutService): void {
  layoutService.setVisible(PartId.Panel, true)
  layoutService.getPart(PartId.Panel)?.focus()
}

async function writeLogToOutput(
  logFilesService: ILogFilesService,
  outputService: IOutputService,
  layoutService: ILayoutService,
  descriptor: LogFileDescriptor,
): Promise<void> {
  const content = await logFilesService.readLogFile(descriptor.id, LOG_READ_MAX_BYTES)
  const channelName = channelNameForLog(descriptor)
  const channel = outputService.createChannel(channelName)
  channel.clear()
  channel.append(content)
  outputService.setActiveChannel(channelName)
  lastLogFileId = descriptor.id
  revealOutputPanel(layoutService)
}

function showNoLogs(outputService: IOutputService, layoutService: ILayoutService): void {
  const channel = outputService.createChannel(EMPTY_LOG_CHANNEL)
  channel.clear()
  channel.appendLine(localize('logs.noneFound', 'No log files found.'))
  outputService.setActiveChannel(EMPTY_LOG_CHANNEL)
  revealOutputPanel(layoutService)
}

const LOG_LEVEL_ITEMS: readonly LogLevelQuickPickItem[] = [
  { id: 'trace', label: 'Trace', level: LogLevel.Trace },
  { id: 'debug', label: 'Debug', level: LogLevel.Debug },
  { id: 'info', label: 'Info', level: LogLevel.Info },
  { id: 'warning', label: 'Warning', level: LogLevel.Warning },
  { id: 'error', label: 'Error', level: LogLevel.Error },
  { id: 'off', label: 'Off', level: LogLevel.Off },
]

export class ShowLogsAction extends Action2 {
  static readonly ID = 'workbench.action.showLogs'

  constructor() {
    super({
      id: ShowLogsAction.ID,
      title: localize('action.showLogs.title', 'Developer: Show Logs...'),
      category: localize('command.category.help', 'Help'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const logFilesService = accessor.get(ILogFilesService)
    const quickInputService = accessor.get(IQuickInputService)
    const outputService = accessor.get(IOutputService)
    const layoutService = accessor.get(ILayoutService)
    const descriptors = await logFilesService.listLogFiles()
    if (descriptors.length === 0) {
      showNoLogs(outputService, layoutService)
      return
    }

    const items: LogFileQuickPickItem[] = descriptors.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.name,
      description: `${descriptor.date} - ${formatBytes(descriptor.size)}`,
      detail: descriptor.channelId,
      descriptor,
    }))
    const selected = await quickInputService.pick(items, {
      id: 'workbench.logs',
      placeholder: localize('quickInput.logs.placeholder', 'Select a log file'),
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (!selected) return
    await writeLogToOutput(logFilesService, outputService, layoutService, selected.descriptor)
  }
}

export class RefreshLogOutputAction extends Action2 {
  static readonly ID = 'workbench.action.refreshLogOutput'

  constructor() {
    super({
      id: RefreshLogOutputAction.ID,
      title: localize('action.refreshLogOutput.title', 'Developer: Refresh Log Output'),
      category: localize('command.category.help', 'Help'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    if (!lastLogFileId) return
    const logFilesService = accessor.get(ILogFilesService)
    const outputService = accessor.get(IOutputService)
    const layoutService = accessor.get(ILayoutService)
    const descriptors = await logFilesService.listLogFiles()
    const descriptor = descriptors.find((candidate) => candidate.id === lastLogFileId)
    if (!descriptor) return
    await writeLogToOutput(logFilesService, outputService, layoutService, descriptor)
  }
}

export class OpenLogsFolderAction extends Action2 {
  static readonly ID = 'workbench.action.openLogsFolder'

  constructor() {
    super({
      id: OpenLogsFolderAction.ID,
      title: localize('action.openLogsFolder.title', 'Developer: Open Logs Folder'),
      category: localize('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '5_tools', order: 2 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const logFilesService = accessor.get(ILogFilesService)
    await logFilesService.openLogsFolder()
  }
}

export class SetLogLevelAction extends Action2 {
  static readonly ID = 'workbench.action.setLogLevel'

  constructor() {
    super({
      id: SetLogLevelAction.ID,
      title: localize('action.setLogLevel.title', 'Developer: Set Log Level...'),
      category: localize('command.category.help', 'Help'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const logFilesService = accessor.get(ILogFilesService)
    const quickInputService = accessor.get(IQuickInputService)
    const loggerService = accessor.get(ILoggerService)
    const current = await logFilesService.getLogLevel()
    const items = LOG_LEVEL_ITEMS.map((item): LogLevelQuickPickItem => {
      if (item.level !== current) return item
      return { ...item, description: localize('logs.currentLevel', 'Current') }
    })
    const selected = await quickInputService.pick(items, {
      id: 'workbench.logLevel',
      placeholder: localize('quickInput.logLevel.placeholder', 'Select log level'),
    })
    if (!selected) return

    await logFilesService.setLogLevel(selected.level)
    loggerService.setLevel(selected.level)
    loggerService
      .createLogger({ id: 'logActions', name: 'Log Actions' })
      .info(`Log level set to ${selected.label}`)
  }
}
