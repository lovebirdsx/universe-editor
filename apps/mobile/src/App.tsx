import type { MobileSessionRef } from '@universe-editor/mobile-protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { SessionsPage, type SessionWorkspaceHint } from './pages/SessionsPage.js'
import {
  leaveSession,
  leaveSessions,
  navigateToNewSession,
  navigateToSession,
  navigateToSessions,
  pushMobileRoute,
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
  // Workspace of a catalog row that came from a closed workspace; the session
  // page keeps it so a later "reopen" can ask the PC to open that workspace.
  const [pendingWorkspaceHint, setPendingWorkspaceHint] = useState<
    SessionWorkspaceHint | undefined
  >(undefined)
  // Sessions opened from the catalog go back there; inbox rows go back to the inbox.
  const [sessionOrigin, setSessionOrigin] = useState<'inbox' | 'sessions'>('inbox')
  const sessionsScrollRef = useRef(0)
  // A catalog page kept mounted behind its session keeps search, filter and rows.
  const keepSessionsPage =
    route.name === 'sessions' || (route.name === 'session' && sessionOrigin === 'sessions')

  useEffect(() => {
    if (route.name !== 'sessions' || sessionsScrollRef.current === 0) return
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo(0, sessionsScrollRef.current)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [route.name])

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
      setPendingWorkspaceHint(undefined)
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
      // `pushState`, not replace: the inbox entry must stay below so the
      // session's back button can return to it on a single-entry cold start.
      pushMobileRoute(`${url.pathname}${url.search}`)
      setPendingRef(undefined)
      setPendingWorkspaceHint(undefined)
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
    setPendingWorkspaceHint(undefined)
    setRoute({ name: 'inbox' })
  }

  const openSession = (sessionKey: string, pending = false): void => {
    setPendingRef(undefined)
    setPendingWorkspaceHint(undefined)
    setSessionOrigin('inbox')
    navigateToSession(sessionKey)
    setFocusPending(pending)
    setRoute(readRoute(window.location.pathname))
  }

  const openSessionRef = (ref: MobileSessionRef, workspaceHint?: SessionWorkspaceHint): void => {
    if (route.name === 'sessions') {
      sessionsScrollRef.current = window.scrollY
      setSessionOrigin('sessions')
    }
    setPendingRef(ref)
    setPendingWorkspaceHint(workspaceHint)
    setFocusPending(false)
    navigateToSession(sessionRouteKey(ref))
    setRoute(readRoute(window.location.pathname))
  }

  const openSessions = (): void => {
    setPendingRef(undefined)
    setPendingWorkspaceHint(undefined)
    setFocusPending(false)
    navigateToSessions()
    setRoute(readRoute(window.location.pathname))
  }

  const leaveSessionsPage = (): void => {
    setPendingRef(undefined)
    setPendingWorkspaceHint(undefined)
    sessionsScrollRef.current = 0
    leaveSessions()
  }

  const openNewSession = (): void => {
    setPendingRef(undefined)
    setPendingWorkspaceHint(undefined)
    setSessionOrigin('inbox')
    navigateToNewSession()
    setFocusPending(false)
    setRoute(readRoute(window.location.pathname))
  }

  const backToInbox = (): void => {
    setPendingRef(undefined)
    setPendingWorkspaceHint(undefined)
    leaveSession()
    setFocusPending(false)
    setRoute({ name: 'inbox' })
  }

  const leaveSessionPage = (): void => {
    setPendingRef(undefined)
    setPendingWorkspaceHint(undefined)
    setFocusPending(false)
    leaveSession()
  }

  const unpair = (): void => {
    setPendingRef(undefined)
    setPendingWorkspaceHint(undefined)
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
        if (route.name === 'sessions') {
          sessionsScrollRef.current = window.scrollY
          setSessionOrigin('sessions')
        } else if (route.name !== 'session') {
          setSessionOrigin('inbox')
        }
        setPendingRef(undefined)
        setPendingWorkspaceHint(undefined)
        setFocusPending(pending)
        navigateToSession(sessionKey)
        setRoute(readRoute(window.location.pathname))
      }}
    />
  )

  const page =
    route.name === 'session' ? (
      <SessionPage
        key={route.sessionKey}
        client={client}
        sessionKey={route.sessionKey}
        initialRef={pendingRef}
        onOpenSessionRef={openSessionRef}
        focusPending={focusPending}
        workspaceFolder={pendingWorkspaceHint?.folder}
        workspaceAuthority={pendingWorkspaceHint?.authority}
        onBack={leaveSessionPage}
        onFinished={leaveSessionPage}
      />
    ) : route.name === 'new-session' ? (
      <NewSessionPage
        client={client}
        onBack={backToInbox}
        onCreated={(sessionKey) => {
          setPendingRef(undefined)
          setPendingWorkspaceHint(undefined)
          setFocusPending(false)
          setRoute({ name: 'session', sessionKey })
        }}
      />
    ) : route.name === 'sessions' ? null : (
      <InboxPage
        client={client}
        credentials={credentials}
        notice={notice}
        onDismissNotice={() => setNotice(undefined)}
        onNotice={setNotice}
        onOpenSession={openSession}
        onOpenSessions={openSessions}
        onNewSession={openNewSession}
        onUnpair={unpair}
      />
    )

  return (
    <>
      {overlay}
      {keepSessionsPage && (
        <div className={route.name === 'sessions' ? 'page-layer' : 'page-layer page-layer--hidden'}>
          <SessionsPage
            client={client}
            active={route.name === 'sessions'}
            notice={notice}
            onDismissNotice={() => setNotice(undefined)}
            onBack={leaveSessionsPage}
            onOpenSessionRef={openSessionRef}
          />
        </div>
      )}
      {page}
    </>
  )
}
