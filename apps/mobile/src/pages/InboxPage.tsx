import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { Spinner } from '../components/Spinner.js'
import { SettingsDrawer } from '../components/SettingsDrawer.js'
import { StatusBar } from '../components/StatusBar.js'
import type { CredentialStore, StoredCredentials } from '../credentials.js'
import { InboxGroups } from '../inbox/InboxGroups.js'
import {
  MobileSocket,
  websocketUrlForLocation,
  type SocketState,
  type WebSocketLike,
} from '../socket/mobileSocket.js'
import { strings } from '../strings.js'

export interface InboxPageProps {
  readonly store: CredentialStore
  readonly reloadKey: number
  readonly notice?: string | undefined
  readonly onDismissNotice: () => void
}

interface LoadedState {
  readonly loading: boolean
  readonly credentials: StoredCredentials | undefined
}

export function InboxPage({ store, reloadKey, notice, onDismissNotice }: InboxPageProps) {
  const [loaded, setLoaded] = useState<LoadedState>({ loading: true, credentials: undefined })
  const [socketState, setSocketState] = useState<SocketState>('connecting')
  const [sessions, setSessions] = useState<readonly MobileSessionSummary[]>([])
  const [hasSnapshot, setHasSnapshot] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [eventNotice, setEventNotice] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setLoaded((previous) => ({ ...previous, loading: true }))
    void store.load().then((credentials) => {
      if (cancelled) return
      setLoaded({ loading: false, credentials })
    })
    return () => {
      cancelled = true
    }
  }, [store, reloadKey])

  const credentials = loaded.credentials

  useEffect(() => {
    if (credentials === undefined) return
    setSessions([])
    setHasSnapshot(false)
    setSocketState('connecting')

    const socket = new MobileSocket({
      url: websocketUrlForLocation(window.location),
      token: credentials.token,
      createWebSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
      onStateChange: (state) => setSocketState(state),
      onFrame: (frame) => {
        if (frame.type === 'inbox_snapshot') {
          setSessions(frame.sessions)
          setHasSnapshot(true)
        }
      },
      onCredentialsInvalid: () => {
        setEventNotice(strings.credentialsInvalid)
        void store.clear()
        setLoaded({ loading: false, credentials: undefined })
      },
      onProtocolMismatch: () => {
        setEventNotice(strings.inboxVersionMismatch)
      },
    })
    socket.start()
    return () => socket.stop()
  }, [credentials, store])

  const dismissNotice = (): void => {
    setEventNotice(undefined)
    onDismissNotice()
  }
  const shownNotice = eventNotice ?? notice

  if (loaded.loading) {
    return (
      <main className="centered-page">
        <Spinner />
        <p className="muted">{strings.statusConnecting}</p>
      </main>
    )
  }

  if (credentials === undefined) {
    return (
      <main className="guide-page">
        {shownNotice !== undefined && <NoticeBar text={shownNotice} onDismiss={dismissNotice} />}
        <span className="guide-page__logo" aria-hidden="true" />
        <h1 className="guide-page__title">{strings.guideTitle}</h1>
        <p className="guide-page__body">{strings.guideBody}</p>
        <p className="guide-page__hint">{strings.guideHint}</p>
      </main>
    )
  }

  const unpair = (): void => {
    setSettingsOpen(false)
    setEventNotice(undefined)
    onDismissNotice()
    void store.clear()
    setLoaded({ loading: false, credentials: undefined })
  }

  return (
    <div className="inbox-page">
      <StatusBar
        pcName={credentials.pcName}
        state={socketState}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="inbox-page__body">
        {shownNotice !== undefined && <NoticeBar text={shownNotice} onDismiss={dismissNotice} />}
        {renderBody()}
      </main>
      {settingsOpen && (
        <SettingsDrawer
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

    if (hasSnapshot) {
      if (sessions.length === 0) {
        return (
          <div className="state-card">
            <p>{strings.inboxEmpty}</p>
          </div>
        )
      }
      return <InboxGroups sessions={sessions} />
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

interface NoticeBarProps {
  readonly text: string
  readonly onDismiss: () => void
}

function NoticeBar({ text, onDismiss }: NoticeBarProps) {
  return (
    <div className="notice" role="status">
      <span>{text}</span>
      <button type="button" className="notice__dismiss" onClick={onDismiss}>
        {strings.noticeDismiss}
      </button>
    </div>
  )
}
