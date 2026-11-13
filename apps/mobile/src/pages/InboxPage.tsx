import type {
  MobileDeliveryExpectation,
  MobileSessionSummary,
} from '@universe-editor/mobile-protocol'
import type { StoredCredentials } from '../credentials.js'
import { InboxGroups } from '../inbox/InboxGroups.js'
import { selectInboxSessions } from '../inbox/groupSessions.js'
import {
  InboxSessionActionSheet,
  type InboxSessionSheetView,
} from '../inbox/InboxSessionActionSheet.js'
import type { MobileClient } from '../state/mobileClient.js'
import { refMatches, localRefKey, sessionRouteKey } from '../state/refs.js'
import { useStore } from '../state/useStore.js'
import { NoticeBar } from '../components/NoticeBar.js'
import { Spinner } from '../components/Spinner.js'
import { ConnectionDiagnostic } from '../components/ConnectionDiagnostic.js'
import { SettingsDrawer } from '../components/SettingsDrawer.js'
import { StatusBar } from '../components/StatusBar.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'
import { isSessionWorking } from '../session/sessionStatus.js'
import {
  isSessionRemoveConfirmEnabled,
  shouldConfirmSessionClose,
} from '../session/sessionConfirm.js'
import { collectDirtyWindowIds } from '../inbox/workspaceDirty.js'
import { selectDeliveryEntries } from '../inbox/deliveryStatus.js'
import { DeliverySummaryBar } from '../inbox/DeliverySummaryBar.js'
import { DeliveryConfirmSheet } from '../inbox/DeliveryConfirmSheet.js'
import { DeliveryDetailSheet } from '../inbox/DeliveryDetailSheet.js'
import { PushBranchSheet } from '../git/PushBranchSheet.js'
import { SessionReportOverlay } from '../report/SessionReportOverlay.js'
import { useShellCacheFallback } from '../shellCache.js'
import { useEffect, useRef, useState } from 'react'

type DeliverySheet =
  | { readonly mode: 'confirm'; readonly session: MobileSessionSummary }
  | {
      readonly mode: 'detail'
      readonly session: MobileSessionSummary
      readonly deliveryId: string
    }

