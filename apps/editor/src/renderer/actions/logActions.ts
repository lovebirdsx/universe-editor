/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Developer log viewing and log-level commands.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IConfigurationService,
  ConfigurationTarget,
  IEditorGroupsService,
  IInstantiationService,
  ILoggerService,
  ILayoutService,
  IOutputService,
  IQuickInputService,
  IViewsService,
  LogLevel,
  MenuId,
  PartId,
  URI,
  localize,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { ILogFilesService, type LogFileDescriptor } from '../../shared/ipc/services.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { revealOutputPanel } from '../services/output/revealOutputPanel.js'

const LOG_READ_MAX_BYTES = 1024 * 1024
const EMPTY_LOG_CHANNEL = 'Logs'

interface LogFileQuickPickItem extends IQuickPickItem {
  readonly descriptor: LogFileDescriptor
}

interface LogLevelQuickPickItem extends IQuickPickItem {
  readonly level: LogLevel
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatTimeOfDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function channelNameForLog(descriptor: LogFileDescriptor): string {
  return descriptor.name
}

function activeLogChannelName(outputService: IOutputService): string | undefined {
  const ch = outputService.activeChannel
  return ch?.kind === 'log' ? ch.name : undefined
}

async function writeLogToOutput(
  logFilesService: ILogFilesService,
  outputService: IOutputService,
  layoutService: ILayoutService,
  viewsService: IViewsService,
  descriptor: LogFileDescriptor,
): Promise<void> {
  const content = await logFilesService.readLogFile(descriptor.id, LOG_READ_MAX_BYTES)
  const channelName = channelNameForLog(descriptor)
  const channel = outputService.createChannel(channelName, 'log')
  channel.clear()
  channel.append(content)
  outputService.setActiveChannel(channelName)
  revealOutputPanel(layoutService, viewsService)
}

function showNoLogs(
  outputService: IOutputService,
  layoutService: ILayoutService,
  viewsService: IViewsService,
): void {
  const channel = outputService.createChannel(EMPTY_LOG_CHANNEL)
  channel.clear()
  channel.appendLine(localize('logs.noneFound', 'No log files found.'))
  outputService.setActiveChannel(EMPTY_LOG_CHANNEL)
  revealOutputPanel(layoutService, viewsService)
}

const LOG_LEVEL_ITEMS: readonly LogLevelQuickPickItem[] = [
  { id: 'trace', label: 'Trace', level: LogLevel.Trace },
  { id: 'debug', label: 'Debug', level: LogLevel.Debug },
  { id: 'info', label: 'Info', level: LogLevel.Info },
  { id: 'warning', label: 'Warning', level: LogLevel.Warning },
  { id: 'error', label: 'Error', level: LogLevel.Error },
  { id: 'off', label: 'Off', level: LogLevel.Off },
]

const LEVEL_TO_SETTING_VALUE: Record<LogLevel, string> = {
  [LogLevel.Off]: 'off',
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warning]: 'warning',
  [LogLevel.Error]: 'error',
}

export class ShowLogsAction extends Action2 {
  static readonly ID = 'workbench.action.showLogs'

  constructor() {
    super({
      id: ShowLogsAction.ID,
      title: localize('action.showLogs.title', 'Developer: Show Logs...'),
      category: localize('command.category.help', 'Help'),
      keybinding: { primary: 'ctrl+shift+u' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const logFilesService = accessor.get(ILogFilesService)
    const quickInputService = accessor.get(IQuickInputService)
    const outputService = accessor.get(IOutputService)
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const descriptors = await logFilesService.listLogFiles()
    if (descriptors.length === 0) {
      showNoLogs(outputService, layoutService, viewsService)
      return
    }
    const selected = await pickLogFileDescriptor(
      descriptors,
      quickInputService,
      'workbench.logs',
      localize('quickInput.logs.placeholder', 'Select a log file'),
    )
    if (!selected) return
    await writeLogToOutput(logFilesService, outputService, layoutService, viewsService, selected)
  }
}

async function pickLogFileDescriptor(
  descriptors: readonly LogFileDescriptor[],
  quickInputService: IQuickInputService,
  pickId: string,
  placeholder: string,
): Promise<LogFileDescriptor | undefined> {
  const items: LogFileQuickPickItem[] = descriptors.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.name,
    description: `${formatTimeOfDay(descriptor.modifiedTime)} - ${formatBytes(descriptor.size)}`,
    detail: descriptor.channelId,
    descriptor,
  }))
  const selected = await quickInputService.pick(items, {
    id: pickId,
    placeholder,
    matchOnDescription: true,
    matchOnDetail: true,
  })
  return selected?.descriptor
}

export class ShowOutputChannelAction extends Action2 {
  static readonly ID = 'workbench.action.showOutputChannel'

