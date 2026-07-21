/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Rewind / Fork commands for an agent session, invoked from the hover actions on
 *  a user message (UserMessageItem passes { sessionId, messageId }):
 *   - Rewind (回退): truncate the conversation back to that user turn AND roll the
 *     agent-modified files back to their on-disk state at that point, then backfill
 *     the turn's text into the prompt input for edit-and-retry. Destructive, so it
 *     confirms first, previewing the file changes via a dry run.
 *   - Fork (分叉): create a NEW independent session seeded with only the history
 *     before that turn; the original session is left untouched.
 *
 *  Both are gated on the source session's capabilities (rewind → claude-code only,
 *  fork → the agent advertising sessionCapabilities.fork); the buttons already
 *  hide when unsupported, and the facade no-ops defensively.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IEditorService,
  IInstantiationService,
  INotificationService,
  IViewsService,
  ILayoutService,
  PartId,
  Severity,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  AcpForeignWorktreeError,
  IAcpSessionService,
  type RewindFilesResult,
} from '../services/acp/acpSessionService.js'
import { IAcpChatLocationService } from '../services/acp/acpChatLocationService.js'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'
import { AcpPromptReplaceInbox } from '../services/acp/acpPromptReplaceInbox.js'
import { CATEGORY } from './_agentShared.js'

interface RewindForkArg {
  readonly sessionId?: unknown
  readonly messageId?: unknown
}

function readArg(
  arg: RewindForkArg | undefined,
): { sessionId: string; messageId: string } | undefined {
  const sessionId = arg?.sessionId
  const messageId = arg?.messageId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined
  return { sessionId, messageId }
}

export class RewindAgentSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.rewindSession'
  constructor() {
    super({
      id: RewindAgentSessionAction.ID,
      title: localize2('action.agent.rewindSession', 'Rewind to Here'),
      category: CATEGORY,
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor, arg?: RewindForkArg): Promise<void> {
    const target = readArg(arg)
    if (target === undefined) return
    // Snapshot everything synchronously — the accessor dies past the first await.
    const sessions = accessor.get(IAcpSessionService)
    const dialog = accessor.get(IDialogService)
    const notification = accessor.get(INotificationService)

    const session = sessions.getById(target.sessionId)
    if (!session || !session.rewindSupported.get()) return
    // Capture the turn's text now, before the rewind clears the timeline, so we
    // can backfill it for edit-and-retry.
    const originalText = findMessageText(sessions, target.sessionId, target.messageId)

    let preview: RewindFilesResult | undefined
    try {
      preview = await sessions.rewindSession(target.sessionId, target.messageId, { dryRun: true })
    } catch (err) {
      notification.notify({
        severity: Severity.Error,
        message: localize('agent.rewind.previewFailed', 'Could not preview rewind: {error}', {
          error: (err as Error).message,
        }),
      })
      return
    }
    if (preview && preview.canRewind === false) {
      notification.notify({
        severity: Severity.Warning,
        message:
          preview.error ??
          localize('agent.rewind.cannot', 'This session cannot be rewound to that point.'),
      })
      return
    }

    const hasFileChanges = (preview?.filesChanged?.length ?? 0) > 0
    let keepFiles = false
    if (hasFileChanges) {
      // Three-button dialog: roll files back, keep them, or cancel. Mirrors the
      // Save / Don't Save / Cancel shape used by closeEditorWithConfirm.
      const result = await dialog.confirm({
        type: 'warning',
        message: localize('agent.rewind.confirm', 'Rewind the conversation to this message?'),
        detail: rewindDetail(preview),
        primaryButton: localize('agent.rewind.discard', 'Discard Changes & Rewind'),
        secondaryButton: localize('agent.rewind.keep', 'Keep Changes & Rewind'),
      })
      if (result.choice === 'cancel') return
      keepFiles = result.choice === 'secondary'
    } else {
      // No file changes to roll back — a plain confirm is enough.
      const result = await dialog.confirm({
        type: 'warning',
        message: localize('agent.rewind.confirm', 'Rewind the conversation to this message?'),
        detail: rewindDetail(preview),
        primaryButton: localize('agent.rewind.primary', 'Rewind'),
      })
      if (!result.confirmed) return
    }

    try {
      await sessions.rewindSession(
        target.sessionId,
        target.messageId,
        keepFiles ? { rewindFiles: false } : {},
      )
    } catch (err) {
      notification.notify({
        severity: Severity.Error,
        message: localize('agent.rewind.failed', 'Rewind failed: {error}', {
          error: (err as Error).message,
        }),
      })
      return
    }
    // Backfill the rewound turn so the user can tweak and resend it. PromptInput
    // drains this replace-inbox on its next render (it is already mounted for the
    // session the user just rewound).
    if (originalText !== undefined && originalText.length > 0) {
      AcpPromptReplaceInbox.deposit(target.sessionId, originalText)
    }
  }
}

export class ForkAgentSessionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.forkSession'
  constructor() {
    super({
      id: ForkAgentSessionAction.ID,
      title: localize2('action.agent.forkSession', 'Fork from Here'),
      category: CATEGORY,
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor, arg?: RewindForkArg): Promise<void> {
    const target = readArg(arg)
    if (target === undefined) return
    const sessions = accessor.get(IAcpSessionService)
    const notification = accessor.get(INotificationService)
    const location = accessor.get(IAcpChatLocationService)
    const editor = accessor.get(IEditorService)
    const inst = accessor.get(IInstantiationService)
    const layout = accessor.get(ILayoutService)
    const views = accessor.get(IViewsService)

    let forked
    try {
      forked = await sessions.forkSession(target.sessionId, target.messageId)
    } catch (err) {
      const message =
        err instanceof AcpForeignWorktreeError
          ? localize(
              'agent.fork.foreign',
              'Open the session in its own worktree before forking it.',
            )
          : localize('agent.fork.failed', 'Fork failed: {error}', { error: (err as Error).message })
      notification.notify({ severity: Severity.Error, message })
      return
    }

    if (location.location.get() === 'editor') {
      editor.openEditor(
        inst.createInstance(AcpSessionEditorInput, forked.id, forked.agentId, undefined),
      )
    } else {
      sessions.setActive(forked.id)
      if (!layout.getVisible(PartId.SecondarySideBar)) layout.toggleVisible(PartId.SecondarySideBar)
      await views.openViewContainer('workbench.view.agents')
    }
  }
}

function findMessageText(
  sessions: IAcpSessionService,
  sessionId: string,
  messageId: string,
): string | undefined {
  const session = sessions.getById(sessionId)
  if (!session) return undefined
  const message = session.messages.get().find((m) => m.messageId === messageId)
  return message?.text
}

function rewindDetail(preview: RewindFilesResult | undefined): string {
  const files = preview?.filesChanged?.length ?? 0
  const base = localize(
    'agent.rewind.detail.base',
    'The conversation after this message will be removed.',
  )
  if (files <= 0) {
    return `${base} ${localize('agent.rewind.detail.noFiles', 'No file changes will be rolled back.')}`
  }
  const insertions = preview?.insertions ?? 0
  const deletions = preview?.deletions ?? 0
  const fileSummary = localize(
    'agent.rewind.detail.files',
    '{files} file(s) will be rolled back (+{insertions} / -{deletions}).',
    { files, insertions, deletions },
  )
  return `${base} ${fileSummary}`
}
