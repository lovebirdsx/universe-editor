/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Add Selection to Agent Chat — grabs every non-empty selection in the focused
 *  file editor and attaches them to the agent chat input as context chips
 *  (Cursor's Ctrl+L / Copilot's "Add Selection to Chat").
 *
 *  Selection → SelectionContext (uri + snapshotted text + 1-based line range).
 *  The target chat's ChatBody may not be mounted when the command runs (editor
 *  mode with the session tab closed, or a session we just created), so we cannot
 *  call the widget directly. Instead we resolve/create the target session,
 *  deposit the contexts into AcpPromptContextInbox (keyed by the session's local
 *  id), then reveal + focus that chat; PromptInput drains its inbox on mount and
 *  reacts to deposits while mounted, so the hand-off survives the not-mounted →
 *  mounted transition.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  IEditorGroupsService,
  IInstantiationService,
  IViewsService,
  IWorkspaceService,
  ILayoutService,
  PartId,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { IAcpChatWidgetService } from '../services/acp/acpChatWidgetService.js'
import { IAcpChatLocationService } from '../services/acp/acpChatLocationService.js'
import { IAcpSessionService, type SelectionContext } from '../services/acp/acpSessionService.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'
import { AcpPromptContextInbox } from '../services/acp/acpPromptContextInbox.js'
import { AcpPromptTextInbox } from '../services/acp/acpPromptTextInbox.js'
import { toMentionName } from '../services/dnd/resourceDropTransfer.js'
import { CATEGORY } from './_agentShared.js'

