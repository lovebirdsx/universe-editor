/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Rewind / Fork commands for an agent session.
 *
 *  Entry points:
 *   - per-message hover button and chat context menu ({sessionId, messageId}),
 *   - timeline-end Fork ({sessionId, fromTip:true}),
 *   - editor tab context menu ({groupId, editorId, resource}),
 *   - command palette / keybinding / local slash command (no anchor → message picker).
 *
 *  Rewind (回退): truncate the conversation back to that user turn AND roll the
 *  agent-modified files back to their on-disk state at that point, then backfill
 *  the turn's text into the prompt input for edit-and-retry. Destructive, so it
 *  confirms first, previewing the file changes via a dry run.
 *  Fork (分叉): create a NEW independent session seeded with only the history
 *  before that turn; the original session is left untouched. Without an anchor
 *  the picker leads with "from the end" (the whole conversation).
 *
 *  Both return whether the command actually completed. The local slash commands
 *  use that to restore the typed command when the picker was cancelled or the
 *  target cannot be acted on.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IEditorGroupsService,
  IEditorService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  MenuId,
  Severity,
  localize,
  localize2,
  type IKeyMods,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  AcpForeignWorktreeError,
  IAcpSessionService,
  type IAcpSession,
  type RewindFilesResult,
} from '../services/acp/session/acpSessionService.js'
import { AcpSessionEditorInput } from '../services/acp/session/acpSessionEditorInput.js'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { isSessionWorking } from '../services/acp/session/acpSessionStatus.js'
import { AcpPromptReplaceInbox } from '../services/acp/session/acpPromptReplaceInbox.js'
import { revealSessionChat } from '../services/acp/session/revealSessionChat.js'
import {
  ACP_CHAT_CARD_GROUP,
  ACP_EDITOR_ONLY_WHEN,
  ACP_SESSION_EDITOR_ACTIVE_WHEN,
  CATEGORY,
  resolveSessionTargetId,
} from './_agentShared.js'
import { createdSessionOpenServicesFrom, openCreatedSession } from './agentSessionActions.js'
import {
  invocationOpenTarget,
  resolveQuickPickOpenTarget,
  type OpenTarget,
} from '../services/editor/openTarget.js'
import { buildRewindPickItems, FORK_TIP_ITEM_ID } from './agentRewindPickItems.js'

interface RewindForkArg {
  readonly sessionId?: unknown
  readonly messageId?: unknown
  /** Editor-tab context menu argument; `resource.path` names the session. */
  readonly resource?: unknown
  /** Explicit "fork from the tip" — the timeline-end footer. */
  readonly fromTip?: unknown
}

function readMessageId(arg: RewindForkArg | undefined): string | undefined {
  const messageId = arg?.messageId
  return typeof messageId === 'string' && messageId.length > 0 ? messageId : undefined
}

function isFromTip(arg: RewindForkArg | undefined): boolean {
  return arg?.fromTip === true
}

