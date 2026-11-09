import type { MobileSessionRef, MobileTimelineMessageItem } from '@universe-editor/mobile-protocol'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '../components/Spinner.js'
import type { MobileClient } from '../state/mobileClient.js'
import { parseSessionRouteKey, sessionRouteKey } from '../state/refs.js'
import type { PermissionClearedInfo } from '../state/sessionStore.js'
import { useStore } from '../state/useStore.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'
import { Composer, type ComposerPrefill } from './Composer.js'
import {
  clipSideTaskQuote,
  depositComposerPrefill,
  sideTaskQuoteText,
  takeComposerPrefill,
} from './composerPrefill.js'
import { ConfigSheet } from './ConfigSheet.js'
import { ElicitationSheet } from './ElicitationSheet.js'
import { MessageActionsSheet } from './MessageActionsSheet.js'
import { PermissionSheet } from './PermissionSheet.js'
import { PlanPanel } from './PlanPanel.js'
import { RewindPreviewSheet } from './RewindPreviewSheet.js'
import { SessionHeader } from './SessionHeader.js'
import { SessionMenuSheet } from './SessionMenuSheet.js'
import { readSessionDisplayPreference, type SessionDisplayPreference } from './sessionDisplay.js'
import { isSessionWorking } from './sessionStatus.js'
import { SideTasksSheet } from './SideTasksSheet.js'
import { Timeline } from './Timeline.js'
import { useVisualViewportHeight } from './useVisualViewport.js'

const TOAST_MS = 3_000
export const SESSION_LOAD_TIMEOUT_MS = 15_000

export interface SessionPageProps {
  readonly client: MobileClient
  readonly sessionKey: string
  /** A command returned this ref (fork / side task); subscribe directly. */
  readonly initialRef?: MobileSessionRef | undefined
  readonly onOpenSessionRef?: ((ref: MobileSessionRef) => void) | undefined
  readonly onBack: () => void
  /** Close/remove succeeded: return to wherever the session was opened, with a notice. */
  readonly onFinished: (action: 'closed' | 'removed') => void
  /** Inbox "待审批" rows ask the page to reveal the pending card immediately. */
  readonly focusPending?: boolean | undefined
}

