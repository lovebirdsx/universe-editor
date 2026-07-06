/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent session lifecycle commands: new / cancel / open-in-editor / open-view /
 *  toggle-location / focus-input / select-agent / resume / clear-history /
 *  refresh / switch-session.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IUriIdentityService,
  IViewsService,
  IWorkspaceService,
  ILayoutService,
  MenuId,
  PartId,
  Severity,
  localize,
  localize2,
  type IEditorGroup,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'
import { IAcpAgentRegistry, agentIconId } from '../services/acp/acpAgentRegistry.js'
import { IAcpSessionHistoryService } from '../services/acp/acpSessionHistory.js'
import { IAcpChatLocationService } from '../services/acp/acpChatLocationService.js'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'
import { resolveLiveSessionTitle } from '../services/acp/acpSessionTitle.js'
import { ISessionSwitcherService, type SessionSummary } from '../../shared/ipc/sessionSwitcher.js'
import { basenameOfPath } from '../workbench/files/resourceInfo.js'
import { CATEGORY, resolveNavWidget } from './_agentShared.js'

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

export class NewAgentSessionInCurrentEditorAction extends Action2 {
  static readonly ID = 'workbench.action.agent.newSessionInCurrentEditor'
  constructor() {
    super({
      id: NewAgentSessionInCurrentEditorAction.ID,
      title: localize2(
        'action.agent.newSessionInCurrentEditor',
        'New Agent Session in Current Editor',
      ),
      category: CATEGORY,
      icon: 'add',
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 0,
        },
        {
          id: MenuId.AcpChatContext,
          group: '2_session',
          order: 1.5,
        },
      ],
      f1: true,
    })
  }

  override async run(
    accessor: ServicesAccessor,
    arg?: { groupId?: unknown; sessionId?: unknown },
  ): Promise<void> {
    const sessions = accessor.get(IAcpSessionService)
    const registry = accessor.get(IAcpAgentRegistry)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)

    const group = resolveEditorGroup(arg, groups)
    const current = resolveTargetSessionEditor(arg, group) ?? group.activeEditor
    const agentId = resolveSessionEditorAgentId(current, sessions) ?? registry.defaultAgentId()

    const session = await sessions.createSession(agentId)
    const nextInput = inst.createInstance(
      AcpSessionEditorInput,
      session.id,
      session.agentId,
      undefined,
    )

    // Open the new session as its own tab right after the current one, keeping
    // the existing session open. `openSessionEditorInGroup` drives the group
    // model directly, so a locked group still accepts the new tab (the lock only
    // guards lock-aware routing, which the createSession side effect below hits).
    const index = current instanceof AcpSessionEditorInput ? group.indexOf(current) : -1
    openSessionEditorInGroup(group, nextInput, index >= 0 ? index + 1 : undefined)
    closeDuplicateSessionEditors(groups, group, session.id)
    // createSession's side effect (the chat-location autorun) opens the new
    // session through IEditorService, whose lock-aware routing hands a fresh
    // editor to a different unlocked group and activates it. Re-assert this
    // group as active so focus stays where the user clicked "new session".
    groups.activateGroup(group)
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
    resolveNavWidget(accessor)?.focusInput()
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

