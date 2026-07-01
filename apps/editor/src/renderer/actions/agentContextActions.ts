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
    const sessions = accessor.get(IAcpSessionService)
    const registry = accessor.get(IAcpAgentRegistry)

    // Resolve the target session up front: the active one, else create a fresh
    // session so the contexts always have a home even from a cold start.
    let target = sessions.activeSession.get()
    if (!target) target = await sessions.createSession(registry.defaultAgentId())

    // Deposit before revealing so a freshly-mounting PromptInput drains it, and a
    // already-mounted one gets the onDidDeposit event — either way it lands.
    AcpPromptContextInbox.deposit(target.id, contexts)
    await revealChat(accessor, target.id)
  }
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
async function revealChat(accessor: ServicesAccessor, sessionId: string): Promise<void> {
  const location = accessor.get(IAcpChatLocationService)
  const widgets = accessor.get(IAcpChatWidgetService)
  if (location.location.get() === 'editor') {
    const editor = accessor.get(IEditorService)
    const inst = accessor.get(IInstantiationService)
    const already = editor.activeEditor.get()
    if (!(already instanceof AcpSessionEditorInput) || already.sessionId !== sessionId) {
      const session = accessor.get(IAcpSessionService).getById(sessionId)
      if (session) {
        editor.openEditor(
          inst.createInstance(AcpSessionEditorInput, session.id, session.agentId, undefined),
        )
      }
    }
  } else {
    const layout = accessor.get(ILayoutService)
    if (!layout.getVisible(PartId.SecondarySideBar)) layout.toggleVisible(PartId.SecondarySideBar)
    await accessor.get(IViewsService).openViewContainer('workbench.view.agents')
  }
  widgets.focusSessionInput(sessionId)
}

export const agentContextActions: readonly (new () => Action2)[] = [AddSelectionToAgentChatAction]
