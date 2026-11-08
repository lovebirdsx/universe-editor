import { useEffect } from 'react'
import { Spinner } from '../components/Spinner.js'
import { sessionRouteKey } from '../state/refs.js'
import type { MobileClient } from '../state/mobileClient.js'
import { useStore } from '../state/useStore.js'
import { strings } from '../strings.js'
import { PendingActionCard } from './PendingActionCard.js'
import { PlanPanel } from './PlanPanel.js'
import { SessionHeader } from './SessionHeader.js'
import { Timeline } from './Timeline.js'

export interface SessionPageProps {
  readonly client: MobileClient
  readonly sessionKey: string
  readonly onBack: () => void
}

export function SessionPage({ client, sessionKey, onBack }: SessionPageProps) {
  useEffect(() => {
    client.openSession(sessionKey)
    return () => client.closeSession()
  }, [client, sessionKey])

  const state = useStore(client.getSessionStore())
  const socketState = useStore(client.getSocketStateStore())
  const activeSessionKey = state.ref === undefined ? sessionKey : sessionRouteKey(state.ref)

  if (state.removed) {
    return (
      <div className="session-page">
        <SessionHeader summary={state.summary} socketState={socketState} onBack={onBack} />
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

  return (
    <div className="session-page">
      <SessionHeader summary={state.summary} socketState={socketState} onBack={onBack} />
      {state.summary === undefined ? (
        <main className="session-loading">
          <Spinner />
          <p className="muted">{strings.sessionLoading}</p>
        </main>
      ) : (
        <>
          <PlanPanel plan={state.plan} />
          <Timeline
            sessionKey={activeSessionKey}
            timeline={state.timeline}
            truncated={state.truncated}
            client={client}
          />
          <div className="session-footer">
            {permission !== undefined && (
              <PendingActionCard
                kind="permission"
                title={strings.pendingPermissionTitle(permission.title)}
                options={permission.options.map((option) => ({
                  optionId: option.optionId,
                  name: option.name,
                }))}
              />
            )}
            {elicitation !== undefined && (
              <PendingActionCard
                kind="elicitation"
                title={strings.pendingElicitationTitle(elicitation.title)}
                message={elicitation.message}
              />
            )}
            <div className="composer">
              <input
                className="composer__input"
                type="text"
                disabled
                aria-label={strings.composerPlaceholder}
                placeholder={strings.composerPlaceholder}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
