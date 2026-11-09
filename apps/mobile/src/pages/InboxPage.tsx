import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import type { StoredCredentials } from '../credentials.js'
import { InboxGroups } from '../inbox/InboxGroups.js'
import { selectInboxSessions } from '../inbox/groupSessions.js'
import {
  InboxSessionActionSheet,
  type InboxSessionSheetView,
} from '../inbox/InboxSessionActionSheet.js'
import type { MobileClient } from '../state/mobileClient.js'
import { refMatches } from '../state/refs.js'
import { useStore } from '../state/useStore.js'
import { NoticeBar } from '../components/NoticeBar.js'
import { Spinner } from '../components/Spinner.js'
import { ConnectionDiagnostic } from '../components/ConnectionDiagnostic.js'
import { SettingsDrawer } from '../components/SettingsDrawer.js'
import { StatusBar } from '../components/StatusBar.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'
import { isSessionWorking } from '../session/sessionStatus.js'
import { useState } from 'react'

export interface InboxPageProps {
  readonly client: MobileClient
  readonly credentials: StoredCredentials
  readonly notice?: string | undefined
  readonly onDismissNotice: () => void
  readonly onNotice: (text: string) => void
  readonly onOpenSession: (sessionKey: string, focusPending: boolean) => void
  readonly onOpenSessions: () => void
  readonly onNewSession: () => void
  readonly onUnpair: () => void
}

export function InboxPage({
  client,
  credentials,
  notice,
  onDismissNotice,
  onNotice,
  onOpenSession,
  onOpenSessions,
  onNewSession,
  onUnpair,
}: InboxPageProps) {
  const inbox = useStore(client.getInboxStore())
  const socketState = useStore(client.getSocketStateStore())
  const diagnosis = useStore(client.getConnectionDiagnosisStore())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionAction, setSessionAction] = useState<
    { readonly session: MobileSessionSummary; readonly view: InboxSessionSheetView } | undefined
  >(undefined)
  // The sheet stays open while the inbox keeps moving; judge "is it working?"
  // against the latest summary, not the one captured on long-press.
  const actionSession =
    sessionAction === undefined
      ? undefined
      : (inbox.sessions.find((session) => refMatches(session.ref, sessionAction.session.ref)) ??
        sessionAction.session)

  const unpair = (): void => {
    setSettingsOpen(false)
    onDismissNotice()
    onUnpair()
  }

  const closeSession = (session: MobileSessionSummary): void => {
    if (isSessionWorking(session)) {
      setSessionAction({ session, view: 'close' })
      return
    }
    void client
      .closeSession(session.ref)
      .then(() => onNotice(strings.sessionCloseNotice))
      .catch((error: unknown) => onNotice(commandErrorText(errorCode(error))))
  }

  const removeSession = (session: MobileSessionSummary): void => {
    setSessionAction({ session, view: 'remove' })
  }

  const completedSessionAction = (action: 'closed' | 'removed'): void => {
    onNotice(action === 'closed' ? strings.sessionCloseNotice : strings.sessionRemovedNotice)
  }

  return (
    <div className="inbox-page">
      <StatusBar
        pcName={credentials.pcName}
        state={socketState}
        onOpenSessions={onOpenSessions}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="inbox-page__body">
        {notice !== undefined && <NoticeBar text={notice} onDismiss={onDismissNotice} />}
        {inbox.hasSnapshot && socketState !== 'connected' && (
          <div className="offline-banner" role="status">
            <span className="offline-banner__dot" aria-hidden="true" />
            <span>{strings.inboxOfflineBanner}</span>
          </div>
        )}
        <ConnectionDiagnostic
          diagnosis={diagnosis}
          onRetryConnection={() => client.retryConnection()}
          onRecheck={() => client.retryDiagnosis()}
        />
        {renderBody()}
      </main>
      <button
        type="button"
        className="fab"
        data-testid="new-session-fab"
        aria-label={strings.newSessionAdd}
        disabled={socketState !== 'connected'}
        onClick={onNewSession}
      >
        +
      </button>
      {settingsOpen && (
        <SettingsDrawer
          client={client}
          credentials={credentials}
          onClose={() => setSettingsOpen(false)}
          onUnpair={unpair}
        />
      )}
      {sessionAction !== undefined && actionSession !== undefined && (
        <InboxSessionActionSheet
          key={`${actionSession.ref.localId}:${sessionAction.view}`}
          client={client}
          session={actionSession}
          initialView={sessionAction.view}
          online={socketState === 'connected'}
          onDismiss={() => setSessionAction(undefined)}
          onNotice={onNotice}
          onCompleted={completedSessionAction}
        />
      )}
    </div>
  )

  function renderBody() {
    if (socketState === 'protocol_mismatch') {
      return (
        <div className="state-card">
          <p>{strings.inboxVersionMismatch}</p>
          <button
            type="button"
            className="button button--primary"
            onClick={() => window.location.reload()}
          >
            {strings.inboxRefresh}
          </button>
        </div>
      )
    }

    if (inbox.hasSnapshot) {
      const sessions = selectInboxSessions(inbox.sessions)
      if (sessions.length === 0) {
        return (
          <div className="state-card">
            <p>{strings.inboxEmpty}</p>
          </div>
        )
      }
      return (
        <InboxGroups
          sessions={sessions}
          onOpenSession={onOpenSession}
          onCloseSession={closeSession}
          onRemoveSession={removeSession}
          onShowSessionActions={(session) => setSessionAction({ session, view: 'menu' })}
          stale={socketState !== 'connected'}
        />
      )
    }

    if (socketState === 'reconnecting') {
      // The diagnostic card above already explains the failure; a second
      // "reconnecting" card would just repeat it.
      if (diagnosis !== undefined) return null
      return (
        <div className="state-card state-card--row">
          <Spinner label={strings.statusReconnecting} />
          <p>{strings.inboxReconnecting}</p>
        </div>
      )
    }

    if (socketState === 'connected') {
      return (
        <div className="state-card state-card--row">
          <Spinner label={strings.statusConnected} />
          <p>{strings.inboxWaitingSnapshot}</p>
        </div>
      )
    }

    return (
      <div className="state-card state-card--row">
        <Spinner />
        <p>{strings.inboxLoading}</p>
      </div>
    )
  }
}
