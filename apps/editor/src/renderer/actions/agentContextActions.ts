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
  IWorkspaceService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { AcpPromptContextInbox } from '../services/acp/session/acpPromptContextInbox.js'
import { AcpPromptTextInbox } from '../services/acp/session/acpPromptTextInbox.js'
import { collectActiveSelectionContexts } from '../services/acp/promptContext.js'
import { CATEGORY } from './_agentShared.js'
import { captureRevealServices, resolveTargetSession, revealChat } from './_agentChatTarget.js'

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
    const contexts = collectActiveSelectionContexts(
      accessor.get(IEditorService),
      accessor.get(IWorkspaceService),
    )
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

export const agentContextActions: readonly (new () => Action2)[] = [
  AddSelectionToAgentChatAction,
  SendCommitToAgentChatAction,
]
