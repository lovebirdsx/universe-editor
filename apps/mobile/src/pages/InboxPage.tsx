import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import type { StoredCredentials } from '../credentials.js'
import { InboxGroups } from '../inbox/InboxGroups.js'
import { selectInboxSessions } from '../inbox/groupSessions.js'
import {
  InboxSessionActionSheet,
  type InboxSessionSheetView,
} from '../inbox/InboxSessionActionSheet.js'
import type { MobileClient } from '../state/mobileClient.js'
import { refMatches, sessionRouteKey } from '../state/refs.js'
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
import { useShellCacheFallback } from '../shellCache.js'
import { useEffect, useState } from 'react'

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
  const shellFromCache = useShellCacheFallback()
  const [cacheNoticeDismissed, setCacheNoticeDismissed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dirtyWindowIds, setDirtyWindowIds] = useState<ReadonlySet<number>>(() => new Set())
  const [sessionAction, setSessionAction] = useState<
    { readonly session: MobileSessionSummary; readonly view: InboxSessionSheetView } | undefined
  >(undefined)
  const [deliverySheet, setDeliverySheet] = useState<DeliverySheet | undefined>(undefined)
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
      .then(() => onNotice(strings.sessionCloseNotice))
      .catch((error: unknown) => onNotice(commandErrorText(errorCode(error))))
  }

  const removeSession = (session: MobileSessionSummary): void => {
    if (isSessionRemoveConfirmEnabled()) {
      setSessionAction({ session, view: 'remove' })
      return
    }
    void client
      .deleteSession(session.ref)
      .then(() => onNotice(strings.sessionRemovedNotice))
      .catch((error: unknown) => onNotice(commandErrorText(errorCode(error))))
  }

  const completedSessionAction = (action: 'closed' | 'removed'): void => {
    onNotice(action === 'closed' ? strings.sessionCloseNotice : strings.sessionRemovedNotice)
  }

  const openDeliveryDetail = (session: MobileSessionSummary): void => {
    const delivery = session.delivery
    if (delivery === undefined) return
    setDeliverySheet({ mode: 'detail', session, deliveryId: delivery.deliveryId })
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
      {deliverySheet?.mode === 'confirm' && deliverySession !== undefined && (
        <DeliveryConfirmSheet
          key={`confirm:${deliverySession.ref.localId}`}
          client={client}
          session={deliverySession}
          online={socketState === 'connected'}
          onDismiss={() => setDeliverySheet(undefined)}
          onStarted={(deliveryId) =>
            setDeliverySheet({ mode: 'detail', session: deliverySession, deliveryId })
          }
          onNotice={onNotice}
        />
      )}
      {deliverySheet?.mode === 'detail' && deliverySession !== undefined && (
        <DeliveryDetailSheet
          key={`detail:${deliverySheet.deliveryId}`}
          client={client}
          session={deliverySession}
          deliveryId={deliverySheet.deliveryId}
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
            onStartDelivery={(session) => setDeliverySheet({ mode: 'confirm', session })}
            onOpenDelivery={(session) => openDeliveryDetail(session)}
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