function sessionDirectoryName(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined
  const normalized = cwd.replace(/[\\/]+$/, '')
  if (normalized.length === 0) return cwd
  const name = basenameOfPath(normalized)
  return name.length > 0 ? name : cwd
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
    const workspace = accessor.get(IWorkspaceService)
    const uriIdentity = accessor.get(IUriIdentityService)

    const entries = history.list()
    if (entries.length === 0) {
      notification.notify({
        severity: Severity.Info,
        message: localize('agent.history.empty', 'No previous agent sessions.'),
      })
      return
    }

    const items: IQuickPickItem[] = entries.map((e) => {
      const directoryName = sessionDirectoryName(e.cwd)
      return {
        id: e.id,
        label: e.title,
        ...(directoryName !== undefined ? { description: directoryName } : {}),
        iconId: agentIconId(e.agentId),
        detail: e.cwd
          ? localize('agent.history.detail', '{time} · {cwd}', {
              time: relativeTime(e.lastUsedAt),
              cwd: e.cwd,
            })
          : relativeTime(e.lastUsedAt),
      }
    })

    const picked = await quickInput.pick(items, {
      placeholder: localize('agent.resumeSession.placeholder', 'Resume previous agent session'),
    })
    if (!picked || !picked.id) return

    // A session whose cwd differs from the open folder must not be resumed live —
    // that would spawn the agent against a sibling worktree behind this window's
    // UI (split-brain). Mirror SessionListBody: open it as a read-only preview tab
    // (the editor resumes it via session/load read-only and lets the user activate
    // the owning worktree from there) instead of letting resumeSession throw an
    // AcpForeignWorktreeError into the empty catch below — which looked like the
    // pick did nothing at all.
    const entry = entries.find((e) => e.id === picked.id)
    const currentCwd = workspace.current?.folder.fsPath
    if (
      entry &&
      entry.cwd !== undefined &&
      currentCwd !== undefined &&
      !uriIdentity.arePathsEqual(entry.cwd, currentCwd)
    ) {
      editor.openEditor(
        inst.createInstance(AcpSessionEditorInput, entry.id, entry.agentId, entry.title),
      )
      return
    }

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

interface SessionSwitchPickItem extends IQuickPickItem {
  readonly windowId: number
  readonly sessionId: string
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

/**
 * Rename the current (or a specified) session. Target resolution order:
 *  1. explicit `{ sessionId }` arg (session list button),
 *  2. the `{ resource }` arg from the editor tab context menu,
 *  3. the active AcpSessionEditorInput (editor focused),
 *  4. the active session (command palette / sidebar chat).
 * Renders a QuickInput box prefilled with the current title.
 */
export class RenameAgentSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.renameSession'
  constructor() {
    super({
      id: RenameAgentSessionAction.ID,
      title: localize2('action.agent.renameSession', 'Rename Agent Session…'),
      category: CATEGORY,
      menu: [
        { id: MenuId.AcpChatContext, group: '2_session', order: 3 },
        {
          id: MenuId.EditorTabContext,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: '1_session',
          order: 1,
        },
      ],
      f1: true,
    })
  }
  override async run(
    accessor: ServicesAccessor,
    arg?: { sessionId?: unknown; resource?: unknown },
  ): Promise<void> {
    // Snapshot every service synchronously — the accessor is invalid after the
    // first await (the input box below).
    const sessions = accessor.get(IAcpSessionService)
    const history = accessor.get(IAcpSessionHistoryService)
    const quickInput = accessor.get(IQuickInputService)
    const editor = accessor.get(IEditorService)

    const sessionId = resolveRenameTargetId(arg, editor, sessions)
    if (sessionId === undefined) return

    const current = resolveLiveSessionTitle(history, sessions, sessionId)
    const next = await quickInput.input({
      value: current ?? '',
      prompt: localize('agent.rename.prompt', 'Enter a new title for this session'),
      validateInput: (v) =>
        v.trim().length === 0 ? localize('agent.rename.empty', 'Title cannot be empty') : undefined,
    })
    if (next === undefined) return
    const trimmed = next.trim()
    if (trimmed.length === 0 || trimmed === current) return
    sessions.renameSession(sessionId, trimmed)
  }
}

/** Extract the session id from an AcpSessionEditorInput resource: `universe:/acp/session/<id>`. */
function sessionIdFromResource(resource: unknown): string | undefined {
  const path =
    typeof resource === 'object' && resource !== null
      ? (resource as { path?: unknown }).path
      : undefined
  if (typeof path !== 'string') return undefined
  const m = /^\/acp\/session\/(.+)$/.exec(path)
  return m ? m[1] : undefined
}

function resolveRenameTargetId(
  arg: { sessionId?: unknown; resource?: unknown } | undefined,
  editor: IEditorService,
  sessions: IAcpSessionService,
): string | undefined {
  if (arg && typeof arg.sessionId === 'string' && arg.sessionId.length > 0) {
    return arg.sessionId
  }
  const fromResource = sessionIdFromResource(arg?.resource)
  if (fromResource !== undefined) return fromResource
  const active = editor.activeEditor.get()
  if (active instanceof AcpSessionEditorInput) return active.sessionId
  return sessions.activeSession.get()?.id
}

function resolveEditorGroup(
  arg: { groupId?: unknown; sessionId?: unknown } | undefined,
  groups: IEditorGroupsService,
): IEditorGroup {
  const groupId = typeof arg?.groupId === 'number' ? arg.groupId : undefined
  if (groupId !== undefined) {
    const group = groups.getGroup(groupId)
    if (group !== undefined) return group
  }
  const sessionId = typeof arg?.sessionId === 'string' ? arg.sessionId : undefined
  if (sessionId !== undefined) {
    for (const group of groups.groups) {
      if (
        group.editors.some(
          (editor) => editor instanceof AcpSessionEditorInput && editor.sessionId === sessionId,
        )
      ) {
        return group
      }
    }
  }
  return groups.activeGroup
}

function resolveTargetSessionEditor(
  arg: { sessionId?: unknown } | undefined,
  group: IEditorGroup,
): AcpSessionEditorInput | undefined {
  const sessionId = typeof arg?.sessionId === 'string' ? arg.sessionId : undefined
  if (sessionId === undefined) return undefined
  return group.editors.find(
    (editor): editor is AcpSessionEditorInput =>
      editor instanceof AcpSessionEditorInput && editor.sessionId === sessionId,
  )
}

function resolveSessionEditorAgentId(
  editor: IEditorGroup['activeEditor'],
  sessions: IAcpSessionService,
): string | undefined {
  if (editor instanceof AcpSessionEditorInput) {
    return editor.agentId ?? sessions.getById(editor.sessionId)?.agentId
  }
  return sessions.activeSession.get()?.agentId
}

function openSessionEditorInGroup(
  group: IEditorGroup,
  input: AcpSessionEditorInput,
  index: number | undefined,
): void {
  const existing = group.findEditor(input)
  if (existing !== undefined) {
    input.dispose()
    if (index !== undefined && group.indexOf(existing) !== index) {
      group.moveEditor(existing, index)
    }
    group.pinEditor(existing)
    group.setActive(existing)
    return
  }
  group.openEditor(input, {
    activate: true,
    pinned: true,
    ...(index !== undefined ? { index } : {}),
  })
}

function closeDuplicateSessionEditors(
  groups: IEditorGroupsService,
  targetGroup: IEditorGroup,
  sessionId: string,
): void {
  for (const group of groups.groups) {
    if (group === targetGroup) continue
    for (const editor of [...group.editors]) {
      if (editor instanceof AcpSessionEditorInput && editor.sessionId === sessionId) {
        group.closeEditor(editor)
      }
    }
  }
}
