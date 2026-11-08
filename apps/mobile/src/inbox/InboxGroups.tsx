import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { strings } from '../strings.js'
import { formatUpdatedAt, groupSessions } from './groupSessions.js'

export interface InboxGroupsProps {
  readonly sessions: readonly MobileSessionSummary[]
}

/**
 * Group skeleton for M1. The gateway always returns an empty snapshot today;
 * M2 supplies real rows and this component stays the same.
 */
export function InboxGroups({ sessions }: InboxGroupsProps) {
  const groups = groupSessions(sessions)
  if (groups.length === 0) return null

  return (
    <div className="inbox-groups">
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
              <li key={sessionKey(session)} className="session-card">
                <div className="session-card__topline">
                  <span className="session-card__title">{session.title}</span>
                  <span className="session-card__time">{formatUpdatedAt(session.updatedAt)}</span>
                </div>
                <div className="session-card__meta">
                  <span>
                    {strings.agentLabel}: {session.agentId}
                  </span>
                  <span>
                    {strings.workspaceLabel}: {session.workspaceName}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function sessionKey(session: MobileSessionSummary): string {
  return session.ref.durableId ?? `${session.ref.windowId}:${session.ref.localId}`
}
