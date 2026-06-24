/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent-related Action2 definitions: new session, cancel turn, open in editor,
 *  select agent. All four show up in the command palette (`f1: true`).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IViewsService,
  ILayoutService,
  MenuId,
  PartId,
  Severity,
  localize,
  localize2,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpSessionService, type IAcpSession } from '../services/acp/acpSessionService.js'
import { IAcpAgentRegistry, agentIconId } from '../services/acp/acpAgentRegistry.js'
import { IAcpSessionHistoryService } from '../services/acp/acpSessionHistory.js'
import { IAcpChatLocationService } from '../services/acp/acpChatLocationService.js'
import { IAcpChatWidgetService } from '../services/acp/acpChatWidgetService.js'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'
import { AgentSettingsEditorInput } from '../services/editor/AgentSettingsEditorInput.js'
import { ISessionSwitcherService, type SessionSummary } from '../../shared/ipc/sessionSwitcher.js'
import { AGENT_FONT_SIZE_DEFAULT } from '../services/configuration/fontDefaults.js'
import type {
  SessionConfigOptionCategory,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'

const CATEGORY = localize2('command.category.agents', 'Agents')

export class NewAgentSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.newSession'
  constructor() {
    super({
      id: NewAgentSessionAction.ID,
      title: localize2('action.agent.newSession', 'New Agent Session'),
      keybinding: { primary: 'ctrl+alt+n' },
      category: CATEGORY,
      menu: [{ id: MenuId.AcpChatContext, group: '2_session', order: 1 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const sessions = accessor.get(IAcpSessionService)
    const registry = accessor.get(IAcpAgentRegistry)
    const layout = accessor.get(ILayoutService)
    const views = accessor.get(IViewsService)
    const location = accessor.get(IAcpChatLocationService)
    const editor = accessor.get(IEditorService)
    const inst = accessor.get(IInstantiationService)
    const session = await sessions.createSession(registry.defaultAgentId())
    if (location.location.get() === 'editor') {
      editor.openEditor(
        inst.createInstance(AcpSessionEditorInput, session.id, session.agentId, undefined),
      )
    } else {
      // Sidebar mode: just make sure the Agents view is visible so the new
      // session is reachable.
      if (!layout.getVisible(PartId.SecondarySideBar)) {
        layout.toggleVisible(PartId.SecondarySideBar)
      }
      views.openViewContainer('workbench.view.agents')
    }
  }
}

export class CancelAgentTurnAction extends Action2 {
  static readonly ID = 'workbench.action.agent.cancelTurn'
  constructor() {
    super({
      id: CancelAgentTurnAction.ID,
      title: localize2('action.agent.cancelTurn', 'Cancel Agent Turn'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+shift+escape' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const session = accessor.get(IAcpSessionService).activeSession.get()
    if (session) await session.cancelTurn()
  }
}

export class OpenAgentInEditorAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openInEditor'
  constructor() {
    super({
      id: OpenAgentInEditorAction.ID,
      title: localize2('action.agent.openInEditor', 'Open Agent Session in Editor'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    // Flip the global location flag so the side-effect handler opens the
    // active session as a tab and (if it was docked) clears the sidebar
    // version. Callers that simply want a tab opened still get the same
    // outcome — the location service is idempotent on its current value.
    accessor.get(IAcpChatLocationService).setLocation('editor')
  }
}

export class OpenAgentViewAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openView'
  constructor() {
    super({
      id: OpenAgentViewAction.ID,
      title: localize2('action.agent.openView', 'Open Agents View'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor
      .get(ILayoutService)
      .focusView('workbench.view.agents.main', { source: 'command' })
  }
}

export class ToggleAgentChatLocationAction extends Action2 {
  static readonly ID = 'workbench.action.agent.toggleChatLocation'
  constructor() {
    super({
      id: ToggleAgentChatLocationAction.ID,
      title: localize2('action.agent.toggleChatLocation', 'Toggle Agent Chat Location'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatLocationService).toggle()
  }
}

export class FocusAgentInputAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusInput'
  constructor() {
    super({
      id: FocusAgentInputAction.ID,
      title: localize2('action.agent.focusInput', 'Focus Agent Input'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+alt+i' },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.focusInput()
  }
}

export class SelectAgentAction extends Action2 {
  static readonly ID = 'workbench.action.agent.selectAgent'
  constructor() {
    super({
      id: SelectAgentAction.ID,
      title: localize2('action.agent.selectAgent', 'Choose Agent Then New Session…'),
      category: CATEGORY,
      menu: [{ id: MenuId.AcpChatContext, group: '2_session', order: 2 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // Resolve every service up-front: the accessor is only valid during this
    // synchronous frame, so reaching for it after an `await` (the health probe
    // or the quick pick below) throws "service accessor is only valid …".
    const registry = accessor.get(IAcpAgentRegistry)
    const quickInput = accessor.get(IQuickInputService)
    const sessions = accessor.get(IAcpSessionService)
    const agents = registry.list()
    const healths = await Promise.all(agents.map((a) => registry.health(a.id)))
    const items: IQuickPickItem[] = agents.map((d, i) => {
      const available = healths[i]?.available ?? false
      return {
        id: d.id,
        label: d.name,
        description: d.command,
        ...(available
          ? {}
          : {
              detail: localize(
                'agent.selectAgent.unavailable',
                'Not installed (command not found in PATH)',
              ),
            }),
      }
    })
    const picked = await quickInput.pick(items, {
      placeholder: localize('agent.selectAgent.placeholder', 'Select default ACP agent'),
    })
    if (!picked) return
    // Persist the user's choice as the new default so the next "New session" uses
    // the same agent. The original code only created a session without writing this.
    registry.setDefaultAgentId(picked.id)
    await sessions.createSession(picked.id)
  }
}

export class OpenAcpMcpSettingsAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openMcpSettings'
  constructor() {
    super({
      id: OpenAcpMcpSettingsAction.ID,
      title: localize2('action.agent.openMcpSettings', 'Open MCP Settings'),
      category: CATEGORY,
      icon: 'settings-gear',
      menu: [
        {
          id: MenuId.ViewTitle,
          when: 'view == workbench.view.agents.mcp',
          group: 'navigation',
          order: 1,
        },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // Settings UI can't deep-link to a single key yet; opening the editor lands
    // the user on the searchable settings list where `acp.mcpServers` lives.
    await accessor.get(ICommandService).executeCommand('workbench.action.openSettings')
  }
}

export class OpenAgentSettingsAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openSettings'
  constructor() {
    super({
      id: OpenAgentSettingsAction.ID,
      title: localize2('action.agent.openSettings', 'Open Agent Settings'),
      category: CATEGORY,
      icon: 'settings-gear',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IEditorService).openEditor(new AgentSettingsEditorInput(), { activate: true })
  }
}

// ---------------------------------------------------------------------------
// Session config option pickers (model / mode / thought level)
//
// These three actions all do the same thing: locate the active session's
// ConfigOption for a given category, show a QuickPick of its values, then
// apply the choice through `session.setConfigOption()`.
// ---------------------------------------------------------------------------

async function pickConfigOption(
  accessor: ServicesAccessor,
  category: SessionConfigOptionCategory,
  placeholder: string,
  notFound: string,
): Promise<void> {
  const session = accessor.get(IAcpSessionService).activeSession.get()
  if (!session) {
    accessor.get(INotificationService).notify({
      severity: Severity.Info,
      message: localize('agent.noSession', 'No active agent session.'),
    })
    return
  }
  const option = session.configOptions.get().find((o) => o.category === category)
  if (!option || option.type !== 'select') {
    accessor.get(INotificationService).notify({ severity: Severity.Info, message: notFound })
    return
  }
  const currentLabel = localize('agent.configOption.current', 'current')
  const flatValues = flattenSelectOptions(option.options)
  const items: IQuickPickItem[] = flatValues.map((v) => ({
    id: v.value,
    label: v.value === option.currentValue ? `${v.name} · ${currentLabel}` : v.name,
    ...(v.description != null ? { description: v.description } : {}),
  }))
  const picked = await accessor.get(IQuickInputService).pick(items, { placeholder })
  if (!picked || picked.id === option.currentValue) return
  await applyConfigOption(session, option.id, picked.id, accessor)
}

/**
 * SDK's `SessionConfigSelectOptions` is a union: either a flat array of
 * `SessionConfigSelectOption` or an array of `SessionConfigSelectGroup`. The
 * QuickPick UI doesn't support grouping today, so we flatten — group labels
 * are dropped, leaving just the leaf values.
 */
function flattenSelectOptions(
  options: readonly SessionConfigSelectOption[] | readonly SessionConfigSelectGroup[],
): readonly SessionConfigSelectOption[] {
  if (options.length === 0) return []
  const first = options[0]!
  if ('group' in first) {
    const groups = options as readonly SessionConfigSelectGroup[]
    return groups.flatMap((g) => g.options)
  }
  return options as readonly SessionConfigSelectOption[]
}

async function applyConfigOption(
  session: IAcpSession,
  configId: string,
  value: string,
  accessor: ServicesAccessor,
): Promise<void> {
  try {
    await session.setConfigOption(configId, value)
  } catch (err) {
    accessor.get(INotificationService).notify({
      severity: Severity.Error,
      message: localize('agent.configOption.failed', 'Failed to apply option: {error}', {
        error: (err as Error).message,
      }),
    })
  }
}

export class SelectAgentModelAction extends Action2 {
  static readonly ID = 'workbench.action.agent.selectModel'
  constructor() {
    super({
      id: SelectAgentModelAction.ID,
      title: localize2('action.agent.selectModel', 'Select Agent Model…'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await pickConfigOption(
      accessor,
      'model',
      localize('agent.selectModel.placeholder', 'Select model'),
      localize('agent.selectModel.notFound', "Active agent doesn't expose a model selector."),
    )
  }
}

export class SelectAgentModeAction extends Action2 {
  static readonly ID = 'workbench.action.agent.selectMode'
  constructor() {
    super({
      id: SelectAgentModeAction.ID,
      title: localize2('action.agent.selectMode', 'Select Agent Mode…'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await pickConfigOption(
      accessor,
      'mode',
      localize('agent.selectMode.placeholder', 'Select session mode'),
      localize('agent.selectMode.notFound', "Active agent doesn't expose session modes."),
    )
  }
}

export class SelectAgentThoughtLevelAction extends Action2 {
  static readonly ID = 'workbench.action.agent.selectThoughtLevel'
  constructor() {
    super({
      id: SelectAgentThoughtLevelAction.ID,
      title: localize2('action.agent.selectThoughtLevel', 'Select Agent Thinking Level…'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await pickConfigOption(
      accessor,
      'thought_level',
      localize('agent.selectThoughtLevel.placeholder', 'Select thinking depth'),
      localize(
        'agent.selectThoughtLevel.notFound',
        "Active agent doesn't expose a thinking-level switch.",
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Resume / clear session history (Stage 10).
//
// History is anchored on the agent's own session id and stamped with the
// workspace cwd at creation time. ResumeAgentSessionAction is a thin shim
// over `IAcpSessionService.resumeSession`: the service handles the agent
// capability gate, session/load round-trip, and rollback on failure. The
// action just renders the picker and opens the Agents view on success.
// ---------------------------------------------------------------------------

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return localize('agent.history.justNow', 'just now')
  if (diff < 3_600_000)
    return localize('agent.history.minutesAgo', '{count}m ago', {
      count: Math.floor(diff / 60_000),
    })
  if (diff < 86_400_000)
    return localize('agent.history.hoursAgo', '{count}h ago', {
      count: Math.floor(diff / 3_600_000),
    })
  return localize('agent.history.daysAgo', '{count}d ago', {
    count: Math.floor(diff / 86_400_000),
  })
}

export class ResumeAgentSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.resumeSession'
  constructor() {
    super({
      id: ResumeAgentSessionAction.ID,
      title: localize2('action.agent.resumeSession', 'Resume Agent Session…'),
      keybinding: { primary: 'ctrl+shift+h' },
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const history = accessor.get(IAcpSessionHistoryService)
    const sessions = accessor.get(IAcpSessionService)
    const quickInput = accessor.get(IQuickInputService)
    const notification = accessor.get(INotificationService)
    const layout = accessor.get(ILayoutService)
    const views = accessor.get(IViewsService)
    const location = accessor.get(IAcpChatLocationService)
    const editor = accessor.get(IEditorService)
    const inst = accessor.get(IInstantiationService)

    const entries = history.list()
    if (entries.length === 0) {
      notification.notify({
        severity: Severity.Info,
        message: localize('agent.history.empty', 'No previous agent sessions.'),
      })
      return
    }

    const items: IQuickPickItem[] = entries.map((e) => ({
      id: e.id,
      label: e.title,
      description: e.agentId,
      iconId: agentIconId(e.agentId),
      detail: e.cwd
        ? localize('agent.history.detail', '{time} · {cwd}', {
            time: relativeTime(e.lastUsedAt),
            cwd: e.cwd,
          })
        : relativeTime(e.lastUsedAt),
    }))

    const picked = await quickInput.pick(items, {
      placeholder: localize('agent.resumeSession.placeholder', 'Resume previous agent session'),
    })
    if (!picked || !picked.id) return

    try {
      const session = await sessions.resumeSession(picked.id)
      if (location.location.get() === 'editor') {
        editor.openEditor(
          inst.createInstance(AcpSessionEditorInput, session.id, session.agentId, undefined),
        )
      } else {
        sessions.setActive(session.id)
        if (!layout.getVisible(PartId.SecondarySideBar)) {
          layout.toggleVisible(PartId.SecondarySideBar)
        }
        views.openViewContainer('workbench.view.agents')
      }
    } catch {
      // resumeSession publishes its own notification; nothing to do.
    }
  }
}

export class ClearAgentSessionHistoryAction extends Action2 {
  static readonly ID = 'workbench.action.agent.clearHistory'
  constructor() {
    super({
      id: ClearAgentSessionHistoryAction.ID,
      title: localize2('action.agent.clearHistory', 'Clear Agent Session History'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const history = accessor.get(IAcpSessionHistoryService)
    const dialog = accessor.get(IDialogService)
    const notification = accessor.get(INotificationService)

    const count = history.list().length
    if (count === 0) {
      notification.notify({
        severity: Severity.Info,
        message: localize('agent.history.empty', 'No previous agent sessions.'),
      })
      return
    }

    const result = await dialog.confirm({
      type: 'warning',
      message: localize('agent.history.clear.confirm', 'Clear all {count} session entries?', {
        count,
      }),
      detail: localize(
        'agent.history.clear.detail',
        'This only removes the local history index. Conversations remain stored on the agent side until it prunes them.',
      ),
      primaryButton: localize('agent.history.clear.primary', 'Clear'),
    })
    if (!result.confirmed) return
    history.clear()
    notification.notify({
      severity: Severity.Info,
      message: localize('agent.history.clear.done', 'Agent session history cleared.'),
    })
  }
}

export class RefreshAgentSessionsAction extends Action2 {
  static readonly ID = 'workbench.action.agent.refreshSessions'
  constructor() {
    super({
      id: RefreshAgentSessionsAction.ID,
      title: localize2('action.agent.refreshSessions', 'Refresh Agent Session List'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IAcpSessionService).refreshSessions()
  }
}

// ---------------------------------------------------------------------------
// Timeline keyboard navigation (Alt+J / Alt+K, vim-style)
// Targets the focused AcpChatWidget via IAcpChatWidgetService. Gated by
// `acpChatFocused`, which the widget service toggles based on real DOM focus.
// ---------------------------------------------------------------------------

export class FocusNextAcpTimelineItemAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusNextTimelineItem'
  constructor() {
    super({
      id: FocusNextAcpTimelineItemAction.ID,
      title: localize2('action.agent.focusNextTimelineItem', 'Focus Next Timeline Item'),
      category: CATEGORY,
      icon: 'timeline-next',
      keybinding: [
        { primary: 'alt+down', when: 'acpChatFocused' },
        { primary: 'alt+j', when: 'acpChatFocused' },
      ],
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 3,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.moveTimeline('next')
  }
}

export class FocusPreviousAcpTimelineItemAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusPreviousTimelineItem'
  constructor() {
    super({
      id: FocusPreviousAcpTimelineItemAction.ID,
      title: localize2('action.agent.focusPreviousTimelineItem', 'Focus Previous Timeline Item'),
      category: CATEGORY,
      icon: 'timeline-prev',
      keybinding: [
        { primary: 'alt+up', when: 'acpChatFocused' },
        { primary: 'alt+k', when: 'acpChatFocused' },
      ],
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 2,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.moveTimeline('prev')
  }
}

export class FocusTopAcpTimelineAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusTopTimelineItem'
  constructor() {
    super({
      id: FocusTopAcpTimelineAction.ID,
      title: localize2('action.agent.focusTopTimelineItem', 'Focus Top Timeline Item'),
      category: CATEGORY,
      icon: 'timeline-top',
      keybinding: [
        { primary: 'alt+home', when: 'acpChatFocused' },
        { primary: 'alt+a', when: 'acpChatFocused' },
      ],
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 4,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.moveTimeline('first')
  }
}

export class FocusBottomAcpTimelineAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusBottomTimelineItem'
  constructor() {
    super({
      id: FocusBottomAcpTimelineAction.ID,
      title: localize2('action.agent.focusBottomTimelineItem', 'Focus Bottom Timeline Item'),
      category: CATEGORY,
      icon: 'timeline-bottom',
      keybinding: [
        { primary: 'alt+end', when: 'acpChatFocused' },
        { primary: 'alt+e', when: 'acpChatFocused' },
      ],
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 5,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.moveTimeline('last')
  }
}

export class JumpToAcpPlanAction extends Action2 {
  static readonly ID = 'workbench.action.agent.jumpToPlan'
  constructor() {
    super({
      id: JumpToAcpPlanAction.ID,
      title: localize2('action.agent.jumpToPlan', 'Jump to Plan'),
      category: CATEGORY,
      icon: 'go-to-plan',
      keybinding: { primary: 'alt+p', when: 'acpChatFocused' },
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 1,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.jumpToPlan()
  }
}

export class ShowAcpSessionChangesAction extends Action2 {
  static readonly ID = 'workbench.action.agent.showSessionChanges'
  constructor() {
    super({
      id: ShowAcpSessionChangesAction.ID,
      title: localize2('action.agent.showSessionChanges', 'Show Session Changes'),
      category: CATEGORY,
      icon: 'diff',
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 0,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IViewsService).openViewContainer('workbench.view.sessionChanges')
  }
}

export class ScrollAcpTimelineUpAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelineUp'
  constructor() {
    super({
      id: ScrollAcpTimelineUpAction.ID,
      title: localize2('action.agent.scrollTimelineUp', 'Scroll Timeline Up'),
      category: CATEGORY,
      keybinding: [
        { primary: 'ctrl+alt+up', when: 'acpChatFocused' },
        { primary: 'ctrl+alt+k', when: 'acpChatFocused' },
      ],
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.scrollTimeline('up')
  }
}

export class ScrollAcpTimelineDownAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelineDown'
  constructor() {
    super({
      id: ScrollAcpTimelineDownAction.ID,
      title: localize2('action.agent.scrollTimelineDown', 'Scroll Timeline Down'),
      category: CATEGORY,
      keybinding: [
        { primary: 'ctrl+alt+down', when: 'acpChatFocused' },
        { primary: 'ctrl+alt+j', when: 'acpChatFocused' },
      ],
      precondition: 'acpChatFocused',
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.scrollTimeline('down')
  }
}

export class ScrollAcpTimelinePageUpAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelinePageUp'
  constructor() {
    super({
      id: ScrollAcpTimelinePageUpAction.ID,
      title: localize2('action.agent.scrollTimelinePageUp', 'Scroll Timeline Page Up'),
      category: CATEGORY,
      keybinding: [{ primary: 'ctrl+alt+pageup', when: 'acpChatFocused' }],
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.scrollTimeline('pageUp')
  }
}

export class ScrollAcpTimelinePageDownAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelinePageDown'
  constructor() {
    super({
      id: ScrollAcpTimelinePageDownAction.ID,
      title: localize2('action.agent.scrollTimelinePageDown', 'Scroll Timeline Page Down'),
      category: CATEGORY,
      keybinding: [{ primary: 'ctrl+alt+pagedown', when: 'acpChatFocused' }],
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.scrollTimeline('pageDown')
  }
}

export class ScrollAcpTimelineToTopAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelineToTop'
  constructor() {
    super({
      id: ScrollAcpTimelineToTopAction.ID,
      title: localize2('action.agent.scrollTimelineToTop', 'Scroll Timeline to Top'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+alt+home', when: 'acpChatFocused' },
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.scrollTimeline('top')
  }
}

export class ScrollAcpTimelineToBottomAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelineToBottom'
  constructor() {
    super({
      id: ScrollAcpTimelineToBottomAction.ID,
      title: localize2('action.agent.scrollTimelineToBottom', 'Scroll Timeline to Bottom'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+alt+end', when: 'acpChatFocused' },
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.scrollTimeline('bottom')
  }
}

export class ToggleAcpTimelineItemCollapseAction extends Action2 {
  static readonly ID = 'workbench.action.agent.toggleTimelineItemCollapse'
  constructor() {
    super({
      id: ToggleAcpTimelineItemCollapseAction.ID,
      title: localize2('action.agent.toggleTimelineItemCollapse', 'Toggle Timeline Item Collapse'),
      category: CATEGORY,
      keybinding: { primary: 'alt+f', when: 'acpChatFocused' },
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.toggleCollapse()
  }
}

export class CycleAcpTimelineCollapseAction extends Action2 {
  static readonly ID = 'workbench.action.agent.cycleTimelineCollapse'
  constructor() {
    super({
      id: CycleAcpTimelineCollapseAction.ID,
      title: localize2('action.agent.cycleTimelineCollapse', 'Cycle Timeline Collapse (All)'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+alt+f', when: 'acpChatFocused' },
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.cycleCollapseMode()
  }
}

// ---------------------------------------------------------------------------
// Prompt suggestion popover navigation (slash-command + @-mention lists).
//
// These mirror VSCode's SuggestWidget commands: navigation / accept / hide are
// real keybindings gated on `acpPromptPopupVisible` (owned by the focused
// PromptInput via IAcpChatWidgetService), routed to the focused widget. The
// PromptInput no longer hand-rolls these keys in onKeyDown — the global handler
// resolves them through the registry like any other command.
//
// `ctrl+k` is deliberately absent: it is the app's chord leader (ctrl+k ctrl+s,
// …), and resolveKeystroke checks chord prefixes before single strokes, so a
// single-stroke ctrl+k here would be shadowed. ctrl+n/ctrl+p (the keys VSCode's
// own suggest widget uses) plus arrows cover navigation cleanly.
// ---------------------------------------------------------------------------

export class SelectNextAcpPromptSuggestionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.selectNextSuggestion'
  constructor() {
    super({
      id: SelectNextAcpPromptSuggestionAction.ID,
      title: localize2('action.agent.prompt.selectNextSuggestion', 'Select Next Suggestion'),
      category: CATEGORY,
      keybinding: [
        { primary: 'down', when: 'acpPromptPopupVisible' },
        { primary: 'ctrl+n', when: 'acpPromptPopupVisible' },
        { primary: 'ctrl+j', when: 'acpPromptPopupVisible' },
      ],
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.popoverSelectNext()
  }
}

export class SelectPreviousAcpPromptSuggestionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.selectPreviousSuggestion'
  constructor() {
    super({
      id: SelectPreviousAcpPromptSuggestionAction.ID,
      title: localize2(
        'action.agent.prompt.selectPreviousSuggestion',
        'Select Previous Suggestion',
      ),
      category: CATEGORY,
      keybinding: [
        { primary: 'up', when: 'acpPromptPopupVisible' },
        { primary: 'ctrl+p', when: 'acpPromptPopupVisible' },
      ],
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.popoverSelectPrev()
  }
}

export class AcceptAcpPromptSuggestionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.acceptSuggestion'
  constructor() {
    super({
      id: AcceptAcpPromptSuggestionAction.ID,
      title: localize2('action.agent.prompt.acceptSuggestion', 'Accept Suggestion'),
      category: CATEGORY,
      keybinding: [
        { primary: 'tab', when: 'acpPromptPopupVisible' },
        { primary: 'enter', when: 'acpPromptPopupVisible' },
      ],
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.popoverAccept()
  }
}

export class HideAcpPromptSuggestionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.hideSuggestion'
  constructor() {
    super({
      id: HideAcpPromptSuggestionAction.ID,
      title: localize2('action.agent.prompt.hideSuggestion', 'Hide Suggestions'),
      category: CATEGORY,
      keybinding: [{ primary: 'escape', when: 'acpPromptPopupVisible' }],
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.popoverHide()
  }
}

// ---------------------------------------------------------------------------
// In-session find (Ctrl+F). Modeled on Monaco's find widget so the keys match:
// Ctrl+F opens, F3 / Shift+F3 step through matches, Escape closes. Open gates on
// `acpChatFocused` (Ctrl+F from anywhere in the chat); the navigation / close
// commands gate on `acpChatFindVisible` (true only when the *focused* widget's
// find bar is open) so they don't shadow F3 / Escape elsewhere.
// ---------------------------------------------------------------------------

export class ChatFindAction extends Action2 {
  static readonly ID = 'workbench.action.agent.find'
  constructor() {
    super({
      id: ChatFindAction.ID,
      title: localize2('action.agent.find', 'Find in Session'),
      category: CATEGORY,
      icon: 'search',
      keybinding: { primary: 'ctrl+f', when: 'acpChatFocused' },
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 0,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.openFind()
  }
}

export class ChatFindNextAction extends Action2 {
  static readonly ID = 'workbench.action.agent.findNext'
  constructor() {
    super({
      id: ChatFindNextAction.ID,
      title: localize2('action.agent.findNext', 'Find Next'),
      category: CATEGORY,
      keybinding: { primary: 'f3', when: 'acpChatFindVisible' },
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.findNext()
  }
}

export class ChatFindPreviousAction extends Action2 {
  static readonly ID = 'workbench.action.agent.findPrevious'
  constructor() {
    super({
      id: ChatFindPreviousAction.ID,
      title: localize2('action.agent.findPrevious', 'Find Previous'),
      category: CATEGORY,
      keybinding: { primary: 'shift+f3', when: 'acpChatFindVisible' },
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.findPrev()
  }
}

export class ChatFindCloseAction extends Action2 {
  static readonly ID = 'workbench.action.agent.findClose'
  constructor() {
    super({
      id: ChatFindCloseAction.ID,
      title: localize2('action.agent.findClose', 'Close Find'),
      category: CATEGORY,
      keybinding: { primary: 'escape', when: 'acpChatFindVisible' },
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.closeFind()
  }
}

interface SessionSwitchPickItem extends IQuickPickItem {
  readonly windowId: number
  readonly sessionId: string
}

export class CopyFocusedAcpMessageAction extends Action2 {
  static readonly ID = 'workbench.action.agent.copyFocusedMessage'
  constructor() {
    super({
      id: CopyFocusedAcpMessageAction.ID,
      title: localize2('action.agent.copyFocusedMessage', 'Copy Message'),
      category: CATEGORY,
      precondition: 'acpChatFocused',
      menu: [{ id: MenuId.AcpChatContext, group: '1_copy', order: 1 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const text = accessor.get(IAcpChatWidgetService).lastFocusedWidget?.getFocusedText()
    if (text) await navigator.clipboard.writeText(text)
  }
}

export class SwitchSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.switchSession'
  constructor() {
    super({
      id: SwitchSessionAction.ID,
      title: localize2('action.agent.switchSession', 'Switch Session…'),
      category: CATEGORY,
      keybinding: { primary: 'alt+s' },
      menu: [{ id: MenuId.AcpChatContext, group: '3_switch', order: 1 }],
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const switcher = accessor.get(ISessionSwitcherService)
    const quickInput = accessor.get(IQuickInputService)
    const activeSessionId = accessor.get(IAcpSessionService).activeSession.get()?.id
    const sessions = await switcher.getAllSessions()
    if (sessions.length === 0) return
    const items: SessionSwitchPickItem[] = sessions.map((s: SessionSummary) => ({
      id: `${s.windowId}.${s.sessionId}`,
      leadingLabel:
        s.workspaceName.length > 0
          ? s.workspaceName
          : localize('agent.switchSession.untitled', 'Untitled'),
      label: s.title,
      statusIconId: s.status,
      windowId: s.windowId,
      sessionId: s.sessionId,
    }))
    const activeItemId = items.find((it) => it.sessionId === activeSessionId)?.id
    const pick = await quickInput.pick<SessionSwitchPickItem>(items, {
      placeholder: localize('agent.switchSession.placeholder', 'Switch to a session in any window'),
      ...(activeItemId !== undefined ? { activeItemId } : {}),
    })
    if (!pick) return
    await switcher.reveal(pick.windowId, pick.sessionId)
  }
}

const FONT_SIZE_KEY = 'acp.fontSize'
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 24

function currentFontSize(config: IConfigurationService): number {
  const size = config.get<number>(FONT_SIZE_KEY)
  return typeof size === 'number' && size > 0 ? size : AGENT_FONT_SIZE_DEFAULT
}

export class IncreaseAgentFontSizeAction extends Action2 {
  static readonly ID = 'workbench.action.agent.increaseFontSize'
  constructor() {
    super({
      id: IncreaseAgentFontSizeAction.ID,
      title: localize2('action.agent.increaseFontSize', 'Increase Chat Font Size'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+=', when: 'acpChatFocused' },
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const next = Math.min(FONT_SIZE_MAX, currentFontSize(config) + 1)
    config.update(FONT_SIZE_KEY, next, ConfigurationTarget.User)
  }
}

export class DecreaseAgentFontSizeAction extends Action2 {
  static readonly ID = 'workbench.action.agent.decreaseFontSize'
  constructor() {
    super({
      id: DecreaseAgentFontSizeAction.ID,
      title: localize2('action.agent.decreaseFontSize', 'Decrease Chat Font Size'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+-', when: 'acpChatFocused' },
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const next = Math.max(FONT_SIZE_MIN, currentFontSize(config) - 1)
    config.update(FONT_SIZE_KEY, next, ConfigurationTarget.User)
  }
}

export class ResetAgentFontSizeAction extends Action2 {
  static readonly ID = 'workbench.action.agent.resetFontSize'
  constructor() {
    super({
      id: ResetAgentFontSizeAction.ID,
      title: localize2('action.agent.resetFontSize', 'Reset Chat Font Size'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+0', when: 'acpChatFocused' },
      precondition: 'acpChatFocused',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor
      .get(IConfigurationService)
      .update(FONT_SIZE_KEY, AGENT_FONT_SIZE_DEFAULT, ConfigurationTarget.User)
  }
}
