import type { StoredCredentials } from '../credentials.js'
import { InboxGroups } from '../inbox/InboxGroups.js'
import { selectInboxSessions } from '../inbox/groupSessions.js'
import type { MobileClient } from '../state/mobileClient.js'
import { useStore } from '../state/useStore.js'
import { NoticeBar } from '../components/NoticeBar.js'
import { Spinner } from '../components/Spinner.js'
import { SettingsDrawer } from '../components/SettingsDrawer.js'
import { StatusBar } from '../components/StatusBar.js'
import { strings } from '../strings.js'
import { useState } from 'react'

export interface InboxPageProps {
  readonly client: MobileClient
  readonly credentials: StoredCredentials
  readonly notice?: string | undefined
  readonly onDismissNotice: () => void
  readonly onOpenSession: (sessionKey: string, focusPending: boolean) => void
  readonly onNewSession: () => void
  readonly onUnpair: () => void
}

export function InboxPage({
  client,
  credentials,
  notice,
  onDismissNotice,
  onOpenSession,
  onNewSession,
  onUnpair,
}: InboxPageProps) {
  const inbox = useStore(client.getInboxStore())
  const socketState = useStore(client.getSocketStateStore())
  const [settingsOpen, setSettingsOpen] = useState(false)

  const unpair = (): void => {
    setSettingsOpen(false)
    onDismissNotice()
    onUnpair()
  }

  return (
    <div className="inbox-page">
      <StatusBar
        pcName={credentials.pcName}
        state={socketState}
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
          stale={socketState !== 'connected'}
        />
      )
    }

    if (socketState === 'reconnecting') {
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