export interface InboxPageProps {
  readonly client: MobileClient
  readonly credentials: StoredCredentials
  readonly notice?: string | undefined
  readonly onDismissNotice: () => void
  readonly onNotice: (text: string) => void
  readonly onDeliveryNotice: (text: string) => void
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
  onDeliveryNotice,
  onOpenSession,
  onOpenSessions,
  onNewSession,
  onUnpair,
}: InboxPageProps) {
  const inbox = useStore(client.getInboxStore())
  const socketState = useStore(client.getSocketStateStore())
  const diagnosis = useStore(client.getConnectionDiagnosisStore())
  const shellFromCache = useShellCacheFallback()
  const [cacheNoticeDismissed, setCacheNoticeDismissed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dirtyWindowIds, setDirtyWindowIds] = useState<ReadonlySet<number>>(() => new Set())
  const [sessionAction, setSessionAction] = useState<
    { readonly session: MobileSessionSummary; readonly view: InboxSessionSheetView } | undefined
  >(undefined)
  const [deliverySheet, setDeliverySheet] = useState<DeliverySheet | undefined>(undefined)
  const [startingKeys, setStartingKeys] = useState<ReadonlySet<string>>(() => new Set())
  const startingKeysRef = useRef<Set<string>>(new Set())
  const [pushSession, setPushSession] = useState<MobileSessionSummary | undefined>(undefined)
  const [reportSession, setReportSession] = useState<MobileSessionSummary | undefined>(undefined)
  // The sheet stays open while the inbox keeps moving; judge "is it working?"
  // against the latest summary, not the one captured on long-press.
  const actionSession =
    sessionAction === undefined
      ? undefined
      : (inbox.sessions.find((session) => refMatches(session.ref, sessionAction.session.ref)) ??
        sessionAction.session)
  const deliverySession =
    deliverySheet === undefined
      ? undefined
      : (inbox.sessions.find((session) => refMatches(session.ref, deliverySheet.session.ref)) ??
        deliverySheet.session)
  // A retry can replace the record with a new one; follow the live summary.
  const deliveryDetailId =
    deliverySheet?.mode === 'detail'
      ? (deliverySession?.delivery?.deliveryId ?? deliverySheet.deliveryId)
      : undefined
  const pushTarget =
    pushSession === undefined
      ? undefined
      : (inbox.sessions.find((session) => refMatches(session.ref, pushSession.ref)) ?? pushSession)
  const reportTarget =
    reportSession === undefined
      ? undefined
      : (inbox.sessions.find((session) => refMatches(session.ref, reportSession.ref)) ??
        reportSession)

  // One-shot on entry / reconnect: the badge is advisory, so a failure keeps
  // the previous set rather than replacing it with "everything clean".
  useEffect(() => {
    if (socketState !== 'connected') return
    let cancelled = false
    void client
      .listWorkspaces()
      .then((workspaces) => {
        if (!cancelled) setDirtyWindowIds(collectDirtyWindowIds(workspaces))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [client, socketState])

  const unpair = (): void => {
    setSettingsOpen(false)
    onDismissNotice()
    onUnpair()
  }

  const closeSession = (session: MobileSessionSummary): void => {
    if (shouldConfirmSessionClose(isSessionWorking(session))) {
      setSessionAction({ session, view: 'close' })
      return
    }
    void client
      .closeSession(session.ref)
      .catch((error: unknown) => onNotice(commandErrorText(errorCode(error))))
  }

  const removeSession = (session: MobileSessionSummary): void => {
    if (isSessionRemoveConfirmEnabled()) {
      setSessionAction({ session, view: 'remove' })
      return
    }
    void client
      .deleteSession(session.ref)
      .catch((error: unknown) => onNotice(commandErrorText(errorCode(error))))
  }

  const openDeliveryDetail = (session: MobileSessionSummary): void => {
    const delivery = session.delivery
    if (delivery === undefined) return
    setDeliverySheet({ mode: 'detail', session, deliveryId: delivery.deliveryId })
  }

  const isDeliveryStarting = (session: MobileSessionSummary): boolean =>
    startingKeys.has(localRefKey(session.ref))

  const requestStartDelivery = (session: MobileSessionSummary): void => {
    if (session.delivery !== undefined) {
      openDeliveryDetail(session)
      return
    }
    if (startingKeysRef.current.has(localRefKey(session.ref))) return
    setDeliverySheet({ mode: 'confirm', session })
  }

  // Close the confirm sheet first: the delivery keeps running on the PC and the
  // phone follows it through inbox deltas, so the user is free to keep browsing.
  const beginDelivery = (
    session: MobileSessionSummary,
    expectation: MobileDeliveryExpectation,
  ): void => {
    const key = localRefKey(session.ref)
    if (startingKeysRef.current.has(key)) return
    startingKeysRef.current.add(key)
    setStartingKeys(new Set(startingKeysRef.current))
    setDeliverySheet(undefined)
    void client
      .startDelivery(session.ref, expectation)
      .then(
        () => undefined,
        (error: unknown) =>
          onDeliveryNotice(`「${session.title}」${commandErrorText(errorCode(error))}`),
      )
      .finally(() => {
        startingKeysRef.current.delete(key)
        setStartingKeys(new Set(startingKeysRef.current))
      })
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
        {shellFromCache && !cacheNoticeDismissed && (
          <div data-testid="shell-cache-notice">
            <NoticeBar
              text={strings.shellFromCacheNotice}
              onDismiss={() => setCacheNoticeDismissed(true)}
            />
          </div>
        )}
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
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 4.5v15M4.5 12h15" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
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
          onPushBranch={(session) => {
            setSessionAction(undefined)
            setPushSession(session)
          }}
          onOpenReport={(session) => {
            setSessionAction(undefined)
            setReportSession(session)
          }}
        />
      )}
      {pushTarget !== undefined && (
        <PushBranchSheet
          key={`push:${pushTarget.ref.localId}`}
          client={client}
          session={pushTarget}
          online={socketState === 'connected'}
          onDismiss={() => setPushSession(undefined)}
          onNotice={onNotice}
        />
      )}
      {reportTarget !== undefined && reportTarget.automation !== undefined && (
        <SessionReportOverlay
          client={client}
          sessionRef={reportTarget.ref}
          automation={reportTarget.automation}
          onClose={() => setReportSession(undefined)}
        />
      )}
      {deliverySheet?.mode === 'confirm' && deliverySession !== undefined && (
        <DeliveryConfirmSheet
          key={`confirm:${deliverySession.ref.localId}`}
          client={client}
          session={deliverySession}
          online={socketState === 'connected'}
          onDismiss={() => setDeliverySheet(undefined)}
          onStart={(expectation) => beginDelivery(deliverySession, expectation)}
        />
      )}
      {deliverySheet?.mode === 'detail' &&
        deliverySession !== undefined &&
        deliveryDetailId !== undefined && (
          <DeliveryDetailSheet
            key={`detail:${deliveryDetailId}`}
            client={client}
            session={deliverySession}
            deliveryId={deliveryDetailId}
            online={socketState === 'connected'}
            onDismiss={() => setDeliverySheet(undefined)}
            onOpenSession={() => {
              setDeliverySheet(undefined)
              onOpenSession(sessionRouteKey(deliverySession.ref), false)
            }}
            onStartDelivery={() => setDeliverySheet({ mode: 'confirm', session: deliverySession })}
            onNotice={onNotice}
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
      const deliveryEntries = selectDeliveryEntries(sessions, true)
      return (
        <>
          {deliveryEntries.length > 0 && (
            <DeliverySummaryBar
              entries={deliveryEntries}
              onOpenDelivery={(session) => openDeliveryDetail(session)}
            />
          )}
          <InboxGroups
            sessions={sessions}
            onOpenSession={onOpenSession}
            onCloseSession={closeSession}
            onRemoveSession={removeSession}
            onShowSessionActions={(session) => setSessionAction({ session, view: 'menu' })}
            onStartDelivery={requestStartDelivery}
            onOpenDelivery={(session) => openDeliveryDetail(session)}
            isDeliveryStarting={isDeliveryStarting}
            dirtyWindowIds={dirtyWindowIds}
            stale={socketState !== 'connected'}
          />
        </>
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
