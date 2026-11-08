import type { MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { Spinner } from '../components/Spinner.js'
import type { SocketState } from '../socket/mobileSocket.js'
import { statusText } from '../components/StatusBar.js'
import { strings } from '../strings.js'

export interface SessionHeaderProps {
  readonly summary: MobileSessionSummary | undefined
  readonly socketState: SocketState
  readonly onBack: () => void
}

export function SessionHeader({ summary, socketState, onBack }: SessionHeaderProps) {
  const running = summary?.bucket === 'in_progress'
  return (
    <header className="session-header">
      <button
        type="button"
        className="session-header__back"
        aria-label={strings.sessionBack}
        onClick={onBack}
      >
        ‹
      </button>
      <div className="session-header__body">
        <h1 className="session-header__title">{summary?.title ?? strings.sessionLoading}</h1>
        <div className="session-header__meta">
          {summary !== undefined && (
            <>
              <span className="session-header__agent">{summary.agentName ?? summary.agentId}</span>
              {running ? (
                <span className="session-header__status session-header__status--running">
                  <Spinner label={strings.sessionRunning} size="small" />
                  {strings.sessionRunning}
                </span>
              ) : (
                <span className="session-header__status">{bucketText(summary)}</span>
              )}
              {summary.readOnly && (
                <span className="session-header__badge">{strings.badgeReadOnly}</span>
              )}
            </>
          )}
          {summary === undefined && socketState !== 'connected' && (
            <span className="session-header__status">{statusText(socketState)}</span>
          )}
        </div>
      </div>
    </header>
  )
}

function bucketText(summary: MobileSessionSummary): string {
  switch (summary.bucket) {
    case 'input_needed':
      return strings.bucketInputNeeded
    case 'in_progress':
      return strings.bucketInProgress
    case 'failed':
      return strings.bucketFailed
    case 'completed':
      return strings.bucketCompleted
  }
}