export class AddSelectionToAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.addSelectionToChat'
  constructor() {
    super({
      id: AddSelectionToAgentChatAction.ID,
      title: localize2('action.agent.addSelectionToChat', 'Add Selection to Agent Chat'),
      category: CATEGORY,
      precondition: 'editorTextFocus',
      keybinding: { primary: ['ctrl+k', 'ctrl+l'] },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const contexts = collectSelectionContexts(accessor)
    if (contexts.length === 0) return
    // Resolve every service synchronously up front: the accessor is only valid
    // during run's synchronous scope, so nothing below the first await may touch it.
    const reveal = captureRevealServices(accessor)
    const target = await resolveTargetSession(reveal)

    // Deposit before revealing so a freshly-mounting PromptInput drains it, and a
    // already-mounted one gets the onDidDeposit event — either way it lands.
    AcpPromptContextInbox.deposit(target.id, contexts)
    await revealChat(reveal, target.id)
  }
}

/** Payload for {@link SendCommitToAgentChatAction}: the Git Graph passes the
 *  clicked commit's hash and subject so the action can compose the context text. */
export interface SendCommitToAgentChatArg {
  readonly hash: string
  readonly message: string
}

/**
 * Send a commit's hash + subject to the agent chat input as plain text, so the
 * user can ask the agent about that commit. Invoked from the Git Graph commit
 * context menu with a {@link SendCommitToAgentChatArg}; not exposed in the
 * command palette (it needs the commit argument).
 */
export class SendCommitToAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.sendCommitToChat'
  constructor() {
    super({
      id: SendCommitToAgentChatAction.ID,
      title: localize2('action.agent.sendCommitToChat', 'Send to Agent Chat'),
      category: CATEGORY,
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor, arg?: SendCommitToAgentChatArg): Promise<void> {
    if (!arg || !arg.hash) return
    const subject = arg.message.trim()
    const text = subject ? `Commit ${arg.hash}: ${subject}` : `Commit ${arg.hash}`
    // Capture services before the first await — the accessor dies past it.
    const reveal = captureRevealServices(accessor)
    const target = await resolveTargetSession(reveal)

    // Deposit before revealing so a freshly-mounting PromptInput drains it, and an
    // already-mounted one gets the onDidDeposit event — either way it lands.
    AcpPromptTextInbox.deposit(target.id, text)
    await revealChat(reveal, target.id)
  }
}

// Services revealChat / resolveTargetSession need, snapshotted while the accessor
// is still valid (i.e. before run's first await).
interface RevealServices {
  readonly sessions: IAcpSessionService
  readonly registry: IAcpAgentRegistry
  readonly location: IAcpChatLocationService
  readonly widgets: IAcpChatWidgetService
  readonly groups: IEditorGroupsService
  readonly inst: IInstantiationService
  readonly layout: ILayoutService
  readonly views: IViewsService
}

function captureRevealServices(accessor: ServicesAccessor): RevealServices {
  return {
    sessions: accessor.get(IAcpSessionService),
    registry: accessor.get(IAcpAgentRegistry),
    location: accessor.get(IAcpChatLocationService),
    widgets: accessor.get(IAcpChatWidgetService),
    groups: accessor.get(IEditorGroupsService),
    inst: accessor.get(IInstantiationService),
    layout: accessor.get(ILayoutService),
    views: accessor.get(IViewsService),
  }
}

// Resolve the target session up front: the active one, else create a fresh
// session so the context always has a home even from a cold start.
async function resolveTargetSession(services: RevealServices) {
  const active = services.sessions.activeSession.get()
  if (active) return active
  return services.sessions.createSession(services.registry.defaultAgentId())
}

function collectSelectionContexts(accessor: ServicesAccessor): readonly SelectionContext[] {
  const active = accessor.get(IEditorService).activeEditor.get()
  if (!(active instanceof FileEditorInput)) return []
  const editor = FileEditorRegistry.get(active)
  const model = editor?.getModel()
  if (!editor || !model) return []
  const workspaceRoot = accessor.get(IWorkspaceService).current?.folder
  const { name: relPath } = toMentionName(active.resource, workspaceRoot)
  const languageId = model.getLanguageId()

  const out: SelectionContext[] = []
  for (const sel of editor.getSelections() ?? []) {
    if (sel.isEmpty()) continue
    const text = model.getValueInRange(sel)
    if (text.trim().length === 0) continue
    out.push({
      uri: active.resource.toString(),
      relPath,
      text,
      startLine: sel.startLineNumber,
      endLine: sel.endLineNumber,
      ...(languageId ? { languageId } : {}),
    })
  }
  return out
}

// Make the target session's chat visible and focus its input so the user sees
// the freshly-attached chips and can keep typing. Editor mode → open the session
// as a tab; sidebar mode → surface the Agents view. Focus is best-effort (the
// widget may still be mounting; the inbox drain covers that case).
async function revealChat(services: RevealServices, sessionId: string): Promise<void> {
  const { location, widgets, groups, inst, layout, views, sessions } = services
  if (location.location.get() === 'editor') {
    // The session editor may already live in another group (e.g. Git Graph on the
    // left, session on the right). Reveal that existing tab instead of opening a
    // duplicate in the active group.
    const found = findSessionEditor(groups, sessionId)
    if (found) {
      groups.activateGroup(found.group)
      found.group.setActive(found.editor)
    } else {
      const session = sessions.getById(sessionId)
      if (session) {
        const target = groups.activeGroupForOpen
        target.openEditor(
          inst.createInstance(AcpSessionEditorInput, session.id, session.agentId, undefined),
          { activate: true, pinned: true },
        )
        if (target !== groups.activeGroup) groups.activateGroup(target)
      }
    }
  } else {
    if (!layout.getVisible(PartId.SecondarySideBar)) layout.toggleVisible(PartId.SecondarySideBar)
    await views.openViewContainer('workbench.view.agents')
  }
  widgets.focusSessionInput(sessionId)
}

/** Locate an already-open session editor (and its group) across all groups. */
function findSessionEditor(groups: IEditorGroupsService, sessionId: string) {
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor instanceof AcpSessionEditorInput && editor.sessionId === sessionId) {
        return { group, editor }
      }
    }
  }
  return undefined
}

export const agentContextActions: readonly (new () => Action2)[] = [
  AddSelectionToAgentChatAction,
  SendCommitToAgentChatAction,
]
