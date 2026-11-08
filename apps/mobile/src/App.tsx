import { useEffect, useMemo, useState } from 'react'
import { NoticeBar } from './components/NoticeBar.js'
import { Spinner } from './components/Spinner.js'
import {
  createCredentialStore,
  type SaveCredentialsResult,
  type StoredCredentials,
} from './credentials.js'
import { InboxPage } from './pages/InboxPage.js'
import { PairPage } from './pages/PairPage.js'
import { leaveSession, navigateToSession, readRoute, type Route } from './routing.js'
import { SessionPage } from './session/SessionPage.js'
import { websocketUrlForLocation, type WebSocketLike } from './socket/mobileSocket.js'
import { MobileClient } from './state/mobileClient.js'
import { strings } from './strings.js'

interface LoadedState {
  readonly loading: boolean
  readonly credentials: StoredCredentials | undefined
}

export function App() {
  const store = useMemo(() => createCredentialStore(), [])
  const [loaded, setLoaded] = useState<LoadedState>({ loading: true, credentials: undefined })
  const [reloadKey, setReloadKey] = useState(0)
  const [route, setRoute] = useState<Route>(() => readRoute(window.location.pathname))
  const [notice, setNotice] = useState<string | undefined>(undefined)

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

  useEffect(() => {
    const onPopState = (): void => setRoute(readRoute(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const credentials = loaded.credentials
  const client = useMemo(() => {
    if (credentials === undefined) return undefined
    return new MobileClient({
      credentials,
      url: websocketUrlForLocation(window.location),
      createWebSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
      onCredentialsInvalid: () => {
        setNotice(strings.credentialsInvalid)
        void store.clear()
        setLoaded({ loading: false, credentials: undefined })
      },
      onProtocolMismatch: () => setNotice(strings.inboxVersionMismatch),
    })
  }, [credentials, store])

  useEffect(() => {
    if (client === undefined) return
    client.start()
    return () => client.stop()
  }, [client])

  const handlePaired = (_credentials: StoredCredentials, result: SaveCredentialsResult): void => {
    setNotice(result.persisted ? undefined : strings.pairStorageUnavailable)
    setReloadKey((value) => value + 1)
    setRoute({ name: 'inbox' })
  }

  const openSession = (sessionKey: string): void => {
    navigateToSession(sessionKey)
    setRoute(readRoute(window.location.pathname))
  }

  const backToInbox = (): void => {
    leaveSession()
    setRoute({ name: 'inbox' })
  }

  const unpair = (): void => {
    setNotice(undefined)
    void store.clear()
    setLoaded({ loading: false, credentials: undefined })
  }

  if (loaded.loading) {
    return (
      <main className="centered-page">
        <Spinner />
        <p className="muted">{strings.statusConnecting}</p>
      </main>
    )
  }

  if (route.name === 'pair') {
    return <PairPage store={store} onPaired={handlePaired} />
  }

  if (credentials === undefined) {
    return (
      <main className="guide-page">
        {notice !== undefined && <NoticeBar text={notice} onDismiss={() => setNotice(undefined)} />}
        <span className="guide-page__logo" aria-hidden="true" />
        <h1 className="guide-page__title">{strings.guideTitle}</h1>
        <p className="guide-page__body">{strings.guideBody}</p>
        <p className="guide-page__hint">{strings.guideHint}</p>
      </main>
    )
  }

  if (client === undefined) {
    return (
      <main className="centered-page">
        <Spinner />
        <p className="muted">{strings.statusConnecting}</p>
      </main>
    )
  }

  if (route.name === 'session') {
    return <SessionPage client={client} sessionKey={route.sessionKey} onBack={backToInbox} />
  }

  return (
    <InboxPage
      client={client}
      credentials={credentials}
      notice={notice}
      onDismissNotice={() => setNotice(undefined)}
      onOpenSession={openSession}
      onUnpair={unpair}
    />
  )
}
