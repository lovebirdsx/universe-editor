import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { useEffect, useRef, useState } from 'react'
import { sessionRouteKey } from '../state/refs.js'
import { strings } from '../strings.js'
import { formatUpdatedAt, groupSessions } from './groupSessions.js'
import { SessionDeliveryControls } from './DeliveryBadge.js'
import { SwipeableSessionRow } from './SwipeableSessionRow.js'

export interface InboxGroupsProps {
  readonly sessions: readonly MobileSessionSummary[]
  readonly onOpenSession?: ((sessionKey: string, focusPending: boolean) => void) | undefined
  readonly onCloseSession?: ((session: MobileSessionSummary) => void) | undefined
  readonly onRemoveSession?: ((session: MobileSessionSummary) => void) | undefined
  readonly onShowSessionActions?: ((session: MobileSessionSummary) => void) | undefined
  /** Open the delivery confirmation flow for an inbox row. */
  readonly onStartDelivery?: ((session: MobileSessionSummary) => void) | undefined
  /** Open the status sheet of the row's latest delivery. */
  readonly onOpenDelivery?: ((session: MobileSessionSummary) => void) | undefined
  /** startDelivery was fired and the record has not appeared in the inbox yet. */
  readonly isDeliveryStarting?: ((session: MobileSessionSummary) => boolean) | undefined
  /** Windows whose workspace has uncommitted changes (joined by ref.windowId). */
  readonly dirtyWindowIds?: ReadonlySet<number> | undefined
  /** The PC is offline / reconnecting: keep the list visible but de-emphasised. */
  readonly stale?: boolean | undefined
}