export function SessionPage({
  client,
  sessionKey,
  initialRef,
  onOpenSessionRef,
  onBack,
  onFinished,
  focusPending,
}: SessionPageProps) {
  // The ref that opened this route must survive later prop clearing without
  // re-running `openSession(durable-id)` before the hub mirror contains it.
  const initialRefRef = useRef(initialRef)
  useEffect(() => {
    initialRefRef.current = initialRef
  }, [initialRef])
  useEffect(() => {
    const ref = initialRefRef.current
    if (ref !== undefined && sessionRouteKey(ref) === sessionKey) client.openSessionRef(ref)
    else client.openSession(sessionKey)
    return () => client.unsubscribeSession()
  }, [client, sessionKey])

  const state = useStore(client.getSessionStore())
  const inbox = useStore(client.getInboxStore())
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
  const [messageActionsItem, setMessageActionsItem] = useState<
    MobileTimelineMessageItem | undefined
  >(undefined)
  const [rewindMessageId, setRewindMessageId] = useState<string | undefined>(undefined)
  const [sideTasksOpen, setSideTasksOpen] = useState(false)
  const [prefill, setPrefill] = useState<ComposerPrefill | undefined>(undefined)
  const [reopening, setReopening] = useState(false)
  const handledCleared = useRef<PermissionClearedInfo | undefined>(undefined)
  const footerRef = useRef<HTMLDivElement | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Switching sessions must not leave the previous session's menu open.
  useEffect(() => {
    setMenuOpen(false)
  }, [sessionKey])

  const notice = (text: string): void => setToast(text)
  const openRef = onOpenSessionRef ?? ((): void => undefined)
  const applyPrefill = (text: string): void =>
    setPrefill((previous) => ({
      token: (previous?.token ?? 0) + 1,
      sessionKey,
      text,
    }))

  useEffect(() => {
    const text = takeComposerPrefill(sessionKey)
    if (text !== undefined) {
      setPrefill((previous) => ({
        token: (previous?.token ?? 0) + 1,
        sessionKey,
        text,
      }))
    }
  }, [sessionKey])
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

  const forkFrom = async (messageId?: string): Promise<void> => {
    const result = await client.forkSession(messageId)
    setMessageActionsItem(undefined)
    openRef(result.ref)
  }

  const createSideTaskFrom = async (text?: string): Promise<void> => {
    const trimmed = text?.trim() ?? ''
    const result = await client.createSideTask(
      trimmed === '' ? undefined : clipSideTaskQuote(trimmed),
    )
    if (trimmed !== '') {
      depositComposerPrefill(sessionRouteKey(result.ref), sideTaskQuoteText(trimmed))
    }
    setMessageActionsItem(undefined)
    openRef(result.ref)
  }

  const reopenAfterRewind = (text: string | undefined): void => {
    setRewindMessageId(undefined)
    if (text !== undefined) {
      applyPrefill(text)
      notice(strings.rewindDone)
    }
  }

  const openSideTaskRef = (ref: MobileSessionRef): void => {
    setSideTasksOpen(false)
    openRef(ref)
  }

  const durableId =
    state.ref?.durableId ??
    (parseSessionRouteKey(sessionKey) === undefined ? sessionKey : undefined)

  // Deep links and closed inbox rows can point at a durable id the PC still
  // knows; resume it without activating the PC window, then re-subscribe.
  const reopenSession = async (): Promise<void> => {
    if (durableId === undefined || reopening || !online) return
    setReopening(true)
    try {
      const result = await client.resumeSession(durableId, state.ref?.windowId)
      if (!aliveRef.current) return
      if (onOpenSessionRef !== undefined && sessionRouteKey(result.ref) !== sessionKey) {
        onOpenSessionRef(result.ref)
      } else {
        client.openSessionRef(result.ref)
      }
    } catch (err) {
      if (!aliveRef.current) return
      const code = errorCode(err)
      notice(code === undefined ? strings.sessionReopenFailed : commandErrorText(code))
    } finally {
      if (aliveRef.current) setReopening(false)
    }
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
          <div className="session-removed__actions">
            {durableId !== undefined && (
              <button
                type="button"
                className="button button--primary"
                data-testid="session-reopen"
                disabled={reopening || !online}
                onClick={() => void reopenSession()}
              >
                {reopening ? strings.sessionReopening : strings.sessionReopen}
              </button>
            )}
          </div>
        </main>
      </div>
    )
  }

  const permission = state.pendingPermission
  const elicitation = state.pendingElicitation
  const readOnly = state.summary?.readOnly ?? false
  const running = state.summary?.bucket === 'in_progress'
  const rewindAvailable = state.summary?.rewindSupported === true && !readOnly
  const sideTaskAvailable = state.summary?.forkSupported === true && !readOnly
  const sideTaskOf = state.summary?.sideTaskOf
  const parentSummary =
    sideTaskOf === undefined
      ? undefined
      : inbox.sessions.find((session) => session.ref.durableId === sideTaskOf)
  const loadFailed = waitingForSnapshot && (loadTimedOut || invalidFrame !== undefined)

  return (
    <div className="session-page" style={style}>
      <SessionHeader
        summary={state.summary}
        configOptions={state.configOptions}
        socketState={socketState}
        online={online}
        busyConfigId={busyConfigId}
        parentTitle={parentSummary?.title}
        onOpenParent={parentSummary === undefined ? undefined : () => openRef(parentSummary.ref)}
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
            rewindAvailable={rewindAvailable}
            sideTaskAvailable={sideTaskAvailable}
            onOpenMessageActions={setMessageActionsItem}
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
              imageSupported={state.summary?.imageSupported === true}
              fileSupported={state.summary?.authority === undefined}
              onUploadAttachment={(file, kind) => client.uploadAttachment(file, kind)}
              prefill={prefill}
              onSend={(text, attachmentIds) => client.sendPrompt(text, attachmentIds)}
              onStop={() => client.cancelTurn()}
              onNotice={notice}
            />
          </div>
        </>
      )}
      {messageActionsItem !== undefined && (
        <MessageActionsSheet
          canRewind={rewindAvailable && messageActionsItem.messageId !== undefined}
          canFork={messageActionsItem.canFork === true}
          canCreateSideTask={sideTaskAvailable && messageActionsItem.text.trim() !== ''}
          online={online}
          running={running}
          onRewind={() => {
            const messageId = messageActionsItem.messageId
            setMessageActionsItem(undefined)
            if (messageId !== undefined) setRewindMessageId(messageId)
          }}
          onFork={() => forkFrom(messageActionsItem.messageId)}
          onSideTask={() => createSideTaskFrom(messageActionsItem.text)}
          onClose={() => setMessageActionsItem(undefined)}
          onNotice={notice}
        />
      )}
      {rewindMessageId !== undefined && (
        <RewindPreviewSheet
          client={client}
          messageId={rewindMessageId}
          online={online}
          onClose={() => setRewindMessageId(undefined)}
          onApplied={reopenAfterRewind}
          onNotice={notice}
        />
      )}
      {sideTasksOpen && (
        <SideTasksSheet
          client={client}
          online={online}
          onClose={() => setSideTasksOpen(false)}
          onOpen={openSideTaskRef}
          onNotice={notice}
        />
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
          forkSupported={state.summary?.forkSupported === true}
          // Unknown summary (still loading or just switched): treat as read-only
          // and confirm before closing so a stale menu cannot end a live task.
          readOnly={state.summary === undefined || readOnly}
          running={running}
          closeNeedsConfirm={state.summary === undefined || isSessionWorking(state.summary)}
          sideTaskChildCount={state.summary?.sideTaskChildCount}
          onForkTip={() => forkFrom()}
          onNewSideTask={() => createSideTaskFrom()}
          onOpenSideTasks={() => {
            setMenuOpen(false)
            setSideTasksOpen(true)
          }}
          onClose={() => setMenuOpen(false)}
          onNotice={notice}
          onFinished={onFinished}
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
