/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Command palette surface for agent triggers (design §8). Every command is a
 *  thin renderer client of the main-process scheduler; the JSON config itself is
 *  edited as a file (schema registered by TriggersConfigurationContribution).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IEditorResolverService,
  IEditorService,
  ILayoutService,
  ILoggerService,
  INotificationService,
  IOutputService,
  IQuickInputService,
  IViewsService,
  IWorkspaceService,
  MenuId,
  Severity,
  URI,
  localize,
  localize2,
  type ILogger,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { ILogFilesService } from '../../shared/ipc/services.js'
import { ITriggerMainService } from '../../shared/ipc/triggerService.js'
import { workspaceDisplayPath } from '../../shared/triggers/configParse.js'
import type { TriggerSummary } from '../../shared/triggers/types.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../services/acp/session/acpSessionHistory.js'
import { AcpSessionEditorInput } from '../services/acp/session/acpSessionEditorInput.js'
import {
  TriggerReportEditorInput,
  fallbackTriggerName,
} from '../services/triggers/triggerReportEditorInput.js'
import { revealOutputPanel } from '../services/output/revealOutputPanel.js'
import { ACP_CHAT_SESSION_GROUP, resolveSessionTargetId } from './_agentShared.js'
import {
  buildTriggerActionItems,
  buildTriggerPickItems,
  triggersForAction,
  type TriggerItemAction,
  type TriggerPickerAction,
} from './triggerPickItems.js'

/** Logger id main uses for `createNamedLogger({ id: 'triggers' })`. */
const TRIGGER_LOG_CHANNEL_ID = 'triggers'

const CATEGORY = localize2('command.category.triggers', 'Triggers')

interface TriggerActionServices {
  readonly triggers: ITriggerMainService
  readonly quickInput: IQuickInputService
  readonly notifications: INotificationService
  readonly dialogs: IDialogService
  readonly editors: IEditorResolverService
  readonly logFiles: ILogFilesService
  readonly output: IOutputService
  readonly layout: ILayoutService
  readonly views: IViewsService
  readonly workspace: IWorkspaceService
  readonly logger: ILogger
}