  constructor() {
    super({
      id: ShowOutputChannelAction.ID,
      title: localize('action.showOutputChannel.title', 'Output: Show Output Channels...'),
      category: localize('command.category.view', 'View'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const outputService = accessor.get(IOutputService)
    const quickInputService = accessor.get(IQuickInputService)
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const names = outputService.channelNames.get()
    if (names.length === 0) return

    // Pin "All" first so users land on the cross-channel view by default,
    // mirroring the OutputView dropdown sort order.
    const sorted = [...names].sort((a, b) => {
      if (a === 'All') return -1
      if (b === 'All') return 1
      return a.localeCompare(b)
    })
    const active = outputService.activeChannelName.get()
    const items: IQuickPickItem[] = sorted.map((name) => {
      const channel = outputService.getChannel(name)
      const kindDetail =
        channel?.kind === 'log'
          ? localize('output.channel.kind.log', 'Log channel')
          : localize('output.channel.kind.output', 'Output channel')
      return {
        id: name,
        label: name,
        detail: kindDetail,
        ...(name === active ? { description: localize('output.active', 'Active') } : {}),
      }
    })
    const selected = await quickInputService.pick(items, {
      id: 'workbench.outputChannel',
      placeholder: localize(
        'quickInput.outputChannel.placeholder',
        'Select an Output channel to show',
      ),
    })
    if (!selected?.id) return
    outputService.setActiveChannel(selected.id)
    revealOutputPanel(layoutService, viewsService)
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
    const logFilesService = accessor.get(ILogFilesService)
    const outputService = accessor.get(IOutputService)
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const currentName = activeLogChannelName(outputService)
    if (!currentName) return
    const descriptors = await logFilesService.listLogFiles()
    const descriptor = descriptors.find((candidate) => candidate.name === currentName)
    if (!descriptor) return
    await writeLogToOutput(logFilesService, outputService, layoutService, viewsService, descriptor)
  }
}

export class OpenActiveLogFileAction extends Action2 {
  static readonly ID = 'workbench.action.openActiveLogFile'

  constructor() {
    super({
      id: OpenActiveLogFileAction.ID,
      title: localize('action.openActiveLogFile.title', 'Developer: Open Active Log File'),
      category: localize('command.category.help', 'Help'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const logFilesService = accessor.get(ILogFilesService)
    const outputService = accessor.get(IOutputService)
    const groups = accessor.get(IEditorGroupsService)
    const instantiation = accessor.get(IInstantiationService)
    const currentName = activeLogChannelName(outputService)
    if (!currentName) return
    const descriptors = await logFilesService.listLogFiles()
    const descriptor = descriptors.find((candidate) => candidate.name === currentName)
    if (!descriptor) return
    await openLogDescriptorInEditor(logFilesService, groups, instantiation, descriptor)
  }
}

export class OpenLogFileAction extends Action2 {
  static readonly ID = 'workbench.action.openLogFile'

  constructor() {
    super({
      id: OpenLogFileAction.ID,
      title: localize('action.openLogFile.title', 'Developer: Open Log File...'),
      category: localize('command.category.help', 'Help'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const logFilesService = accessor.get(ILogFilesService)
    const quickInputService = accessor.get(IQuickInputService)
    const groups = accessor.get(IEditorGroupsService)
    const instantiation = accessor.get(IInstantiationService)
    const descriptors = await logFilesService.listLogFiles()
    if (descriptors.length === 0) return
    const descriptor = await pickLogFileDescriptor(
      descriptors,
      quickInputService,
      'workbench.openLogFile',
      localize('quickInput.openLogFile.placeholder', 'Select a log file to open in the editor'),
    )
    if (!descriptor) return
    await openLogDescriptorInEditor(logFilesService, groups, instantiation, descriptor)
  }
}

async function openLogDescriptorInEditor(
  logFilesService: ILogFilesService,
  groups: IEditorGroupsService,
  instantiation: IInstantiationService,
  descriptor: LogFileDescriptor,
): Promise<void> {
  const fsPath = await logFilesService.resolveLogPath(descriptor.id)
  const uri = URI.file(fsPath)

  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor instanceof FileEditorInput && editor.resource.toString() === uri.toString()) {
        groups.activateGroup(group)
        group.setActive(editor)
        return
      }
    }
  }
  const input = instantiation.createInstance(FileEditorInput, uri).markReadonly()
  groups.activeGroup.openEditor(input, { activate: true, pinned: true })
}

export class ClearOutputAction extends Action2 {
  static readonly ID = 'workbench.action.clearOutput'

  constructor() {
    super({
      id: ClearOutputAction.ID,
      title: localize('action.clearOutput.title', 'Clear Output'),
      category: localize('command.category.view', 'View'),
      icon: 'trash-2',
      menu: [
        {
          id: MenuId.ViewTitle,
          when: 'view == workbench.view.output.main',
          group: 'navigation',
          order: 1,
        },
      ],
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const outputService = accessor.get(IOutputService)
    const channelName = outputService.activeChannelName.get()
    if (!channelName) return
    outputService.getChannel(channelName)?.clear()
  }
}

export class ToggleOutputAction extends Action2 {
  static readonly ID = 'workbench.action.toggleOutput'

  constructor() {
    super({
      id: ToggleOutputAction.ID,
      title: localize('action.toggleOutput.title', 'View: Toggle Output'),
      category: localize('command.category.view', 'View'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const layout = accessor.get(ILayoutService)
    if (layout.getVisible(PartId.Panel)) {
      layout.setVisible(PartId.Panel, false)
    } else {
      layout.setVisible(PartId.Panel, true)
      layout.getPart(PartId.Panel)?.focus()
    }
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
    const configurationService = accessor.get(IConfigurationService)
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
    configurationService.update(
      'logging.level',
      LEVEL_TO_SETTING_VALUE[selected.level],
      ConfigurationTarget.User,
    )
    loggerService
      .createLogger({ id: 'logActions', name: 'Log Actions' })
      .info(`Log level set to ${selected.label}`)
  }
}
