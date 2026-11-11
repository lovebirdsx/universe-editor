import { useState } from 'react'
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
  readonly neverAskAgainLabel?: string | undefined
  readonly onConfirm: (neverAskAgain: boolean) => void
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
  neverAskAgainLabel,
  onConfirm,
  onCancel,
}: ConfirmActionSheetProps) {
  const [neverAskAgain, setNeverAskAgain] = useState(false)

  return (
    <BottomSheet title={title} testId={testId} overlay onDismiss={busy ? undefined : onCancel}>
      <p className="sheet__request">{body}</p>
      {neverAskAgainLabel !== undefined && (
        <label className="sheet-checkbox">
          <input
            type="checkbox"
            checked={neverAskAgain}
            disabled={busy}
            data-testid={`${testId}-never-ask`}
            onChange={(event) => setNeverAskAgain(event.currentTarget.checked)}
          />
          <span>{neverAskAgainLabel}</span>
        </label>
      )}
      <div className="sheet-options">
        <button
          type="button"
          className={`sheet-option ${
            tone === 'danger' ? 'sheet-option--danger' : 'sheet-option--reject'
          }`}
          data-testid={`${testId}-confirm`}
          disabled={busy || disabled}
          onClick={() => onConfirm(neverAskAgain)}
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
