/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Command palette surface for agent triggers. Every command is a
 *  thin renderer client of the main-process scheduler; the JSON config itself is
 *  edited as a file (schema registered by TriggersConfigurationContribution).
 *  Docs: docs/development/triggers.md
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
  IDialogService,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  ILayoutService,
  ILoggerService,
  INotificationService,
  IOutputService,
  IQuickInputService,
  IUriIdentityService,
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
import {
  ITriggerMainService,
  type TriggerPollPreview,
  type TriggerPollPreviewItem,
  type TriggerPollPreviewUnavailableReason,
} from '../../shared/ipc/triggerService.js'
import { workspaceDisplayPath, parseWorkspaceUri } from '../../shared/triggers/configParse.js'
import { parseTriggerDocument } from '../../shared/triggers/configDocument.js'
import { summarizeTriggerSource } from '../services/triggers/triggerPresentation.js'
import {
  CONSERVATIVE_MODE_BY_AGENT,
  type TriggerConfig,
  type TriggerSummary,
} from '../../shared/triggers/types.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../services/acp/session/acpSessionHistory.js'
import { AcpSessionEditorInput } from '../services/acp/session/acpSessionEditorInput.js'
import { invocationOpenTarget } from '../services/editor/openTarget.js'
import { revealEditorInGroups } from '../services/editor/revealEditorInGroups.js'
import {
  openPinnedSingletonEditor,
  openTargetServicesFrom,
} from '../services/editor/openWithTarget.js'
import {
  TriggerReportEditorInput,
  fallbackTriggerName,
} from '../services/triggers/triggerReportEditorInput.js'
import { rerunTriggerRun } from '../services/triggers/rerunTriggerRun.js'
import { TriggerManagerEditorInput } from '../services/triggers/triggerManagerEditorInput.js'
import { readTriggerConfig } from '../services/triggers/triggerConfigFileService.js'
import { revealTriggerConfig } from '../services/triggers/revealTriggerConfig.js'
import { revealOutputPanel } from '../services/output/revealOutputPanel.js'
import { IWindowFocusService } from '../services/windows/windowFocusService.js'
import {
  ACP_CHAT_SESSION_GROUP,
  ACP_SESSION_EDITOR_ACTIVE_WHEN,
  resolveSessionTargetId,
} from './_agentShared.js'
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

