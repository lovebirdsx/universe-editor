import { useEffect, useRef, useState } from 'react'
import { Spinner } from '../components/Spinner.js'
import type { MobileClient } from '../state/mobileClient.js'
import { sessionRouteKey } from '../state/refs.js'
import type { PermissionClearedInfo } from '../state/sessionStore.js'
import { useStore } from '../state/useStore.js'
import { commandErrorText, strings } from '../strings.js'
import { Composer } from './Composer.js'
import { ConfigSheet } from './ConfigSheet.js'
import { ElicitationSheet } from './ElicitationSheet.js'
import { PermissionSheet } from './PermissionSheet.js'
import { PlanPanel } from './PlanPanel.js'
import { SessionHeader } from './SessionHeader.js'
import { SessionMenuSheet } from './SessionMenuSheet.js'
import { readSessionDisplayPreference, type SessionDisplayPreference } from './sessionDisplay.js'
import { Timeline } from './Timeline.js'
import { useVisualViewportHeight } from './useVisualViewport.js'

const TOAST_MS = 3_000
export const SESSION_LOAD_TIMEOUT_MS = 15_000

export interface SessionPageProps {
  readonly client: MobileClient
  readonly sessionKey: string
  readonly onBack: () => void
  /** Inbox "待审批" rows ask the page to reveal the pending card immediately. */
  readonly focusPending?: boolean | undefined
}