export class RewindAgentSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.rewindSession'
  constructor() {
    super({
      id: RewindAgentSessionAction.ID,
      title: localize2('action.agent.rewindSession', 'Rewind Agent Session…'),
      category: CATEGORY,
      // 'discard' (Undo2) / 'checkout' (GitBranch) name git ops but are chosen
      // for their glyphs — the same ones the message card's hover buttons use.
      icon: 'discard',
      // The palette row is declared explicitly instead of via `f1`: a
      // precondition would also AND into the chat context menu and make
      // "Rewind to Here" silently disappear there.
      f1: false,
      menu: [
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 7,
          when: 'acpChatContextUserMessage && acpChatRewindSupported',
          title: localize2('action.agent.rewindSession.here', 'Rewind to Here'),
        },
        { id: MenuId.CommandPalette, when: ACP_SESSION_EDITOR_ACTIVE_WHEN },
        {
          id: MenuId.EditorTabContext,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: '1_session',
          order: 4,
        },
      ],
      keybinding: { primary: 'ctrl+alt+shift+z', when: ACP_EDITOR_ONLY_WHEN },
    })
  }

  override async run(accessor: ServicesAccessor, arg?: RewindForkArg): Promise<boolean> {
    // Snapshot everything synchronously — the accessor dies past the first await.
    const sessions = accessor.get(IAcpSessionService)
    const editor = accessor.get(IEditorService)
    const quickInput = accessor.get(IQuickInputService)
    const dialog = accessor.get(IDialogService)
    const notification = accessor.get(INotificationService)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)
    const widgets = accessor.get(IAcpChatWidgetService)

    const sessionId = resolveSessionTargetId(arg, editor, sessions)
    if (sessionId === undefined) {
      notifyInfo(notification, localize('agent.rewind.noSession', 'Open an agent session first.'))
      return false
    }
    const session = sessions.getById(sessionId)
    if (session === undefined) {
      notifyInfo(
        notification,
        localize('agent.rewind.notLive', 'Open the session before rewinding it.'),
      )
      return false
    }
    if (session.readOnly) {
      notifyInfo(
        notification,
        localize(
          'agent.rewind.readOnly',
          'This session is read-only. Open it in its own workspace first.',
        ),
      )
      return false
    }
    if (!session.rewindSupported.get()) {
      notifyInfo(
        notification,
        localize('agent.rewind.unsupported', 'This agent does not support rewinding.'),
      )
      return false
    }

    let messageId = readMessageId(arg)
    if (messageId === undefined) {
      const items = buildRewindPickItems(session.messages.get(), 'rewind')
      if (items.length === 0) {
        notifyInfo(
          notification,
          localize('agent.rewind.noMessages', 'There are no messages to rewind to yet.'),
        )
        return false
      }
      const lastId = items[items.length - 1]?.id
      const picked = await quickInput.pick(items, {
        placeholder: localize('agent.rewind.picker.placeholder', 'Select a message to rewind to'),
        ...(lastId !== undefined ? { activeItemId: lastId } : {}),
      })
      if (picked === undefined || picked.messageId === undefined) return false
      messageId = picked.messageId
    }
    return runRewindFlow(
      { sessions, dialog, notification, groups, inst, widgets },
      session,
      messageId,
    )
  }
}

