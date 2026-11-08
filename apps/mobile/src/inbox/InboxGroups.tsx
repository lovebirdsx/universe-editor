import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { sessionRouteKey } from '../state/refs.js'
import { strings } from '../strings.js'
import { formatUpdatedAt, groupSessions } from './groupSessions.js'

export interface InboxGroupsProps {
  readonly sessions: readonly MobileSessionSummary[]
  readonly onOpenSession?: ((sessionKey: string) => void) | undefined
  /** The PC is offline / reconnecting: keep the list visible but de-emphasised. */
  readonly stale?: boolean | undefined
}

export function InboxGroups({ sessions, onOpenSession, stale }: InboxGroupsProps) {
  const groups = groupSessions(sessions)
  if (groups.length === 0) return null

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
            {group.sessions.map((session) => (
              <li key={sessionRouteKey(session.ref)}>
                <SessionRow
                  session={session}
                  onOpenSession={onOpenSession}
                  disabled={stale === true}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

interface SessionRowProps {
  readonly session: MobileSessionSummary
  readonly onOpenSession?: ((sessionKey: string) => void) | undefined
  readonly disabled: boolean
}

function SessionRow({ session, onOpenSession, disabled }: SessionRowProps) {
  const routeKey = sessionRouteKey(session.ref)
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
      onClick={() => onOpenSession?.(routeKey)}
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
