import type { MobileSessionRef } from '@universe-editor/mobile-protocol'
import { useEffect, useMemo, useState } from 'react'
import { NotificationToast } from './components/NotificationToast.js'
import { Spinner } from './components/Spinner.js'
import {
  createCredentialStore,
  type SaveCredentialsResult,
  type StoredCredentials,
} from './credentials.js'
import { GuidePage } from './pages/GuidePage.js'
import { InboxPage } from './pages/InboxPage.js'
import { NewSessionPage } from './pages/NewSessionPage.js'
import { PairPage } from './pages/PairPage.js'
import {
  leaveSession,
  navigateToNewSession,
  navigateToSession,
  readRoute,
  type Route,
} from './routing.js'
import { SessionPage } from './session/SessionPage.js'
import { websocketUrlForLocation, type WebSocketLike } from './socket/mobileSocket.js'
import { MobileClient } from './state/mobileClient.js'
import { sessionRouteKey } from './state/refs.js'
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
  const [focusPending, setFocusPending] = useState(
    () => new URLSearchParams(window.location.search).get('focus') === 'pending',
  )
  const [notice, setNotice] = useState<string | undefined>(undefined)
  // Ref returned by a fork / side-task command; the session route resolves it
  // directly instead of waiting for the inbox mirror to catch up.
  const [pendingRef, setPendingRef] = useState<MobileSessionRef | undefined>(undefined)

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
    const onPopState = (): void => {
      setPendingRef(undefined)
      setRoute(readRoute(window.location.pathname))
      setFocusPending(new URLSearchParams(window.location.search).get('focus') === 'pending')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // A notification click either focuses this window and posts the deep link, or
  // (cold start) opens it directly; both land on the same `/s/<ref>` route.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; url?: unknown } | null
      if (data?.type !== 'mobile-navigate' || typeof data.url !== 'string') return
      let url: URL
      try {
        url = new URL(data.url, window.location.origin)
      } catch {
        return
      }
      const next = readRoute(url.pathname)
      if (next.name !== 'session') return
      window.history.replaceState({ mobile: true }, '', `${url.pathname}${url.search}`)
      setPendingRef(undefined)
      setFocusPending(url.searchParams.get('focus') === 'pending')
      setRoute(next)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
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
    setLoaded({ loading: true, credentials: undefined })
    setReloadKey((value) => value + 1)
    setPendingRef(undefined)
    setRoute({ name: 'inbox' })
  }

  const openSession = (sessionKey: string, pending = false): void => {
    setPendingRef(undefined)
    navigateToSession(sessionKey)
    setFocusPending(pending)
    setRoute(readRoute(window.location.pathname))
  }

  const openSessionRef = (ref: MobileSessionRef): void => {
    setPendingRef(ref)
    setFocusPending(false)
    navigateToSession(sessionRouteKey(ref))
    setRoute(readRoute(window.location.pathname))
  }

  const openNewSession = (): void => {
    setPendingRef(undefined)
    navigateToNewSession()
    setFocusPending(false)
    setRoute(readRoute(window.location.pathname))
  }

  const backToInbox = (): void => {
    setPendingRef(undefined)
    leaveSession()
    setFocusPending(false)
    setRoute({ name: 'inbox' })
  }

  const unpair = (): void => {
    setPendingRef(undefined)
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
      <GuidePage
        store={store}
        onPaired={handlePaired}
        notice={notice}
        onDismissNotice={() => setNotice(undefined)}
      />
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

  const overlay = (
    <NotificationToast
      client={client}
      onOpen={(sessionKey, pending) => {
        setPendingRef(undefined)
        setFocusPending(pending)
        navigateToSession(sessionKey)
        setRoute(readRoute(window.location.pathname))
      }}
    />
  )

  if (route.name === 'session') {
    return (
      <>
        {overlay}
        <SessionPage
          key={route.sessionKey}
          client={client}
          sessionKey={route.sessionKey}
          initialRef={pendingRef}
          onOpenSessionRef={openSessionRef}
          focusPending={focusPending}
          onBack={backToInbox}
        />
      </>
    )
  }

  if (route.name === 'new-session') {
    return (
      <>
        {overlay}
        <NewSessionPage
          client={client}
          onBack={backToInbox}
          onCreated={(sessionKey) => {
            setPendingRef(undefined)
            setFocusPending(false)
            setRoute({ name: 'session', sessionKey })
          }}
        />
      </>
    )
  }

  return (
    <>
      {overlay}
      <InboxPage
        client={client}
        credentials={credentials}
        notice={notice}
        onDismissNotice={() => setNotice(undefined)}
        onOpenSession={openSession}
        onNewSession={openNewSession}
        onUnpair={unpair}
      />
    </>
  )
}
