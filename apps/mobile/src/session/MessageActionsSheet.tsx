import { useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { commandErrorText, strings } from '../strings.js'

export interface MessageActionsSheetProps {
  readonly canCopyText: boolean
  readonly canCopyImage: boolean
  readonly canRewind: boolean
  readonly canFork: boolean
  readonly canCreateSideTask: boolean
  readonly online: boolean
  readonly running: boolean
  readonly onCopyText: () => Promise<void> | void
  readonly onCopyImage: () => Promise<void> | void
  readonly onRewind: () => void
  readonly onFork: () => Promise<void> | void
  readonly onSideTask: () => Promise<void> | void
  readonly onClose: () => void
  readonly onNotice: (text: string) => void
}

type MessageActionKind = 'copy-text' | 'copy-image' | 'fork' | 'side-task'

export function MessageActionsSheet({
  canCopyText,
  canCopyImage,
  canRewind,
  canFork,
  canCreateSideTask,
  online,
  running,
  onCopyText,
  onCopyImage,
  onRewind,
  onFork,
  onSideTask,
  onClose,
  onNotice,
}: MessageActionsSheetProps) {
  const [busy, setBusy] = useState<MessageActionKind | undefined>(undefined)

  const run = async (kind: MessageActionKind, action: () => Promise<void> | void) => {
    if (busy !== undefined) return
    setBusy(kind)
    try {
      await action()
    } catch (error) {
      onNotice(commandErrorText(errorCode(error)))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <BottomSheet
      title={strings.messageActionsTitle}
      testId="message-actions-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
      expandKey="message-actions"
    >
      <div className="sheet-options">
        {canCopyText && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="message-action-copy-text"
            disabled={busy !== undefined}
            onClick={() => void run('copy-text', onCopyText)}
          >
            {busy === 'copy-text' ? strings.messageCopyTextBusy : strings.messageActionCopyText}
          </button>
        )}
        {canCopyImage && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="message-action-copy-image"
            disabled={busy !== undefined}
            onClick={() => void run('copy-image', onCopyImage)}
          >
            {busy === 'copy-image' ? strings.messageCopyImageBusy : strings.messageActionCopyImage}
          </button>
        )}
        {canRewind && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="message-action-rewind"
            disabled={!online || busy !== undefined}
            onClick={onRewind}
          >
            {strings.messageActionRewind}
          </button>
        )}
        {canFork && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="message-action-fork"
            disabled={!online || running || busy !== undefined}
            title={running ? strings.forkBusy : undefined}
            onClick={() => void run('fork', onFork)}
          >
            {busy === 'fork' ? strings.pendingSubmitting : strings.messageActionFork}
          </button>
        )}
        {canCreateSideTask && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="message-action-side-task"
            disabled={!online || busy !== undefined}
            onClick={() => void run('side-task', onSideTask)}
          >
            {busy === 'side-task' ? strings.pendingSubmitting : strings.messageActionSideTask}
          </button>
        )}
        <button type="button" className="sheet-option sheet-option--cancel" onClick={onClose}>
          {strings.pendingCancel}
        </button>
      </div>
    </BottomSheet>
  )
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}