export function SessionPage({ client, sessionKey, onBack, focusPending }: SessionPageProps) {
  useEffect(() => {
    client.openSession(sessionKey)
    return () => client.closeSession()
  }, [client, sessionKey])

  const state = useStore(client.getSessionStore())
  const socketState = useStore(client.getSocketStateStore())
  const invalidFrame = useStore(client.getInvalidFrameStore())
  const viewportHeight = useVisualViewportHeight()
  const online = socketState === 'connected'
  const activeSessionKey = state.ref === undefined ? sessionKey : sessionRouteKey(state.ref)
  const [displayMode] = useState<SessionDisplayPreference>(() => readSessionDisplayPreference())

  const [toast, setToast] = useState<string | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  const [configSheetId, setConfigSheetId] = useState<string | undefined>(undefined)
  const [busyConfigId, setBusyConfigId] = useState<string | undefined>(undefined)
  const [loadTimedOut, setLoadTimedOut] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const handledCleared = useRef<PermissionClearedInfo | undefined>(undefined)
  const footerRef = useRef<HTMLDivElement | null>(null)

  const notice = (text: string): void => setToast(text)
  const pendingPermissionId = state.pendingPermission?.requestId
  const pendingElicitationId = state.pendingElicitation?.requestId

  useEffect(() => {
    if (toast === undefined) return
    const timer = setTimeout(() => setToast(undefined), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  // A snapshot that never arrives (or a frame the gateway failed to shape) used
  // to spin forever; surface it instead of leaving the user waiting.
  const waitingForSnapshot = state.summary === undefined && !state.removed
  useEffect(() => {
    if (!waitingForSnapshot) return
    const timer = setTimeout(() => setLoadTimedOut(true), SESSION_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [waitingForSnapshot, sessionKey, retryToken])

  // `permission_cleared` lands after the sheet has already unmounted; the
  // source tells us whether the phone acted or the request was handled elsewhere.
  useEffect(() => {
    const cleared = state.permissionCleared
    if (cleared === undefined || handledCleared.current === cleared) return
    handledCleared.current = cleared
    if (cleared.source !== 'mobile') notice(strings.pendingResolvedElsewhere)
  }, [state.permissionCleared])

  useEffect(() => {
    if (focusPending !== true) return
    if (pendingPermissionId === undefined && pendingElicitationId === undefined) return
    footerRef.current?.scrollIntoView({ block: 'nearest' })
  }, [focusPending, pendingPermissionId, pendingElicitationId])

  const configOption =
    configSheetId === undefined
      ? undefined
      : state.configOptions.find((option) => option.id === configSheetId)

  const toggleBoolean = async (configId: string, next: boolean): Promise<void> => {
    if (busyConfigId !== undefined) return
    setBusyConfigId(configId)
    try {
      await client.setConfigOption(configId, next)
    } catch (error) {
      notice(commandErrorText(errorCode(error)))
    } finally {
      setBusyConfigId(undefined)
    }
  }

  const retrySession = (): void => {
    setLoadTimedOut(false)
    setRetryToken((value) => value + 1)
    client.refreshSession()
  }

  const style = viewportHeight === undefined ? undefined : { height: `${viewportHeight}px` }

  if (state.removed) {
    return (
      <div className="session-page" style={style}>
        <SessionHeader
          summary={state.summary}
          socketState={socketState}
          online={online}
          onBack={onBack}
          onOpenConfig={() => undefined}
          onToggleBoolean={() => undefined}
          onOpenMenu={() => undefined}
        />
        <main className="session-removed">
          <h2 className="session-removed__title">{strings.sessionRemovedTitle}</h2>
          <p className="muted">{strings.sessionRemovedBody}</p>
          <button type="button" className="button button--primary" onClick={onBack}>
            {strings.sessionBackToInbox}
          </button>
        </main>
      </div>
    )
  }

  const permission = state.pendingPermission
  const elicitation = state.pendingElicitation
  const readOnly = state.summary?.readOnly ?? false
  const running = state.summary?.bucket === 'in_progress'
  const loadFailed = waitingForSnapshot && (loadTimedOut || invalidFrame !== undefined)

  return (
    <div className="session-page" style={style}>
      <SessionHeader
        summary={state.summary}
        configOptions={state.configOptions}
        socketState={socketState}
        online={online}
        busyConfigId={busyConfigId}
        onBack={onBack}
        onOpenConfig={(id) => setConfigSheetId(id)}
        onToggleBoolean={(option) => void toggleBoolean(option.id, option.currentValue !== 'On')}
        onOpenMenu={() => setMenuOpen(true)}
      />
      {state.summary === undefined ? (
        loadFailed ? (
          <main className="session-loading" data-testid="session-load-failed">
            <h2 className="session-removed__title">{strings.sessionLoadFailedTitle}</h2>
            <p className="muted">{strings.sessionLoadFailedBody}</p>
            <button type="button" className="button button--primary" onClick={retrySession}>
              {strings.sessionRetry}
            </button>
          </main>
        ) : (
          <main className="session-loading">
            <Spinner />
            <p className="muted">{strings.sessionLoading}</p>
          </main>
        )
      ) : (
        <>
          <PlanPanel plan={state.plan} />
          <Timeline
            sessionKey={activeSessionKey}
            timeline={state.timeline}
            displayMode={displayMode}
            truncated={state.truncated}
            client={client}
          />
          <div className="session-footer" ref={footerRef} data-testid="session-footer">
            {permission !== undefined && (
              <PermissionSheet
                client={client}
                permission={permission}
                online={online}
                onNotice={notice}
              />
            )}
            {elicitation !== undefined && (
              <ElicitationSheet
                client={client}
                elicitation={elicitation}
                online={online}
                onNotice={notice}
              />
            )}
            <Composer
              key={sessionKey}
              sessionKey={sessionKey}
              readOnly={readOnly}
              running={running}
              online={online}
              onSend={(text) => client.sendPrompt(text)}
              onStop={() => client.cancelTurn()}
              onNotice={notice}
            />
          </div>
        </>
      )}
      {configOption !== undefined && (
        <ConfigSheet
          client={client}
          option={configOption}
          online={online}
          onClose={() => setConfigSheetId(undefined)}
          onNotice={notice}
        />
      )}
      {menuOpen && (
        <SessionMenuSheet
          client={client}
          title={state.summary?.title ?? strings.sessionMore}
          online={online}
          onClose={() => setMenuOpen(false)}
          onNotice={notice}
        />
      )}
      {toast !== undefined && (
        <div className="session-toast" role="status" data-testid="session-toast">
          {toast}
        </div>
      )}
    </div>
  )
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}