export class ForkAgentSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.forkSession'
  constructor() {
    super({
      id: ForkAgentSessionAction.ID,
      title: localize2('action.agent.forkSession', 'Fork Agent Session…'),
      category: CATEGORY,
      icon: 'checkout',
      menu: [
        // `acpChatForkSupported` is set by the menu host at open time (it also
        // gates "New Side Task"); a user-message card is what "from here"
        // needs, so both keys are required.
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 8,
          when: 'acpChatContextUserMessage && acpChatForkSupported',
          title: localize2('action.agent.forkSession.here', 'Fork from Here'),
        },
        {
          id: MenuId.EditorTabContext,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: '1_session',
          order: 5,
        },
      ],
      f1: true,
      keybinding: { primary: 'ctrl+alt+shift+f', when: ACP_EDITOR_ONLY_WHEN },
    })
  }

  override async run(accessor: ServicesAccessor, arg?: RewindForkArg): Promise<boolean> {
    const sessions = accessor.get(IAcpSessionService)
    const editor = accessor.get(IEditorService)
    const quickInput = accessor.get(IQuickInputService)
    const notification = accessor.get(INotificationService)
    const open = createdSessionOpenServicesFrom(accessor)
    const invocationTarget = invocationOpenTarget()

    const sessionId = resolveSessionTargetId(arg, editor, sessions)
    if (sessionId === undefined) {
      notification.notify({
        severity: Severity.Warning,
        message: localize(
          'agent.fork.unsupported',
          'The active session cannot be forked (no session, or the agent does not support it).',
        ),
      })
      return false
    }

    const live = sessions.getById(sessionId)
    if (live?.readOnly) {
      notification.notify({
        severity: Severity.Warning,
        message: localize(
          'agent.fork.foreign',
          'Open the session in its own worktree before forking it.',
        ),
      })
      return false
    }
    if (live !== undefined) {
      if (!live.forkSupported.get()) {
        notification.notify({
          severity: Severity.Warning,
          message: localize(
            'agent.fork.sessionUnsupported',
            'This agent does not support forking sessions.',
          ),
        })
        return false
      }
      // Same "still working" story the footer that offers this fork gates on: a
      // `run_in_background` task outliving the settled turn still counts. On the
      // core status alone the guard would open the moment the prompt RPC returns,
      // forking a tip the background task is still appending to.
      if (isSessionWorking(live)) {
        notification.notify({
          severity: Severity.Warning,
          message: localize(
            'agent.fork.running',
            'Wait for the current work to finish before forking.',
          ),
        })
        return false
      }
    }

    let messageId = readMessageId(arg)
    let fromTip = isFromTip(arg)
    let pickTarget: OpenTarget | undefined
    if (messageId === undefined && !fromTip) {
      if (live === undefined) {
        // History-only rows (session list) have no local message list to pick
        // from; forkSession can still fork the durable history from its tip.
        fromTip = true
      } else {
        // Mutable out-param: the picker writes the modifier state at acceptance.
        const keyMods: IKeyMods = { ctrl: false, alt: false }
        const items = buildRewindPickItems(live.messages.get(), 'fork')
        const picked = await quickInput.pick(items, {
          placeholder: localize('agent.fork.picker.placeholder', 'Select where to fork from'),
          activeItemId: FORK_TIP_ITEM_ID,
          keyMods,
        })
        if (picked === undefined) return false
        if (picked.fromTip === true) {
          fromTip = true
        } else {
          messageId = picked.messageId
          if (messageId === undefined) return false
        }
        pickTarget = resolveQuickPickOpenTarget(keyMods)
      }
    }

    let forked: IAcpSession
    try {
      forked = await sessions.forkSession(sessionId, messageId)
    } catch (err) {
      const message =
        err instanceof AcpForeignWorktreeError
          ? localize(
              'agent.fork.foreign',
              'Open the session in its own worktree before forking it.',
            )
          : isForkUnsupportedError(err)
            ? localize(
                'agent.fork.sessionUnsupported',
                'This agent does not support forking sessions.',
              )
            : localize('agent.fork.failed', 'Fork failed: {error}', {
                error: (err as Error).message,
              })
      notification.notify({ severity: Severity.Error, message })
      return false
    }

    await openCreatedSession(open, forked, pickTarget ?? invocationTarget)
    return true
  }
}

interface RewindFlowServices {
  readonly sessions: IAcpSessionService
  readonly dialog: IDialogService
  readonly notification: INotificationService
  readonly groups: IEditorGroupsService
  readonly inst: IInstantiationService
  readonly widgets: IAcpChatWidgetService
}

/**
 * Preview, confirm and execute a rewind, then deposit the rewound turn into the
 * session's prompt input. Returns true only when the conversation was actually
 * rewound — a cancelled picker / dialog or an agent that cannot answer is false,
 * so the slash command keeps the typed text.
 */
