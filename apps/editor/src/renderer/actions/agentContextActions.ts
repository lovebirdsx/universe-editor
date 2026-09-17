/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Add Selection to Agent Chat — grabs every non-empty selection in the focused
 *  file editor and attaches them to an agent chat input as context chips
 *  (Cursor's Ctrl+L / Copilot's "Add Selection to Chat"). Split in two so the
 *  user decides where the selection lands: the existing-chat command reuses the
 *  chat in front (asking first only when several are open), the new-chat command
 *  always opens a fresh one.
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
  IQuickInputService,
  IWorkspaceService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { AcpPromptContextInbox } from '../services/acp/session/acpPromptContextInbox.js'
import { AcpPromptTextInbox } from '../services/acp/session/acpPromptTextInbox.js'
import {
  collectActiveSelectionContexts,
  type SelectionContext,
} from '../services/acp/promptContext.js'
import { CATEGORY } from './_agentShared.js'
import {
  captureRevealServices,
  createChatTarget,
  resolveActiveOrNewSession,
  resolveExistingChatTarget,
  revealChat,
  type RevealServices,
} from './_agentChatTarget.js'

export class AddSelectionToExistingAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.addSelectionToExistingChat'
  constructor() {
    super({
      id: AddSelectionToExistingAgentChatAction.ID,
      title: localize2(
        'action.agent.addSelectionToExistingChat',
        'Add Selection to Existing Agent Chat',
      ),
      category: CATEGORY,
      precondition: 'editorTextFocus',
      keybinding: { primary: ['ctrl+k', 'ctrl+l'] },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const contexts = collectActiveSelectionContexts(
      accessor.get(IEditorService),
      accessor.get(IWorkspaceService),
    )
    if (contexts.length === 0) return
    // Resolve every service synchronously up front: the accessor is only valid
    // during run's synchronous scope, so nothing below the first await may touch it.
    const reveal = captureRevealServices(accessor)
    const quickInput = accessor.get(IQuickInputService)
    const target = await resolveExistingChatTarget(reveal, quickInput)
    if (!target) return
    await attachContexts(reveal, target.id, contexts)
  }
}

export class AddSelectionToNewAgentChatAction extends Action2 {
  static readonly ID = 'workbench.action.agent.addSelectionToNewChat'
  constructor() {
    super({
      id: AddSelectionToNewAgentChatAction.ID,
      title: localize2('action.agent.addSelectionToNewChat', 'Add Selection to New Agent Chat'),
      category: CATEGORY,
      precondition: 'editorTextFocus',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const contexts = collectActiveSelectionContexts(
      accessor.get(IEditorService),
      accessor.get(IWorkspaceService),
    )
    if (contexts.length === 0) return
    const reveal = captureRevealServices(accessor)
    const target = await createChatTarget(reveal)
    await attachContexts(reveal, target.id, contexts)
  }
}

// Deposit before revealing so a freshly-mounting PromptInput drains it, and an
// already-mounted one gets the onDidDeposit event — either way it lands.
async function attachContexts(
  reveal: RevealServices,
  sessionId: string,
  contexts: readonly SelectionContext[],
): Promise<void> {
  AcpPromptContextInbox.deposit(sessionId, contexts)
  await revealChat(reveal, sessionId)
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
    const target = await resolveActiveOrNewSession(reveal)

    // Deposit before revealing so a freshly-mounting PromptInput drains it, and an
    // already-mounted one gets the onDidDeposit event — either way it lands.
    AcpPromptTextInbox.deposit(target.id, text)
    await revealChat(reveal, target.id)
  }
}

export const agentContextActions: readonly (new () => Action2)[] = [
  AddSelectionToExistingAgentChatAction,
  AddSelectionToNewAgentChatAction,
  SendCommitToAgentChatAction,
]
