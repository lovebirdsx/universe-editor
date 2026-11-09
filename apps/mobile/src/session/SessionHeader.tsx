import type { MobileConfigOption, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { Spinner } from '../components/Spinner.js'
import type { SocketState } from '../socket/mobileSocket.js'
import { statusText } from '../components/StatusBar.js'
import { strings } from '../strings.js'

export interface SessionHeaderProps {
  readonly summary: MobileSessionSummary | undefined
  readonly configOptions?: readonly MobileConfigOption[] | undefined
  readonly socketState: SocketState
  readonly online: boolean
  readonly busyConfigId?: string | undefined
  /** Parent session title when this session is a side task. */
  readonly parentTitle?: string | undefined
  readonly onOpenParent?: (() => void) | undefined
  readonly onBack: () => void
  readonly onOpenConfig: (configOptionId: string) => void
  readonly onToggleBoolean: (option: MobileConfigOption) => void
  readonly onOpenMenu: () => void
}

export function SessionHeader({
  summary,
  configOptions,
  socketState,
  online,
  busyConfigId,
  parentTitle,
  onOpenParent,
  onBack,
  onOpenConfig,
  onToggleBoolean,
  onOpenMenu,
}: SessionHeaderProps) {
  const running = summary?.bucket === 'in_progress'
  const options = configOptions ?? []
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
        <div className="session-header__topline">
          <h1 className="session-header__title">{summary?.title ?? strings.sessionLoading}</h1>
          {summary !== undefined && (
            <button
              type="button"
              className="session-header__more"
              aria-label={strings.sessionMore}
              data-testid="session-more"
              onClick={onOpenMenu}
            >
              ⋯
            </button>
          )}
        </div>
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
              {parentTitle !== undefined && (
                <button
                  type="button"
                  className="session-parent-chip"
                  data-testid="session-parent-chip"
                  onClick={onOpenParent}
                >
                  {strings.sideTaskParent(parentTitle)}
                </button>
              )}
            </>
          )}
          {summary === undefined && socketState !== 'connected' && (
            <span className="session-header__status">{statusText(socketState)}</span>
          )}
        </div>
        {options.length > 0 && (
          <div className="session-header__config" data-testid="config-options">
            {options.map((option) =>
              option.type === 'boolean' ? (
                <button
                  key={option.id}
                  type="button"
                  role="switch"
                  aria-checked={option.currentValue === 'On'}
                  aria-label={option.name}
                  className="config-chip config-chip--switch"
                  data-testid="config-switch"
                  data-config-id={option.id}
                  disabled={!online || busyConfigId === option.id}
                  onClick={() => onToggleBoolean(option)}
                >
                  <span className="config-chip__name">{option.name}</span>
                  <span
                    className={`config-chip__switch${
                      option.currentValue === 'On' ? ' config-chip__switch--on' : ''
                    }`}
                    aria-hidden="true"
                  >
                    <span className="config-chip__knob" />
                  </span>
                </button>
              ) : (
                <button
                  key={option.id}
                  type="button"
                  className={`config-chip${option.allowedOnMobile ? '' : ' config-chip--blocked'}`}
                  data-testid="config-chip"
                  data-config-id={option.id}
                  aria-label={strings.configOpen(option.name)}
                  title={option.allowedOnMobile ? undefined : strings.configNeedsPc}
                  disabled={!online || busyConfigId === option.id}
                  onClick={() => onOpenConfig(option.id)}
                >
                  <span className="config-chip__name">{option.name}</span>
                  <span className="config-chip__value">{option.currentValue}</span>
                  {!option.allowedOnMobile && (
                    <span className="config-chip__blocked">{strings.configNeedsPc}</span>
                  )}
                </button>
              ),
            )}
          </div>
        )}
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