export interface TriggerActionServices {
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
  readonly commands: ICommandService
  readonly logger: ILogger
  readonly agents: IAcpAgentRegistry
  readonly files: IFileService
  readonly editorService: IEditorService
  readonly groups: IEditorGroupsService
  readonly uriIdentity: IUriIdentityService
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
    commands: accessor.get(ICommandService),
    logger: accessor.get(ILoggerService).createLogger({ id: 'triggerActions', name: 'Triggers' }),
    agents: accessor.get(IAcpAgentRegistry),
    files: accessor.get(IFileService),
    editorService: accessor.get(IEditorService),
    groups: accessor.get(IEditorGroupsService),
    uriIdentity: accessor.get(IUriIdentityService),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Shared by the palette commands and the manager's in-panel actions. */
export async function runTriggerAction(
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
}

const EMPTY_TEXT: Record<TriggerPickerAction, () => string> = {
  pause: () => localize('triggers.empty.pause', 'No triggers can be paused.'),
  resume: () => localize('triggers.empty.resume', 'No paused triggers.'),
  confirmActivation: () =>
    localize(
      'triggers.empty.confirmActivation',
      'Every trigger from the registered workspaces is already confirmed.',
    ),
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

const POLL_UNAVAILABLE_TEXT: Record<TriggerPollPreviewUnavailableReason, () => string> = {
  'all-paused': () => localize('triggers.error.allPaused', 'All triggers are paused'),
  offline: () =>
    localize(
      'triggers.error.remoteNotConnected',
      'The remote host for this trigger is not connected. Reconnect and try again.',
    ),
  'needs-confirmation': () =>
    localize(
      'triggers.error.needsConfirmation',
      'Confirm this trigger before running it (it comes from a workspace configuration file)',
    ),
  'window-missing': () =>
    localize(
      'triggers.manual.poll.windowMissing',
      'No window holds this remote workspace, so the poll command was not run.',
    ),
  'workspace-not-trusted': () =>
    localize('triggers.error.workspaceUntrusted', 'The workspace is not trusted.'),
  'poll-in-progress': () =>
    localize(
      'triggers.manual.poll.inProgress',
      'This trigger is already polling. Try again in a moment.',
    ),
  'poll-failed': () =>
    localize('triggers.manual.poll.unavailable', 'Could not read events for this trigger.'),
  'poll-skipped': () =>
    localize(
      'triggers.manual.poll.skipped',
      'The poll command could not run (the remote host is unavailable or did not answer).',
    ),
}

function pollUnavailableMessage(
  reason: TriggerPollPreviewUnavailableReason,
  detail: string | undefined,
): string {
  if (reason === 'poll-failed') {
    return localize('triggers.manual.poll.failed', 'The poll command failed: {error}', {
      error: detail ?? localize('triggers.manual.poll.failedUnknown', 'unknown error'),
    })
  }
  return POLL_UNAVAILABLE_TEXT[reason]()
}

function buildPollPickItems(items: readonly TriggerPollPreviewItem[]) {
  return items.map((item) => ({
    id: item.key,
    label: item.processed
      ? `${item.value}${localize('triggers.manual.poll.processed', ' (already processed)')}`
      : item.value,
    ...(item.title === undefined ? {} : { description: item.title }),
  }))
}

async function pickPollEvent(
  services: TriggerActionServices,
  items: readonly TriggerPollPreviewItem[],
): Promise<TriggerPollPreviewItem | undefined> {
  const selected = await services.quickInput.pick(buildPollPickItems(items), {
    id: 'workbench.triggers.pollEvent',
    placeholder: localize('triggers.manual.poll.pick', 'Select an event to run this trigger with'),
    matchOnDescription: true,
  })
  if (selected === undefined) return undefined
  return items.find((item) => item.key === selected.id)
}

function notifyRunQueued(services: TriggerActionServices, summary: TriggerSummary): void {
  services.notifications.notify({
    severity: Severity.Info,
    message: localize('triggers.runRequested', 'Trigger "{name}" was queued to run.', {
      name: summary.name,
    }),
  })
}

export async function runTriggerNow(
  services: TriggerActionServices,
  summary: TriggerSummary,
): Promise<void> {
  services.logger.info(`requesting manual run of trigger ${summary.id} (${summary.workspace})`)
  if (summary.sourceType !== 'poll') {
    await services.triggers.runNow(summary.key)
    notifyRunQueued(services, summary)
    return
  }

  const reading = services.notifications.notify({
    severity: Severity.Info,
    message: localize('triggers.manual.poll.reading', 'Reading poll events…'),
    sticky: true,
  })
  let preview: TriggerPollPreview
  try {
    preview = await services.triggers.previewPollEvents(summary.key)
  } finally {
    services.notifications.dismiss(reading.id)
  }

  if (preview.kind === 'unsupported') {
    services.logger.warn(
      `trigger ${summary.id}: poll preview is unsupported; running without an event payload`,
    )
    await services.triggers.runNow(summary.key)
    notifyRunQueued(services, summary)
    return
  }
  if (preview.kind === 'unavailable') {
    services.notifications.notify({
      severity: Severity.Warning,
      message: pollUnavailableMessage(preview.reason, preview.detail),
    })
    return
  }
  if (preview.items.length === 0) {
    services.notifications.notify({
      severity: Severity.Info,
      message: localize('triggers.manual.poll.empty', 'The poll command returned no events.'),
    })
    return
  }

  const picked = await pickPollEvent(services, preview.items)
  if (picked === undefined) return
  await services.triggers.runNow(summary.key, {
    payload: picked.payload,
    sourceKey: picked.key,
  })
  notifyRunQueued(services, summary)
}

export async function setTriggerPaused(
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

export async function openTriggerConfig(services: TriggerActionServices): Promise<void> {
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

/** Re-discover the window workspace; main skips a missing file and never creates it. */
export async function rescanTriggerWorkspace(services: TriggerActionServices): Promise<void> {
  const folder = services.workspace.current?.folder
  if (folder === undefined) return
  await services.triggers.rescanWorkspace(folder.toString())
}

export async function showTriggerLog(services: TriggerActionServices): Promise<void> {
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

/**
 * A paused trigger whose activation confirmation is being granted can be
 * resumed in the same step: new triggers start paused, so "confirm" alone would
 * leave a freshly confirmed trigger dormant.
 */
function offersResume(summary: TriggerSummary): boolean {
  return summary.paused && !summary.pausedAll
}

function resumeAwareDetail(detail: string, offerResume: boolean): string {
  if (!offerResume) return detail
  return `${detail}\n\n${localize(
    'triggers.confirm.resumeHint',
    'This trigger is paused. "Confirm and Resume" also resumes it so it can schedule automatically; "Confirm Only" keeps it paused, and you can still run it now.',
  )}`
}

const PROMPT_PREVIEW_LIMIT = 200

function promptPreview(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length <= PROMPT_PREVIEW_LIMIT
    ? oneLine
    : `${oneLine.slice(0, PROMPT_PREVIEW_LIMIT - 1)}…`
}

/**
 * The summary carries only the surface fields; prompt, budget and concurrency are
 * confirmed too (the fingerprint binds the whole definition), so read the full
 * definition from the workspace file. A missing / stale file degrades to the
 * summary-only detail instead of blocking the confirmation.
 */
async function readActivationDefinition(
  services: TriggerActionServices,
  summary: TriggerSummary,
): Promise<TriggerConfig | undefined> {
  const workspaceUri = parseWorkspaceUri(summary.workspace)
  if (workspaceUri === undefined) return undefined
  try {
    const snapshot = await readTriggerConfig(services.files, workspaceUri)
    if (snapshot === undefined) return undefined
    const parsed = parseTriggerDocument(snapshot.text)
    if (parsed.kind !== 'ok') return undefined
    return parsed.value.triggers.find((entry) => entry.id === summary.id)
  } catch (err) {
    services.logger.warn(
      `could not read the trigger definition for confirmation: ${errorMessage(err)}`,
    )
    return undefined
  }
}

/** Every setting the confirmation binds, so the user sees exactly what runs. */
function activationDetail(
  summary: TriggerSummary,
  defaultAgentId: string,
  definition: TriggerConfig | undefined,
): string {
  const session = summary.session
  const notSet = localize('triggers.confirmActivation.notSet', 'Not set')
  const configuredAgent = session?.agent
  const agent =
    configuredAgent !== undefined && configuredAgent.length > 0 ? configuredAgent : defaultAgentId
  const configuredMode = session?.mode
  const conservativeMode = CONSERVATIVE_MODE_BY_AGENT[agent]
  // Mirrors automatedSessionService: with no explicit mode, a known agent falls
  // back to its conservative default; anything else must configure one to run.
  const mode =
    configuredMode !== undefined && configuredMode.length > 0
      ? configuredMode
      : conservativeMode !== undefined
        ? localize('triggers.confirmActivation.defaultMode', 'Default ({mode})', {
            mode: conservativeMode,
          })
        : localize(
            'triggers.confirmActivation.modeRequired',
            'Must be configured explicitly (this agent has no conservative default)',
          )
  const mcpServers = session?.mcpServers ?? []
  const lines = [
    localize('triggers.confirmActivation.definitionHeader', 'What will be confirmed:'),
    localize('triggers.confirmActivation.definition.agent', 'Agent: {agent}', { agent }),
    localize('triggers.confirmActivation.definition.mode', 'Mode: {mode}', { mode }),
    localize('triggers.confirmActivation.definition.skill', 'Skill: {skill}', {
      skill: session?.skill ?? notSet,
    }),
    ...(definition !== undefined
      ? [
          localize('triggers.confirmActivation.definition.prompt', 'Prompt: {prompt}', {
            prompt: promptPreview(definition.session.prompt) || notSet,
          }),
          localize(
            'triggers.confirmActivation.definition.budget',
            'Budget: {cost} · run timeout {timeout} min · approval timeout {approval} min',
            {
              cost:
                definition.session.budget.maxCostUsd === null
                  ? localize('triggers.confirmActivation.noCostLimit', 'no cost limit')
                  : `$${definition.session.budget.maxCostUsd.toFixed(2)}`,
              timeout: definition.session.budget.timeoutMin,
              approval: definition.session.budget.approvalTimeoutMin,
            },
          ),
          localize(
            'triggers.confirmActivation.definition.concurrency',
            'Concurrency: {concurrency} · when busy: {overflow}',
            {
              concurrency: definition.concurrency,
              overflow:
                definition.overflow === 'drop'
                  ? localize('trigger.manager.config.overflow.drop', 'Drop')
                  : localize('trigger.manager.config.overflow.queue', 'Queue'),
            },
          ),
          localize(
            'triggers.confirmActivation.definition.showSession',
            'Reveal the session while it runs: {value}',
            {
              value: definition.showSession
                ? localize('triggers.confirmActivation.yes', 'yes')
                : localize('triggers.confirmActivation.no', 'no'),
            },
          ),
        ]
      : []),
    ...(summary.source?.type === 'poll'
      ? [
          localize('triggers.confirmActivation.definition.pollCommand', 'Poll command: {command}', {
            command: summary.source.fetch.command,
          }),
        ]
      : []),
    localize('triggers.confirmActivation.definition.source', 'Trigger source: {source}', {
      source: summarizeTriggerSource(summary.source),
    }),
    localize('triggers.confirmActivation.definition.mcpServers', 'MCP servers: {servers}', {
      servers: mcpServers.length > 0 ? mcpServers.join(', ') : notSet,
    }),
  ]
  if (summary.elevatedMode) {
    lines.push(
      '',
      localize(
        'triggers.confirmActivation.warnElevated',
        '⚠ High-privilege mode: the agent runs without asking you to approve each step.',
      ),
    )
  }
  if (summary.elevatedMode && summary.source?.type === 'event') {
    lines.push(
      localize(
        'triggers.confirmActivation.warnElevatedEvent',
        '⚠ This is an event trigger: its data comes from an external system (for example a Swarm review description) and may contain text crafted to steer the agent. Combined with approval-free execution, a malicious description could cause harmful actions.',
      ),
    )
  }
  lines.push(
    '',
    localize(
      'triggers.confirmActivation.detail',
      'The trigger comes from {path}. It is defined in the workspace configuration file, so it may have arrived with a cloned or pulled repository. Once confirmed it can run unattended with your credentials. The confirmation is stored on this machine and bound to the whole definition — changing any field, including enabling it or renaming it, requires confirming again. It does not cover the content of referenced skill or script files.',
      { path: workspaceDisplayPath(summary.workspace) },
    ),
  )
  return lines.join('\n')
}

export async function confirmTriggerActivation(
  services: TriggerActionServices,
  summary: TriggerSummary,
): Promise<void> {
  const offerResume = offersResume(summary)
  // Resolved synchronously before the dialog awaits: the dialog must show the
  // agent that will actually run, not a hard-coded fallback. The full definition
  // read is the only async step before the loop; a failure degrades gracefully.
  const defaultAgentId = services.agents.defaultAgentId()
  const definition = await readActivationDefinition(services, summary)
  const detail = resumeAwareDetail(
    activationDetail(summary, defaultAgentId, definition),
    offerResume,
  )
  const buttons = offerResume
    ? [
        localize('triggers.confirm.resume', 'Confirm and Resume'),
        localize('triggers.confirm.only', 'Confirm Only'),
        localize('triggers.confirmActivation.viewDefinition', 'View Full Definition'),
      ]
    : [
        localize('triggers.confirmActivation.primary', 'Enable Trigger'),
        localize('triggers.confirmActivation.viewDefinition', 'View Full Definition'),
      ]
  const viewDefinitionIndex = buttons.length - 1
  for (;;) {
    const result = await services.dialogs.confirm({
      type: 'warning',
      message: localize(
        'triggers.confirmActivation.message',
        'Enable trigger "{name}" from workspace "{workspace}"?',
        { name: summary.name, workspace: workspaceDisplayPath(summary.workspace) },
      ),
      detail,
      buttons,
    })
    if (result.choiceIndex === undefined) return
    if (result.choiceIndex === viewDefinitionIndex) {
      // The dialog is modal; close it, reveal the definition, then ask again so
      // the confirmation is never granted from a view the user cannot inspect.
      await revealTriggerConfig(
        {
          files: services.files,
          editors: services.editors,
          editorService: services.editorService,
          groups: services.groups,
          uriIdentity: services.uriIdentity,
        },
        summary,
      )
      continue
    }
    const resume = offerResume && result.choiceIndex === 0
    await services.triggers.confirmActivation(summary.key, summary.fingerprint)
    if (resume) await services.triggers.setPaused(summary.key, false)
    services.notifications.notify({
      severity: Severity.Info,
      message: resume
        ? localize(
            'triggers.confirmActivation.doneResumed',
            'Trigger "{name}" was confirmed and resumed.',
            { name: summary.name },
          )
        : localize(
            'triggers.confirmActivation.done',
            'Trigger "{name}" was confirmed and may now run.',
            { name: summary.name },
          ),
    })
    return
  }
}

async function executeItemAction(
  services: TriggerActionServices,
  summary: TriggerSummary,
  action: TriggerItemAction,
): Promise<void> {
  switch (action) {
    case 'openManager':
      await services.commands.executeCommand(OpenTriggerManagerAction.ID, summary.key)
      return
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
    case 'openConfig':
      await openTriggerConfig(services)
      return
    case 'showLog':
      await showTriggerLog(services)
      return
  }
}

/**
 * Opens the single Trigger Manager tab. The optional argument is a composite
 * workspace + trigger key. An instance already open in any group is revealed
 * there (the default open path only dedupes inside the active group, which would
 * put a second copy in each split), and the key is delivered through the input's
 * selection event.
 */
export class OpenTriggerManagerAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.openManager'

  constructor() {
    super({
      id: OpenTriggerManagerAction.ID,
      title: localize2('action.triggers.openManager.title', 'Open Manager'),
      category: CATEGORY,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor, arg?: unknown): Promise<boolean> {
    // Everything below is resolved synchronously; openPinnedSingletonEditor may
    // await for side/new-window targets, but the accessor is already unused.
    const services = openTargetServicesFrom(accessor)
    const windowFocus = accessor.get(IWindowFocusService)
    const triggers = accessor.get(ITriggerMainService)
    const workspace = accessor.get(IWorkspaceService)
    const logger = accessor.get(ILoggerService).createLogger({
      id: 'triggerActions',
      name: 'Triggers',
    })
    const target = invocationOpenTarget()
    const triggerKey = typeof arg === 'string' && arg.length > 0 ? arg : undefined
    // A pull or branch switch can add triggers.json after the window opened;
    // main skips a missing file, so this stays read-only. Fire-and-forget: the
    // manager refreshes through onDidChangeTriggers when discovery finishes.
    const folder = workspace.current?.folder
    if (folder !== undefined) {
      void triggers.rescanWorkspace(folder.toString()).catch((err: unknown) => {
        logger.warn(`trigger workspace rescan failed: ${errorMessage(err)}`)
      })
    }
    let existing: TriggerManagerEditorInput | undefined
    const revealed = revealEditorInGroups(
      services.groups,
      (editor) => {
        if (!(editor instanceof TriggerManagerEditorInput)) return false
        existing = editor
        return true
      },
      windowFocus,
    )
    if (revealed && existing !== undefined) {
      if (triggerKey !== undefined) existing.select(triggerKey)
      return Promise.resolve(true)
    }
    return openPinnedSingletonEditor(services, target, () =>
      triggerKey === undefined
        ? new TriggerManagerEditorInput()
        : new TriggerManagerEditorInput({ pendingSelection: triggerKey }),
    )
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
    await runTriggerAction(services, async () => {
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

// The palette row uses the root `acpSessionHasAutomation` (seeded by
// ContextKeyContribution). A `precondition` would also AND into the two context
// menus and make "View Report" disappear from ordinary trigger sessions there.
const TRIGGER_REPORT_PALETTE_WHEN = `${ACP_SESSION_EDITOR_ACTIVE_WHEN} && acpSessionHasAutomation`

/**
 * Opens the read-only report tab for one trigger run. Target resolution follows
 * the session commands: explicit `sessionId`, the clicked tab's `resource`, the
 * active session tab, then the active session. The notification passes a runId
 * so the report remains reachable when its session is already gone. The palette
 * row is listed only while a trigger-started session is in front.
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
        {
          id: MenuId.CommandPalette,
          when: TRIGGER_REPORT_PALETTE_WHEN,
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
    await runTriggerAction(services, async () => {
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

function rerunServices(services: TriggerActionServices) {
  return {
    triggers: services.triggers,
    files: services.files,
    notifications: services.notifications,
    logger: services.logger,
  }
}

/**
 * Re-runs a finished run with its saved input. The active report tab wins, then
 * an explicit run id, then a history picker. Re-running replays the payload as a
 * `manual` event, so a skill edit can be verified without touching the scheduler's
 * dedupe state.
 */
export class RerunRunAction extends Action2 {
  static readonly ID = 'workbench.action.triggers.rerun'

  constructor() {
    super({
      id: RerunRunAction.ID,
      title: localize2('action.triggers.rerun.title', 'Re-run Trigger Run...'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const services = triggerActionServices(accessor)
    await runTriggerAction(services, async () => {
      const requestedRunId = typeof arg === 'string' && arg.length > 0 ? arg : undefined
      const active = services.editorService.activeEditor
      const activeReport = active instanceof TriggerReportEditorInput ? active : undefined
      const runId = requestedRunId ?? activeReport?.target.runId
      if (runId !== undefined) {
        await rerunTriggerRun(rerunServices(services), runId)
        return
      }

      const runs = await services.triggers.listRuns({ limit: 100 })
      if (runs.length === 0) {
        services.notifications.notify({
          severity: Severity.Info,
          message: localize('triggers.rerun.empty', 'No trigger runs have been recorded yet.'),
        })
        return
      }
      const selected = await services.quickInput.pick(
        runs.map((entry) => ({
          id: entry.runId,
          label: `${entry.triggerName} · ${new Date(entry.endedAt).toLocaleString()}`,
          description: entry.summary ?? entry.outcome,
          ...(entry.runDir === undefined
            ? { detail: localize('triggers.rerun.noInputShort', 'No saved input; cannot re-run') }
            : {}),
        })),
        {
          id: 'workbench.triggers.rerun',
          placeholder: localize('triggers.rerun.pick', 'Select a run to re-run'),
          matchOnDescription: true,
        },
      )
      if (selected === undefined) return
      const entry = runs.find((item) => item.runId === selected.id)
      if (entry === undefined) return
      await rerunTriggerRun(rerunServices(services), entry.runId)
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
    await runTriggerAction(services, async () => {
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
    await runTriggerAction(services, async () => {
      const summary = await pickTriggerForAction(services, 'resume')
      if (summary === undefined) return
      await setTriggerPaused(services, summary, false)
    })
  }
}

export async function setAllTriggersPaused(
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
    await runTriggerAction(services, () => setAllTriggersPaused(services, true))
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
    await runTriggerAction(services, () => setAllTriggersPaused(services, false))
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
    await runTriggerAction(services, () => openTriggerConfig(services))
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
    await runTriggerAction(services, () => showTriggerLog(services))
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
    await runTriggerAction(services, async () => {
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
    await runTriggerAction(services, async () => {
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
          { path: workspaceDisplayPath(target.workspace) },
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
