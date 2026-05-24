/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent-related Action2 definitions: new session, cancel turn, open in editor,
 *  select agent. All four show up in the command palette (`f1: true`).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  INotificationService,
  IQuickInputService,
  IViewsService,
  ILayoutService,
  PartId,
  Severity,
  localize,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpSessionService, type IAcpSession } from '../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { IAcpSessionHistoryService } from '../services/acp/acpSessionHistory.js'
import { IAcpChatLocationService } from '../services/acp/acpChatLocationService.js'
import { IAcpFocusService } from '../services/acp/acpFocusService.js'
import type {
  SessionConfigOptionCategory,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'

const CATEGORY = localize('command.category.agents', 'Agents')

export class NewAgentSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.newSession'
  constructor() {
    super({
      id: NewAgentSessionAction.ID,
      title: localize('action.agent.newSession', 'New Agent Session'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const sessions = accessor.get(IAcpSessionService)
    const registry = accessor.get(IAcpAgentRegistry)
    const layout = accessor.get(ILayoutService)
    const views = accessor.get(IViewsService)
    await sessions.createSession(registry.defaultAgentId())
    // Make sure the Agents view is visible so the new session is reachable.
    if (!layout.getVisible(PartId.SecondarySideBar)) {
      layout.toggleVisible(PartId.SecondarySideBar)
    }
    views.openViewContainer('workbench.view.agents')
  }
}

export class CancelAgentTurnAction extends Action2 {
  static readonly ID = 'workbench.action.agent.cancelTurn'
  constructor() {
    super({
      id: CancelAgentTurnAction.ID,
      title: localize('action.agent.cancelTurn', 'Cancel Agent Turn'),
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
      title: localize('action.agent.openInEditor', 'Open Agent Session in Editor'),
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

export class ToggleAgentChatLocationAction extends Action2 {
  static readonly ID = 'workbench.action.agent.toggleChatLocation'
  constructor() {
    super({
      id: ToggleAgentChatLocationAction.ID,
      title: localize('action.agent.toggleChatLocation', 'Toggle Agent Chat Location'),
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
      title: localize('action.agent.focusInput', 'Focus Agent Input'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+alt+i' },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpFocusService).requestFocus()
  }
}

export class SelectAgentAction extends Action2 {
  static readonly ID = 'workbench.action.agent.selectAgent'
  constructor() {
    super({
      id: SelectAgentAction.ID,
      title: localize('action.agent.selectAgent', 'Select Default Agent…'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const registry = accessor.get(IAcpAgentRegistry)
    const quickInput = accessor.get(IQuickInputService)
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
    // Update the default agent at runtime (Memory layer). User can persist via Settings UI.
    const sessions = accessor.get(IAcpSessionService)
    await sessions.createSession(picked.id)
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
      title: localize('action.agent.selectModel', 'Select Agent Model…'),
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
      title: localize('action.agent.selectMode', 'Select Agent Mode…'),
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
      title: localize('action.agent.selectThoughtLevel', 'Select Agent Thinking Level…'),
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
      title: localize('action.agent.resumeSession', 'Resume Agent Session…'),
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
      // Reveal the Agents view + focus the resumed session.
      sessions.setActive(session.id)
      if (!layout.getVisible(PartId.SecondarySideBar)) {
        layout.toggleVisible(PartId.SecondarySideBar)
      }
      views.openViewContainer('workbench.view.agents')
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
      title: localize('action.agent.clearHistory', 'Clear Agent Session History'),
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
