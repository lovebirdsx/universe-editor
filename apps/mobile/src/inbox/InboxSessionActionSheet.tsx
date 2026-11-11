import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { ConfirmActionSheet } from '../components/ConfirmActionSheet.js'
import type { MobileClient } from '../state/mobileClient.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'
import { isSessionWorking } from '../session/sessionStatus.js'
import {
  isSessionRemoveConfirmEnabled,
  setSessionCloseConfirmEnabled,
  setSessionRemoveConfirmEnabled,
  shouldConfirmSessionClose,
} from '../session/sessionConfirm.js'

export type InboxSessionSheetView = 'menu' | 'close' | 'remove'

export interface InboxSessionActionSheetProps {
  readonly client: Pick<MobileClient, 'closeSession' | 'deleteSession'>
  readonly session: MobileSessionSummary
  readonly initialView: InboxSessionSheetView
  readonly online: boolean
  readonly onDismiss: () => void
  readonly onNotice: (text: string) => void
}

/** Long-press menu and swipe-action confirmations for one inbox row. */
export function InboxSessionActionSheet({
  client,
  session,
  initialView,
  online,
  onDismiss,
  onNotice,
}: InboxSessionActionSheetProps) {
  const [view, setView] = useState<InboxSessionSheetView>(initialView)
  const [busy, setBusy] = useState(false)

  const run = (request: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    void request()
      .then(() => {
        setBusy(false)
        onDismiss()
      })
      .catch((error: unknown) => {
        setBusy(false)
        onNotice(commandErrorText(errorCode(error)))
      })
  }

  const doClose = (): void => {
    run(() => client.closeSession(session.ref))
  }

  const doRemove = (): void => {
    run(() => client.deleteSession(session.ref))
  }

  const requestClose = (): void => {
    if (shouldConfirmSessionClose(isSessionWorking(session))) {
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

  if (view === 'close') {
    return (
      <ConfirmActionSheet
        title={strings.sessionCloseTitle}
        body={strings.sessionCloseBody}
        confirmLabel={strings.sessionCloseConfirm}
        testId="inbox-session-close-sheet"
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
        testId="inbox-session-remove-sheet"
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
      title={session.title}
      testId="inbox-session-sheet"
      tone="neutral"
      overlay
      onDismiss={busy ? undefined : onDismiss}
      expandKey="inbox-session-menu"
    >
      <div className="sheet-options">
        <button
          type="button"
          className="sheet-option sheet-option--neutral"
          data-testid="inbox-session-close"
          disabled={!online || busy}
          onClick={requestClose}
        >
          {strings.sessionClose}
        </button>
        <button
          type="button"
          className="sheet-option sheet-option--danger"
          data-testid="inbox-session-remove"
          disabled={!online || busy}
          onClick={requestRemove}
        >
          {strings.sessionRemove}
        </button>
        <button
          type="button"
          className="sheet-option sheet-option--cancel"
          data-testid="inbox-session-cancel"
          disabled={busy}
          onClick={onDismiss}
        >
          {strings.pendingCancel}
        </button>
      </div>
    </BottomSheet>
  )
}