/** Snapshot taken before the first await — the ServicesAccessor dies with it. */
function triggerActionServices(accessor: ServicesAccessor): TriggerActionServices {
  return {
    triggers: accessor.get(ITriggerMainService),
    quickInput: accessor.get(IQuickInputService),
    notifications: accessor.get(INotificationService),
    dialogs: accessor.get(IDialogService),
    editors: accessor.get(IEditorResolverService),
    logFiles: accessor.get(ILogFilesService),
    output: accessor.get(IOutputService),
    layout: accessor.get(ILayoutService),
    views: accessor.get(IViewsService),
    workspace: accessor.get(IWorkspaceService),
    logger: accessor.get(ILoggerService).createLogger({ id: 'triggerActions', name: 'Triggers' }),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function runWithErrorNotification(
  services: TriggerActionServices,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task()
  } catch (err) {
    services.logger.warn(`trigger command failed: ${errorMessage(err)}`)
    services.notifications.notify({
      severity: Severity.Error,
      message: localize('triggers.commandFailed', 'Trigger command failed: {error}', {
        error: errorMessage(err),
      }),
    })
  }
}

function notifyNoTriggers(services: TriggerActionServices): void {
  services.notifications.notify({
    severity: Severity.Info,
    message: localize(
      'triggers.none',
      'No triggers are configured. Run "Triggers: Open Configuration" to create .universe-editor/triggers.json in a workspace.',
    ),
  })
}

async function pickTrigger(
  services: TriggerActionServices,
  summaries: readonly TriggerSummary[],
  pickId: string,
  placeholder: string,
): Promise<TriggerSummary | undefined> {
  const selected = await services.quickInput.pick(buildTriggerPickItems(summaries), {
    id: pickId,
    placeholder,
    matchOnDescription: true,
    matchOnDetail: true,
  })
  const triggerKey = selected?.triggerKey
  if (triggerKey === undefined) return undefined
  return summaries.find((summary) => summary.key === triggerKey)
}

const PICKER_TEXT: Record<TriggerPickerAction, { pickId: string; placeholder: () => string }> = {
  pause: {
    pickId: 'workbench.triggers.pause',
    placeholder: () => localize('triggers.pick.pause', 'Select a trigger to pause'),
  },
  resume: {
    pickId: 'workbench.triggers.resume',
    placeholder: () => localize('triggers.pick.resume', 'Select a trigger to resume'),
  },
  confirmActivation: {
    pickId: 'workbench.triggers.confirmActivation',
    placeholder: () =>
      localize(
        'triggers.pick.confirmActivation',
        'Select a workspace trigger to confirm on this machine',
      ),
  },
  confirmElevatedMode: {
    pickId: 'workbench.triggers.confirmElevatedMode',
    placeholder: () =>
      localize(
        'triggers.pick.confirmElevatedMode',
        'Select a trigger to allow high-privilege mode',
      ),
  },
  confirmAutoApprove: {
    pickId: 'workbench.triggers.confirmAutoApprove',
    placeholder: () =>
      localize('triggers.pick.confirmAutoApprove', 'Select a trigger to allow automatic approve'),
  },
}

const EMPTY_TEXT: Record<TriggerPickerAction, () => string> = {
  pause: () => localize('triggers.empty.pause', 'No triggers can be paused.'),
  resume: () => localize('triggers.empty.resume', 'No paused triggers.'),
  confirmActivation: () =>
    localize(
      'triggers.empty.confirmActivation',
      'Every trigger from the registered workspaces is already confirmed.',
    ),
  confirmElevatedMode: () =>
    localize(
      'triggers.empty.confirmElevatedMode',
      'No trigger is configured with an unconfirmed high-privilege mode.',
    ),
  confirmAutoApprove: () =>
    localize('triggers.empty.confirmAutoApprove', 'No trigger asks for automatic Swarm approve.'),
}

async function pickTriggerForAction(
  services: TriggerActionServices,
  action: TriggerPickerAction,
): Promise<TriggerSummary | undefined> {
  const candidates = triggersForAction(action, await services.triggers.listTriggers())
  if (candidates.length === 0) {
    services.notifications.notify({ severity: Severity.Info, message: EMPTY_TEXT[action]() })
    return undefined
  }
  const { pickId, placeholder } = PICKER_TEXT[action]
  return pickTrigger(services, candidates, pickId, placeholder())
}

async function runTriggerNow(
  services: TriggerActionServices,
  summary: TriggerSummary,
): Promise<void> {
  services.logger.info(`requesting manual run of trigger ${summary.id} (${summary.workspace})`)
  await services.triggers.runNow(summary.key)
  services.notifications.notify({
    severity: Severity.Info,
    message: localize('triggers.runRequested', 'Trigger "{name}" was queued to run.', {
      name: summary.name,
    }),
  })
}

async function setTriggerPaused(
  services: TriggerActionServices,
  summary: TriggerSummary,
  paused: boolean,
): Promise<void> {
  services.logger.info(`setting trigger ${summary.id} paused=${String(paused)}`)
  await services.triggers.setPaused(summary.key, paused)
  services.notifications.notify({
    severity: Severity.Info,
    message: paused
      ? localize('triggers.paused', 'Trigger "{name}" is paused.', { name: summary.name })
      : localize('triggers.resumed', 'Trigger "{name}" is resumed.', { name: summary.name }),
  })
}

async function openTriggerConfig(services: TriggerActionServices): Promise<void> {
  const folder = services.workspace.current?.folder
  // Definitions live inside a workspace; an empty window has nowhere to put them.
  if (folder === undefined) {
    services.notifications.notify({
      severity: Severity.Warning,
      message: localize(
        'triggers.openConfig.noWorkspace',
        'Open a folder workspace first. Trigger definitions live in {path} inside the workspace.',
        { path: '.universe-editor/triggers.json' },
      ),
    })
    return
  }
  const uri = URI.parse(await services.triggers.ensureConfigFile(folder.toString()))
  await services.editors.openEditor(uri, { pinned: true })
}

async function showTriggerLog(services: TriggerActionServices): Promise<void> {
  const descriptors = await services.logFiles.listLogFiles()
  const descriptor = descriptors.find((entry) => entry.channelId === TRIGGER_LOG_CHANNEL_ID)
  if (descriptor === undefined) {
    services.notifications.notify({
      severity: Severity.Info,
      message: localize(
        'triggers.log.notCreated',
        'The Triggers log channel is not available yet. It appears once the scheduler writes its first entry.',
      ),
    })
    revealOutputPanel(services.layout, services.views)
    return
  }
  services.output.createChannel(descriptor.name, 'log')
  services.output.setActiveChannel(descriptor.name)
  services.output.getChannel(descriptor.name)?.flushNow()
  revealOutputPanel(services.layout, services.views)
}

async function confirmTriggerActivation(
  services: TriggerActionServices,
  summary: TriggerSummary,
): Promise<void> {
  const { confirmed } = await services.dialogs.confirm({
    type: 'warning',
    message: localize(
      'triggers.confirmActivation.message',
      'Enable trigger "{name}" from workspace "{workspace}"?',
      { name: summary.name, workspace: workspaceDisplayPath(summary.workspace) },
    ),
    detail: localize(
      'triggers.confirmActivation.detail',
      'The trigger comes from {path}. It is defined in the workspace configuration file, so it may have arrived with a cloned or pulled repository. Once confirmed it can run unattended with your credentials. The confirmation is stored on this machine and bound to the whole definition — changing any field, including enabling it or renaming it, requires confirming again.',
      { path: workspaceDisplayPath(summary.workspace) },
    ),
    primaryButton: localize('triggers.confirmActivation.primary', 'Enable Trigger'),
  })
  if (!confirmed) return
  await services.triggers.confirmActivation(summary.key)
  services.notifications.notify({
    severity: Severity.Info,
    message: localize(
      'triggers.confirmActivation.done',
      'Trigger "{name}" was confirmed and may now run.',
      { name: summary.name },
    ),
  })
}

async function confirmElevatedMode(
  services: TriggerActionServices,
  summary: TriggerSummary,
): Promise<void> {
  const { confirmed } = await services.dialogs.confirm({
    type: 'warning',
    message: localize(
      'triggers.confirmElevated.message',
      'Enable high-privilege mode for trigger "{name}"?',
      { name: summary.name },
    ),
    detail: localize(
      'triggers.confirmElevated.detail',
      'In a bypass-class mode the agent can execute arbitrary operations without asking you for approval. This trigger runs unattended, so nothing will stop a harmful action. The confirmation is bound to the current trigger configuration — editing the trigger requires confirming again.',
    ),
    primaryButton: localize('triggers.confirmElevated.primary', 'Enable High-Privilege Mode'),
  })
  if (!confirmed) return
  await services.triggers.confirmElevatedMode(summary.key)
  services.notifications.notify({
    severity: Severity.Info,
    message: localize(
      'triggers.confirmElevated.done',
      'High-privilege mode was confirmed for trigger "{name}".',
      { name: summary.name },
    ),
  })
}

async function confirmAutoApprove(
  services: TriggerActionServices,
  summary: TriggerSummary,
): Promise<void> {
  const { confirmed } = await services.dialogs.confirm({
    type: 'warning',
    message: localize(
      'triggers.confirmAutoApprove.message',
      'Allow trigger "{name}" to approve Swarm reviews automatically?',
      { name: summary.name },
    ),
    detail: localize(
      'triggers.confirmAutoApprove.detail',
      'Automatic approve lets the agent approve external content without a human check. Anyone who can write that content may trick the trigger into approving a malicious change. Approvals never include a commit. The confirmation is bound to the current trigger configuration — editing the trigger requires confirming again.',
    ),
    primaryButton: localize('triggers.confirmAutoApprove.primary', 'Allow Automatic Approve'),
  })
  if (!confirmed) return
  await services.triggers.confirmAutoApprove(summary.key)
  services.notifications.notify({
    severity: Severity.Info,
    message: localize(
      'triggers.confirmAutoApprove.done',
      'Automatic approve was confirmed for trigger "{name}".',
      { name: summary.name },
    ),
  })
}

async function executeItemAction(
  services: TriggerActionServices,
  summary: TriggerSummary,
  action: TriggerItemAction,
): Promise<void> {
  switch (action) {
    case 'runNow':
      await runTriggerNow(services, summary)
      return
    case 'pause':
      await setTriggerPaused(services, summary, true)
      return
    case 'resume':
      await setTriggerPaused(services, summary, false)
      return
    case 'confirmActivation':
      await confirmTriggerActivation(services, summary)
      return
    case 'confirmElevatedMode':
      await confirmElevatedMode(services, summary)
      return
    case 'confirmAutoApprove':
      await confirmAutoApprove(services, summary)
      return
    case 'openConfig':
      await openTriggerConfig(services)
      return
    case 'showLog':
      await showTriggerLog(services)
      return
  }
}

export class ListTriggersAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.list'

  constructor() {
    super({
      id: ListTriggersAction.ID,
      title: localize2('action.triggers.list.title', 'List Triggers'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, async () => {
      const summaries = await services.triggers.listTriggers()
      if (summaries.length === 0) {
        notifyNoTriggers(services)
        return
      }
      const summary = await pickTrigger(
        services,
        summaries,
        'workbench.triggers.list',
        localize('triggers.pick.list', 'Select a trigger'),
      )
      if (summary === undefined) return
      const selected = await services.quickInput.pick(buildTriggerActionItems(summary), {
        id: 'workbench.triggers.actions',
        placeholder: localize('triggers.pick.action', 'Select an action for "{name}"', {
          name: summary.name,
        }),
      })
      if (selected === undefined) return
      services.logger.info(`trigger ${summary.id}: selected action ${selected.action}`)
      await executeItemAction(services, summary, selected.action)
    })
  }
}

export interface ViewTriggerReportArgs {
  readonly sessionId?: string
  readonly runId?: string
  readonly triggerName?: string
  readonly eventKey?: string
}

/**
 * Opens the read-only report tab for one trigger run. Target resolution follows
 * the session commands: explicit `sessionId`, the clicked tab's `resource`, the
 * active session tab, then the active session. The notification passes a runId
 * so the report remains reachable when its session is already gone.
 */
export class ViewTriggerReportAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.viewReport'

  constructor() {
    super({
      id: ViewTriggerReportAction.ID,
      title: localize2('action.trigger.viewReport', 'View Trigger Run Report'),
      category: CATEGORY,
      icon: 'open-preview',
      menu: [
        {
          id: MenuId.AcpChatContext,
          when: 'acpChatSessionAutomation',
          group: ACP_CHAT_SESSION_GROUP,
          order: 6,
          title: localize2('acp.sessions.viewReport', 'View Report'),
        },
        {
          id: MenuId.EditorTabContext,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}' && acpSessionHasAutomation`,
          group: '1_session',
          order: 3,
          title: localize2('acp.sessions.viewReport', 'View Report'),
        },
      ],
      f1: false,
    })
  }

  override run(accessor: ServicesAccessor, arg?: unknown): void {
    // Synchronous throughout: no service access after an await is possible here.
    const editors = accessor.get(IEditorService)
    const sessions = accessor.get(IAcpSessionService)
    const history = accessor.get(IAcpSessionHistoryService)
    const args = argsRecord(arg)
    const explicitRunId = stringArg(args, 'runId')
    // A notification supplies the run id; never borrow an unrelated active
    // session just because no session id was passed with it.
    const sessionId =
      explicitRunId !== undefined
        ? stringArg(args, 'sessionId')
        : resolveSessionTargetId(args, editors, sessions)
    const live = sessionId !== undefined ? sessions.getById(sessionId) : undefined
    const durableId = live?.sessionIdOnAgent.get() ?? sessionId
    const historyEntry = durableId !== undefined ? history.get(durableId) : undefined
    const automation = live?.automation ?? historyEntry?.automation

    const runId = explicitRunId ?? automation?.runId
    if (runId === undefined) return
    // The report lives on the session's host; the input keeps it so restoring a
    // tab can still address the run before history hydrates.
    const authority = live?.authority ?? historyEntry?.authority
    const triggerName =
      stringArg(args, 'triggerName') ?? automation?.triggerName ?? fallbackTriggerName()
    const eventKey = stringArg(args, 'eventKey') ?? automation?.eventKey
    const known = historyEntry?.automation
    const snapshot =
      known?.outcome !== undefined || known?.verdict !== undefined || known?.summary !== undefined
        ? {
            ...(known.outcome !== undefined ? { outcome: known.outcome } : {}),
            ...(known.verdict !== undefined ? { verdict: known.verdict } : {}),
            ...(known.summary !== undefined ? { summary: known.summary } : {}),
          }
        : undefined

    editors.openEditor(
      new TriggerReportEditorInput({
        runId,
        triggerName,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(authority !== undefined ? { authority } : {}),
        ...(eventKey !== undefined ? { eventKey } : {}),
        ...(snapshot !== undefined ? { snapshot } : {}),
      }),
      { pinned: true },
    )
  }
}

function argsRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class RunTriggerNowAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.runNow'

  constructor() {
    super({
      id: RunTriggerNowAction.ID,
      title: localize2('action.triggers.runNow.title', 'Run Trigger Now...'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, async () => {
      const requested = args[0]
      const summaries = await services.triggers.listTriggers()
      if (summaries.length === 0) {
        notifyNoTriggers(services)
        return
      }
      // The optional argument is a composite workspace + trigger key.
      if (typeof requested === 'string' && requested.length > 0) {
        const requestedSummary = summaries.find((summary) => summary.key === requested)
        if (requestedSummary !== undefined) {
          await runTriggerNow(services, requestedSummary)
          return
        }
      }
      const summary = await pickTrigger(
        services,
        summaries,
        'workbench.triggers.runNow',
        localize('triggers.pick.runNow', 'Select a trigger to run now'),
      )
      if (summary === undefined) return
      await runTriggerNow(services, summary)
    })
  }
}

export class PauseTriggerAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.pause'

  constructor() {
    super({
      id: PauseTriggerAction.ID,
      title: localize2('action.triggers.pause.title', 'Pause Trigger...'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, async () => {
      const summary = await pickTriggerForAction(services, 'pause')
      if (summary === undefined) return
      await setTriggerPaused(services, summary, true)
    })
  }
}

export class ResumeTriggerAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.resume'

  constructor() {
    super({
      id: ResumeTriggerAction.ID,
      title: localize2('action.triggers.resume.title', 'Resume Trigger...'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, async () => {
      const summary = await pickTriggerForAction(services, 'resume')
      if (summary === undefined) return
      await setTriggerPaused(services, summary, false)
    })
  }
}

async function setAllTriggersPaused(
  services: TriggerActionServices,
  paused: boolean,
): Promise<void> {
  services.logger.info(`setting all triggers paused=${String(paused)}`)
  await services.triggers.setAllPaused(paused)
  services.notifications.notify({
    severity: Severity.Info,
    message: paused
      ? localize('triggers.allPaused', 'All triggers are paused.')
      : localize('triggers.allResumed', 'All triggers are resumed.'),
  })
}

export class PauseAllTriggersAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.pauseAll'

  constructor() {
    super({
      id: PauseAllTriggersAction.ID,
      title: localize2('action.triggers.pauseAll.title', 'Pause All Triggers'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, () => setAllTriggersPaused(services, true))
  }
}

export class ResumeAllTriggersAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.resumeAll'

  constructor() {
    super({
      id: ResumeAllTriggersAction.ID,
      title: localize2('action.triggers.resumeAll.title', 'Resume All Triggers'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, () => setAllTriggersPaused(services, false))
  }
}

export class OpenTriggersConfigAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.openConfig'

  constructor() {
    super({
      id: OpenTriggersConfigAction.ID,
      title: localize2('action.triggers.openConfig.title', 'Open Configuration'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, () => openTriggerConfig(services))
  }
}

export class ShowTriggersLogAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.showLog'

  constructor() {
    super({
      id: ShowTriggersLogAction.ID,
      title: localize2('action.triggers.showLog.title', 'Show Log'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, () => showTriggerLog(services))
  }
}

export class ConfirmTriggerElevatedModeAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.confirmElevatedMode'

  constructor() {
    super({
      id: ConfirmTriggerElevatedModeAction.ID,
      title: localize2(
        'action.triggers.confirmElevatedMode.title',
        'Confirm High-Privilege Mode...',
      ),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, async () => {
      const summary = await pickTriggerForAction(services, 'confirmElevatedMode')
      if (summary === undefined) return
      await confirmElevatedMode(services, summary)
    })
  }
}

export class ConfirmTriggerAutoApproveAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.confirmAutoApprove'

  constructor() {
    super({
      id: ConfirmTriggerAutoApproveAction.ID,
      title: localize2('action.triggers.confirmAutoApprove.title', 'Confirm Automatic Approve...'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, async () => {
      const summary = await pickTriggerForAction(services, 'confirmAutoApprove')
      if (summary === undefined) return
      await confirmAutoApprove(services, summary)
    })
  }
}

export class ConfirmTriggerActivationAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.confirmActivation'

  constructor() {
    super({
      id: ConfirmTriggerActivationAction.ID,
      title: localize2('action.triggers.confirmActivation.title', 'Confirm Workspace Trigger...'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, async () => {
      const summary = await pickTriggerForAction(services, 'confirmActivation')
      if (summary === undefined) return
      await confirmTriggerActivation(services, summary)
    })
  }
}

/**
 * Stops watching (and scheduling) a workspace registered for background triggers.
 * Running sessions are left alone; only future scheduling stops.
 */
export class RemoveTriggerWorkspaceAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.removeWorkspace'

  constructor() {
    super({
      id: RemoveTriggerWorkspaceAction.ID,
      title: localize2('action.triggers.removeWorkspace.title', 'Remove Trigger Workspace...'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = triggerActionServices(accessor)
    await runWithErrorNotification(services, async () => {
      const workspaces = await services.triggers.listWorkspaces()
      if (workspaces.length === 0) {
        services.notifications.notify({
          severity: Severity.Info,
          message: localize(
            'triggers.workspace.none',
            'No workspace is registered for background triggers.',
          ),
        })
        return
      }
      const items = workspaces.map((entry, index) => ({
        id: String(index),
        label: entry.name,
        description: workspaceDisplayPath(entry.workspace),
        ...(entry.available
          ? {}
          : {
              detail: localize(
                'triggers.workspace.unavailable',
                'The configuration file is missing; the workspace is registered but not scheduled.',
              ),
            }),
      }))
      const selected = await services.quickInput.pick(items, {
        id: 'workbench.triggers.removeWorkspace',
        placeholder: localize(
          'triggers.workspace.pick',
          'Select a workspace to stop scheduling triggers for',
        ),
        matchOnDescription: true,
      })
      const index = selected === undefined ? undefined : Number(selected.id)
      const target = index === undefined ? undefined : workspaces[index]
      if (target === undefined) return
      const { confirmed } = await services.dialogs.confirm({
        type: 'warning',
        message: localize(
          'triggers.workspace.remove.message',
          'Stop scheduling triggers for "{name}"?',
          { name: target.name },
        ),
        detail: localize(
          'triggers.workspace.remove.detail',
          'The workspace is removed from this machine only; {path} is left untouched. It is registered again the next time a window opens it.',
          { path: target.configPath },
        ),
        primaryButton: localize('triggers.workspace.remove.primary', 'Stop Scheduling'),
      })
      if (!confirmed) return
      await services.triggers.removeWorkspace(target.workspace)
      services.notifications.notify({
        severity: Severity.Info,
        message: localize(
          'triggers.workspace.removed',
          'Triggers for "{name}" are no longer scheduled.',
          { name: target.name },
        ),
      })
    })
  }
}
