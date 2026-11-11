import { useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { ConfirmActionSheet } from '../components/ConfirmActionSheet.js'
import { FullscreenButton } from '../components/FullscreenButton.js'
import type { MobileClient } from '../state/mobileClient.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'
import {
  isSessionRemoveConfirmEnabled,
  setSessionCloseConfirmEnabled,
  setSessionRemoveConfirmEnabled,
  shouldConfirmSessionClose,
} from './sessionConfirm.js'

const MAX_TITLE_LENGTH = 512

export interface SessionMenuSheetProps {
  readonly client: Pick<MobileClient, 'renameSession' | 'closeSession' | 'deleteSession'>
  readonly title: string
  readonly online: boolean
  readonly forkSupported?: boolean | undefined
  readonly readOnly: boolean
  readonly running?: boolean | undefined
  /** True while a turn/ask/background task is live: closing can lose work. */
  readonly closeNeedsConfirm: boolean
  readonly sideTaskChildCount?: number | undefined
  readonly onForkTip?: (() => Promise<void> | void) | undefined
  readonly onNewSideTask?: (() => Promise<void> | void) | undefined
  readonly onOpenSideTasks?: (() => void) | undefined
  /** Opens the branch-publishing sheet; absent hides the entry. */
  readonly onPushBranch?: (() => void) | undefined
  readonly onClose: () => void
  readonly onNotice: (text: string) => void
  readonly onFinished: () => void
}

type View = 'menu' | 'rename' | 'close' | 'remove'

export function SessionMenuSheet({
  client,
  title,
  online,
  forkSupported,
  readOnly,
  running,
  closeNeedsConfirm,
  sideTaskChildCount,
  onForkTip,
  onNewSideTask,
  onOpenSideTasks,
  onPushBranch,
  onClose,
  onNotice,
  onFinished,
}: SessionMenuSheetProps) {
  const [view, setView] = useState<View>('menu')
  const [draft, setDraft] = useState(title)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void> | void, onSuccess: () => void): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await action()
      setBusy(false)
      onSuccess()
    } catch (err) {
      setBusy(false)
      onNotice(commandErrorText(errorCode(err)))
    }
  }

  const doClose = (): void => {
    void run(
      () => client.closeSession(),
      () => onFinished(),
    )
  }

  const doRemove = (): void => {
    void run(
      () => client.deleteSession(),
      () => onFinished(),
    )
  }

  const requestClose = (): void => {
    if (shouldConfirmSessionClose(closeNeedsConfirm)) {
      setView('close')
      return
    }
    doClose()
  }

  const requestRemove = (): void => {
    if (isSessionRemoveConfirmEnabled()) {
      setView('remove')
      return
    }
    doRemove()
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
      void run(
        () => client.renameSession(next),
        () => onClose(),
      )
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

  if (view === 'close') {
    return (
      <ConfirmActionSheet
        title={strings.sessionCloseTitle}
        body={strings.sessionCloseBody}
        confirmLabel={strings.sessionCloseConfirm}
        testId="session-close-sheet"
        busy={busy}
        disabled={!online}
        neverAskAgainLabel={strings.sessionNeverAskAgain}
        onConfirm={(neverAskAgain) => {
          if (neverAskAgain) setSessionCloseConfirmEnabled(false)
          doClose()
        }}
        onCancel={() => {
          if (!busy) setView('menu')
        }}
      />
    )
  }

  if (view === 'remove') {
    return (
      <ConfirmActionSheet
        title={strings.sessionRemoveTitle}
        body={strings.sessionRemoveBody}
        confirmLabel={strings.sessionRemoveConfirm}
        testId="session-remove-sheet"
        tone="danger"
        busy={busy}
        disabled={!online}
        neverAskAgainLabel={strings.sessionNeverAskAgain}
        onConfirm={(neverAskAgain) => {
          if (neverAskAgain) setSessionRemoveConfirmEnabled(false)
          doRemove()
        }}
        onCancel={() => {
          if (!busy) setView('menu')
        }}
      />
    )
  }

  return (
    <BottomSheet
      title={title}
      testId="session-menu-sheet"
      tone="neutral"
      overlay
      onDismiss={busy ? undefined : onClose}
      expandKey="menu"
    >
      <div className="sheet-options">
        <FullscreenButton
          className="sheet-option sheet-option--neutral"
          testId="session-fullscreen"
          onToggled={onClose}
        />
        {!readOnly && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="session-rename"
            disabled={!online || busy}
            onClick={() => setView('rename')}
          >
            {strings.sessionRename}
          </button>
        )}
        {forkSupported === true && readOnly !== true && onForkTip !== undefined && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="session-fork-tip"
            disabled={!online || running === true || busy}
            title={running === true ? strings.forkBusy : undefined}
            onClick={() => void run(onForkTip, onClose)}
          >
            {strings.sessionForkTip}
          </button>
        )}
        {forkSupported === true && readOnly !== true && onNewSideTask !== undefined && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="session-new-side-task"
            disabled={!online || busy}
            onClick={() => void run(onNewSideTask, onClose)}
          >
            {busy ? strings.pendingSubmitting : strings.sideTasksNew}
          </button>
        )}
        {sideTaskChildCount !== undefined &&
          sideTaskChildCount > 0 &&
          onOpenSideTasks !== undefined && (
            <button
              type="button"
              className="sheet-option sheet-option--neutral"
              data-testid="session-side-tasks"
              disabled={!online}
              onClick={onOpenSideTasks}
            >
              {`${strings.sideTasksMenu} (${sideTaskChildCount})`}
            </button>
          )}
        {!readOnly && onPushBranch !== undefined && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="session-push-branch"
            disabled={!online || busy}
            onClick={onPushBranch}
          >
            {strings.pushBranchAction}
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            className="sheet-option sheet-option--neutral"
            data-testid="session-close"
            disabled={!online || busy}
            onClick={requestClose}
          >
            {strings.sessionClose}
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            className="sheet-option sheet-option--danger"
            data-testid="session-remove"
            disabled={!online || busy}
            onClick={requestRemove}
          >
            {strings.sessionRemove}
          </button>
        )}
        <button
          type="button"
          className="sheet-option sheet-option--cancel"
          data-testid="session-menu-cancel"
          onClick={onClose}
        >
          {strings.pendingCancel}
        </button>
      </div>
    </BottomSheet>
  )
}
