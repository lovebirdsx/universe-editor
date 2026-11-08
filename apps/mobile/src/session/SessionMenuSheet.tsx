import { useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import type { MobileClient } from '../state/mobileClient.js'
import { commandErrorText, strings } from '../strings.js'

const MAX_TITLE_LENGTH = 512

export interface SessionMenuSheetProps {
  readonly client: Pick<MobileClient, 'renameSession' | 'deleteSession'>
  readonly title: string
  readonly online: boolean
  readonly onClose: () => void
  readonly onNotice: (text: string) => void
}

type View = 'menu' | 'rename' | 'delete'

export function SessionMenuSheet({
  client,
  title,
  online,
  onClose,
  onNotice,
}: SessionMenuSheetProps) {
  const [view, setView] = useState<View>('menu')
  const [draft, setDraft] = useState(title)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await action()
      setBusy(false)
      onClose()
    } catch (err) {
      setBusy(false)
      onNotice(commandErrorText(errorCode(err)))
    }
  }

  if (view === 'rename') {
    const submit = (): void => {
      const next = draft.trim()
      if (next === '') {
        setError(strings.sessionRenameEmpty)
        return
      }
      if (next.length > MAX_TITLE_LENGTH) {
        setError(strings.sessionRenameTooLong)
        return
      }
      void run(() => client.renameSession(next))
    }
    return (
      <BottomSheet
        title={strings.sessionRenameTitle}
        testId="session-rename-sheet"
        tone="neutral"
        overlay
        onDismiss={onClose}
        expandKey="rename"
      >
        <label className="sheet__field-label" htmlFor="session-rename-input">
          {strings.sessionRenamePlaceholder}
        </label>
        <input
          id="session-rename-input"
          className="sheet__input"
          data-testid="session-rename-input"
          type="text"
          maxLength={MAX_TITLE_LENGTH}
          value={draft}
          disabled={!online || busy}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(undefined)
          }}
        />
        {error !== undefined && <p className="sheet-field__error">{error}</p>}
        <div className="sheet-options">
          <button
            type="button"
            className="sheet-option sheet-option--allow"
            data-testid="session-rename-confirm"
            disabled={!online || busy}
            onClick={submit}
          >
            {busy ? strings.pendingSubmitting : strings.sessionRenameConfirm}
          </button>
          <button
            type="button"
            className="sheet-option sheet-option--cancel"
            disabled={busy}
            onClick={() => setView('menu')}
          >
            {strings.pendingCancel}
          </button>
        </div>
      </BottomSheet>
    )
  }

  if (view === 'delete') {
    return (
      <BottomSheet
        title={strings.sessionDeleteTitle}
        testId="session-delete-sheet"
        overlay
        onDismiss={onClose}
        expandKey="delete"
      >
        <p className="sheet__request">{strings.sessionDeleteBody}</p>
        <div className="sheet-options">
          <button
            type="button"
            className="sheet-option sheet-option--danger"
            data-testid="session-delete-confirm"
            disabled={!online || busy}
            onClick={() => void run(() => client.deleteSession())}
          >
            {busy ? strings.pendingSubmitting : strings.sessionDeleteConfirm}
          </button>
          <button
            type="button"
            className="sheet-option sheet-option--cancel"
            disabled={busy}
            onClick={() => setView('menu')}
          >
            {strings.sessionDeleteCancel}
          </button>
        </div>
      </BottomSheet>
    )
  }

  return (
    <BottomSheet
      title={title}
      testId="session-menu-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
      expandKey="menu"
    >
      <div className="sheet-options">
        <button
          type="button"
          className="sheet-option sheet-option--neutral"
          data-testid="session-rename"
          disabled={!online}
          onClick={() => setView('rename')}
        >
          {strings.sessionRename}
        </button>
        <button
          type="button"
          className="sheet-option sheet-option--danger"
          data-testid="session-delete"
          disabled={!online}
          onClick={() => setView('delete')}
        >
          {strings.sessionDelete}
        </button>
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