async function runRewindFlow(
  services: RewindFlowServices,
  session: IAcpSession,
  messageId: string,
): Promise<boolean> {
  // Capture the turn's text now, before the rewind clears the timeline, so we
  // can backfill it for edit-and-retry.
  const originalMessage = session.messages.get().find((message) => message.messageId === messageId)

  let preview: RewindFilesResult | undefined
  try {
    preview = await services.sessions.rewindSession(session.id, messageId, { dryRun: true })
  } catch (err) {
    services.notification.notify({
      severity: Severity.Error,
      message: localize('agent.rewind.previewFailed', 'Could not preview rewind: {error}', {
        error: (err as Error).message,
      }),
    })
    return false
  }
  // The facade returns undefined when the session vanished / is read-only. The
  // old flow treated that as "no file changes" and confirmed anyway — a rewind
  // that never happened looked successful.
  if (preview === undefined) {
    services.notification.notify({
      severity: Severity.Warning,
      message: localize('agent.rewind.unavailable', 'Rewind failed: the session is not available.'),
    })
    return false
  }
  if (preview.canRewind === false) {
    services.notification.notify({
      severity: Severity.Warning,
      message:
        preview.error ??
        localize('agent.rewind.cannot', 'This session cannot be rewound to that point.'),
    })
    return false
  }

  const hasFileChanges = (preview.filesChanged?.length ?? 0) > 0
  let keepFiles = false
  if (hasFileChanges) {
    // Three-button dialog: roll files back, keep them, or cancel. Mirrors the
    // Save / Don't Save / Cancel shape used by closeEditorWithConfirm.
    const result = await services.dialog.confirm({
      type: 'warning',
      message: localize('agent.rewind.confirm', 'Rewind the conversation to this message?'),
      detail: rewindDetail(preview),
      primaryButton: localize('agent.rewind.discard', 'Discard Changes & Rewind'),
      secondaryButton: localize('agent.rewind.keep', 'Keep Changes & Rewind'),
    })
    if (result.choice === 'cancel') return false
    keepFiles = result.choice === 'secondary'
  } else {
    // No file changes to roll back — a plain confirm is enough.
    const result = await services.dialog.confirm({
      type: 'warning',
      message: localize('agent.rewind.confirm', 'Rewind the conversation to this message?'),
      detail: rewindDetail(preview),
      primaryButton: localize('agent.rewind.primary', 'Rewind'),
    })
    if (!result.confirmed) return false
  }

  let applied: RewindFilesResult | undefined
  try {
    applied = await services.sessions.rewindSession(
      session.id,
      messageId,
      keepFiles ? { rewindFiles: false } : {},
    )
  } catch (err) {
    services.notification.notify({
      severity: Severity.Error,
      message: localize('agent.rewind.failed', 'Rewind failed: {error}', {
        error: (err as Error).message,
      }),
    })
    return false
  }
  if (applied === undefined) {
    services.notification.notify({
      severity: Severity.Warning,
      message: localize('agent.rewind.unavailable', 'Rewind failed: the session is not available.'),
    })
    return false
  }

  // Backfill the rewound turn so the user can tweak and resend it. PromptInput
  // drains this replace-inbox by the LOCAL session id (it may not be mounted
  // yet when the command was invoked from the session list / tab menu), so
  // deposit before revealing the chat.
  if (originalMessage !== undefined && originalMessage.text.length > 0) {
    AcpPromptReplaceInbox.deposit(session.id, {
      text: originalMessage.text,
      contexts: originalMessage.selectionContexts ?? [],
    })
  }
  revealSessionChat(
    { groups: services.groups, inst: services.inst, widgets: services.widgets },
    session.id,
    { agentId: session.agentId },
  )
  return true
}

function notifyInfo(notification: INotificationService, message: string): void {
  notification.notify({ severity: Severity.Info, message })
}

function isForkUnsupportedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('sessionCapabilities.fork')
}

function rewindDetail(preview: RewindFilesResult): string {
  const files = preview.filesChanged?.length ?? 0
  const base = localize(
    'agent.rewind.detail.base',
    'The conversation after this message will be removed.',
  )
  if (files <= 0) {
    return `${base} ${localize('agent.rewind.detail.noFiles', 'No file changes will be rolled back.')}`
  }
  const insertions = preview.insertions ?? 0
  const deletions = preview.deletions ?? 0
  const fileSummary = localize(
    'agent.rewind.detail.files',
    '{files} file(s) will be rolled back (+{insertions} / -{deletions}).',
    { files, insertions, deletions },
  )
  return `${base} ${fileSummary}`
}