export function InboxGroups({
  sessions,
  onOpenSession,
  onCloseSession,
  onRemoveSession,
  onShowSessionActions,
  onStartDelivery,
  onOpenDelivery,
  isDeliveryStarting,
  dirtyWindowIds,
  stale,
}: InboxGroupsProps) {
  const [openKey, setOpenKey] = useState<string | undefined>(undefined)
  // A row that re-orders or changes bucket mid-gesture unmounts/moves under the
  // finger and the swipe is lost, so hold the rendered list still until the
  // pointer is released and apply the buffered inbox updates then.
  const [gestureActive, setGestureActive] = useState(false)
  const frozenSessions = useRef(sessions)
  if (!gestureActive) frozenSessions.current = sessions
  const groups = groupSessions(gestureActive ? frozenSessions.current : sessions)
  const actionsEnabled =
    onCloseSession !== undefined ||
    onRemoveSession !== undefined ||
    onShowSessionActions !== undefined

  useEffect(() => {
    if (!gestureActive) return
    const end = (): void => setGestureActive(false)
    // Bubble, not capture: unfreezing re-renders the live order, which can move
    // the row into another group; it must run after the row's own pointerup or
    // the moved row would swallow the event that ends the swipe. Any release
    // ends the hold because a long press opens the sheet and the pointerup may
    // never reach the row.
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [gestureActive])

  useEffect(() => {
    if (openKey === undefined) return
    const close = (): void => setOpenKey(undefined)
    window.addEventListener('scroll', close, { passive: true, capture: true })
    return () => window.removeEventListener('scroll', close, { capture: true })
  }, [openKey])

  if (groups.length === 0) return null

  const runAction = (
    session: MobileSessionSummary,
    action?: (target: MobileSessionSummary) => void,
  ) => {
    setOpenKey(undefined)
    action?.(session)
  }

  return (
    <div className={`inbox-groups${stale === true ? ' inbox-groups--stale' : ''}`}>
      {groups.map((group) => (
        <section
          key={group.bucket}
          className="inbox-group"
          aria-labelledby={`bucket-${group.bucket}`}
        >
          <h2 id={`bucket-${group.bucket}`} className="inbox-group__title">
            {group.label}
            <span className="inbox-group__count">{group.sessions.length}</span>
          </h2>
          <ul className="inbox-group__list">
            {group.sessions.map((session) => {
              const key = sessionRouteKey(session.ref)
              const visible = actionsEnabled && !session.readOnly
              return (
                <li key={key}>
                  {visible ? (
                    <SwipeableSessionRow
                      open={openKey === key}
                      disabled={stale === true}
                      actions={[
                        {
                          key: 'close',
                          label: strings.sessionClose,
                          testId: 'inbox-session-close-action',
                          tone: 'close',
                          onSelect: () => runAction(session, onCloseSession),
                        },
                        {
                          key: 'remove',
                          label: strings.sessionRemove,
                          testId: 'inbox-session-remove-action',
                          tone: 'remove',
                          onSelect: () => runAction(session, onRemoveSession),
                        },
                      ]}
                      onGestureStart={() => setGestureActive(true)}
                      onOpenChange={(next) => setOpenKey(next ? key : undefined)}
                      onShowActions={() => runAction(session, onShowSessionActions)}
                    >
                      <SessionRow
                        session={session}
                        onOpenSession={onOpenSession}
                        disabled={stale === true}
                        actionsOpen={openKey === key}
                        onShowActions={() => runAction(session, onShowSessionActions)}
                        workspaceDirty={dirtyWindowIds?.has(session.ref.windowId) === true}
                        onStartDelivery={onStartDelivery}
                        onOpenDelivery={onOpenDelivery}
                        starting={isDeliveryStarting?.(session) === true}
                      />
                    </SwipeableSessionRow>
                  ) : (
                    <SessionRow
                      session={session}
                      onOpenSession={onOpenSession}
                      disabled={stale === true}
                      workspaceDirty={dirtyWindowIds?.has(session.ref.windowId) === true}
                      onStartDelivery={onStartDelivery}
                      onOpenDelivery={onOpenDelivery}
                      starting={isDeliveryStarting?.(session) === true}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

interface SessionRowProps {
  readonly session: MobileSessionSummary
  readonly onOpenSession?: ((sessionKey: string, focusPending: boolean) => void) | undefined
  readonly disabled: boolean
  readonly actionsOpen?: boolean | undefined
  readonly workspaceDirty?: boolean | undefined
  readonly onShowActions?: (() => void) | undefined
  readonly onStartDelivery?: ((session: MobileSessionSummary) => void) | undefined
  readonly onOpenDelivery?: ((session: MobileSessionSummary) => void) | undefined
  readonly starting?: boolean | undefined
}

function SessionRow({
  session,
  onOpenSession,
  disabled,
  actionsOpen,
  workspaceDirty,
  onShowActions,
  onStartDelivery,
  onOpenDelivery,
  starting,
}: SessionRowProps) {
  const routeKey = sessionRouteKey(session.ref)
  const focusPending =
    session.bucket === 'input_needed' &&
    (session.hasPendingPermission || session.hasPendingElicitation)
  const agent = session.agentName ?? session.agentId
  const badges: string[] = []
  if (session.hasPendingPermission) badges.push(strings.badgePermission)
  if (session.hasPendingElicitation) badges.push(strings.badgeElicitation)
  if (session.backgroundTaskCount > 0) {
    badges.push(strings.badgeBackgroundTasks(session.backgroundTaskCount))
  }
  if (session.authority !== undefined) badges.push(strings.badgeRemote)
  if (session.readOnly) badges.push(strings.badgeReadOnly)
  if (workspaceDirty === true) badges.push(strings.badgeWorkspaceDirty)
  // Delivery badges share the row with the rest so a synced row stays compact.
  const hasDelivery =
    session.delivery !== undefined || session.deliveryAvailable === true || starting === true

  return (
    <button
      type="button"
      className="session-card"
      data-testid="inbox-session-row"
      data-session-key={routeKey}
      disabled={disabled}
      aria-haspopup={onShowActions === undefined ? undefined : 'dialog'}
      aria-expanded={onShowActions === undefined ? undefined : (actionsOpen ?? false)}
      onClick={() => onOpenSession?.(routeKey, focusPending)}
      onContextMenu={(event) => {
        if (onShowActions === undefined) return
        event.preventDefault()
        onShowActions()
      }}
    >
      <span
        className={`session-card__dot session-card__dot--${session.bucket}`}
        aria-hidden="true"
      />
      <span className="session-card__main">
        <span className="session-card__topline">
          <span className="session-card__title">{session.title}</span>
          <span className="session-card__time">{formatUpdatedAt(session.updatedAt)}</span>
        </span>
        <span className="session-card__meta">
          <span className="session-card__agent">{agent}</span>
          <span className="session-card__workspace">{session.workspaceName}</span>
        </span>
        {(badges.length > 0 || hasDelivery) && (
          <span className="session-card__badges">
            {badges.map((badge) => (
              <span key={badge} className="session-badge">
                {badge}
              </span>
            ))}
            {hasDelivery && (
              <SessionDeliveryControls
                delivery={session.delivery}
                available={session.deliveryAvailable}
                starting={starting}
                onStartDelivery={() => onStartDelivery?.(session)}
                onOpenDelivery={() => onOpenDelivery?.(session)}
              />
            )}
          </span>
        )}
      </span>
    </button>
  )
}
