import { BottomSheet } from './BottomSheet.js'
import { strings } from '../strings.js'

export interface ConfirmActionSheetProps {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly testId: string
  readonly tone?: 'danger' | 'neutral' | undefined
  readonly busy: boolean
  readonly disabled?: boolean | undefined
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/** Destructive / interrupting confirmation rendered in the shared bottom sheet. */
export function ConfirmActionSheet({
  title,
  body,
  confirmLabel,
  testId,
  tone = 'neutral',
  busy,
  disabled = false,
  onConfirm,
  onCancel,
}: ConfirmActionSheetProps) {
  return (
    <BottomSheet title={title} testId={testId} overlay onDismiss={busy ? undefined : onCancel}>
      <p className="sheet__request">{body}</p>
      <div className="sheet-options">
        <button
          type="button"
          className={`sheet-option ${
            tone === 'danger' ? 'sheet-option--danger' : 'sheet-option--reject'
          }`}
          data-testid={`${testId}-confirm`}
          disabled={busy || disabled}
          onClick={onConfirm}
        >
          {busy ? strings.pendingSubmitting : confirmLabel}
        </button>
        <button
          type="button"
          className="sheet-option sheet-option--cancel"
          data-testid={`${testId}-cancel`}
          disabled={busy}
          onClick={onCancel}
        >
          {strings.pendingCancel}
        </button>
      </div>
    </BottomSheet>
  )
}
