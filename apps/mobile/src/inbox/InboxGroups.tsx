import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { useEffect, useState } from 'react'
import { sessionRouteKey } from '../state/refs.js'
import { strings } from '../strings.js'
import { formatUpdatedAt, groupSessions } from './groupSessions.js'
import { SwipeableSessionRow } from './SwipeableSessionRow.js'

export interface InboxGroupsProps {
  readonly sessions: readonly MobileSessionSummary[]
  readonly onOpenSession?: ((sessionKey: string, focusPending: boolean) => void) | undefined
  readonly onCloseSession?: ((session: MobileSessionSummary) => void) | undefined
  readonly onRemoveSession?: ((session: MobileSessionSummary) => void) | undefined
  readonly onShowSessionActions?: ((session: MobileSessionSummary) => void) | undefined
  /** The PC is offline / reconnecting: keep the list visible but de-emphasised. */
  readonly stale?: boolean | undefined
}

export function InboxGroups({
  sessions,
  onOpenSession,
  onCloseSession,
  onRemoveSession,
  onShowSessionActions,
  stale,
}: InboxGroupsProps) {
  const groups = groupSessions(sessions)
  const [openKey, setOpenKey] = useState<string | undefined>(undefined)
  const actionsEnabled =
    onCloseSession !== undefined ||
    onRemoveSession !== undefined ||
    onShowSessionActions !== undefined

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
                      onOpenChange={(next) => setOpenKey(next ? key : undefined)}
                      onShowActions={() => runAction(session, onShowSessionActions)}
                      onCloseSession={() => runAction(session, onCloseSession)}
                      onRemoveSession={() => runAction(session, onRemoveSession)}
                    >
                      <SessionRow
                        session={session}
                        onOpenSession={onOpenSession}
                        disabled={stale === true}
                        actionsOpen={openKey === key}
                        onShowActions={() => runAction(session, onShowSessionActions)}
                      />
                    </SwipeableSessionRow>
                  ) : (
                    <SessionRow
                      session={session}
                      onOpenSession={onOpenSession}
                      disabled={stale === true}
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
  readonly onShowActions?: (() => void) | undefined
}

function SessionRow({
  session,
  onOpenSession,
  disabled,
  actionsOpen,
  onShowActions,
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
        {badges.length > 0 && (
          <span className="session-card__badges">
            {badges.map((badge) => (
              <span key={badge} className="session-badge">
                {badge}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  )
}
