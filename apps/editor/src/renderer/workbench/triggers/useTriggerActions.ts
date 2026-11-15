/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React bridge between the Trigger Manager's panels and the palette command
 *  helpers. The service snapshot is built once and reused by every action, so a
 *  panel button behaves exactly like the corresponding command.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import {
  ICommandService,
  IDialogService,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  ILoggerService,
  INotificationService,
  IOutputService,
  IQuickInputService,
  IViewsService,
  IWorkspaceService,
  ILayoutService,
  IUriIdentityService,
  type ILogger,
} from '@universe-editor/platform'
import { ILogFilesService } from '../../../shared/ipc/services.js'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import {
  confirmTriggerActivation,
  openTriggerConfig,
  rescanTriggerWorkspace,
  runTriggerAction,
  runTriggerNow,
  setAllTriggersPaused,
  setTriggerPaused,
  showTriggerLog,
  type TriggerActionServices,
} from '../../actions/triggerActions.js'
import { useService } from '../useService.js'
import { revealTriggerConfig } from '../../services/triggers/revealTriggerConfig.js'

export interface TriggerManagerActions {
  readonly runNow: (summary: TriggerSummary) => Promise<void>
  readonly setPaused: (summary: TriggerSummary, paused: boolean) => Promise<void>
  readonly setAllPaused: (paused: boolean) => Promise<void>
  readonly confirmActivation: (summary: TriggerSummary) => Promise<void>
  readonly openConfig: () => Promise<void>
  readonly rescan: () => Promise<void>
  readonly revealInJson: (summary: TriggerSummary) => Promise<void>
  readonly showLog: () => Promise<void>
}

export function useTriggerActions(): TriggerManagerActions {
  const triggers = useService(ITriggerMainService)
  const quickInput = useService(IQuickInputService)
  const notifications = useService(INotificationService)
  const dialogs = useService(IDialogService)
  const editors = useService(IEditorResolverService)
  const logFiles = useService(ILogFilesService)
  const output = useService(IOutputService)
  const layout = useService(ILayoutService)
  const views = useService(IViewsService)
  const workspace = useService(IWorkspaceService)
  const commands = useService(ICommandService)
  const loggerService = useService(ILoggerService)
  const files = useService(IFileService)
  const editorService = useService(IEditorService)
  const groups = useService(IEditorGroupsService)
  const uriIdentity = useService(IUriIdentityService)
  const agents = useService(IAcpAgentRegistry)

  const services = useMemo<TriggerActionServices>(() => {
    const logger: ILogger = loggerService.createLogger({ id: 'triggerManager', name: 'Triggers' })
    return {
      triggers,
      quickInput,
      notifications,
      dialogs,
      editors,
      logFiles,
      output,
      layout,
      views,
      workspace,
      commands,
      logger,
      agents,
      files,
      editorService,
      groups,
      uriIdentity,
    }
  }, [
    triggers,
    quickInput,
    notifications,
    dialogs,
    editors,
    logFiles,
    output,
    layout,
    views,
    workspace,
    commands,
    loggerService,
    agents,
    files,
    editorService,
    groups,
    uriIdentity,
  ])

  return useMemo<TriggerManagerActions>(
    () => ({
      runNow: (summary) => runTriggerAction(services, () => runTriggerNow(services, summary)),
      setPaused: (summary, paused) =>
        runTriggerAction(services, () => setTriggerPaused(services, summary, paused)),
      setAllPaused: (paused) =>
        runTriggerAction(services, () => setAllTriggersPaused(services, paused)),
      confirmActivation: (summary) =>
        runTriggerAction(services, () => confirmTriggerActivation(services, summary)),
      openConfig: () => runTriggerAction(services, () => openTriggerConfig(services)),
      rescan: () => runTriggerAction(services, () => rescanTriggerWorkspace(services)),
      revealInJson: (summary) =>
        runTriggerAction(services, () =>
          revealTriggerConfig({ files, editors, editorService, groups, uriIdentity }, summary),
        ),
      showLog: () => runTriggerAction(services, () => showTriggerLog(services)),
    }),
    [services, files, editors, editorService, groups, uriIdentity],
  )
}
