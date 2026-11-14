import type {
  MobileConfigOption,
  MobileSessionSummary,
  MobileUsage,
} from '@universe-editor/mobile-protocol'
import { Spinner } from '../components/Spinner.js'
import type { SocketState } from '../socket/mobileSocket.js'
import { statusText } from '../components/StatusBar.js'
import { strings } from '../strings.js'
import { ContextUsageMeter } from './ContextUsageMeter.js'

export interface SessionHeaderProps {
  readonly summary: MobileSessionSummary | undefined
  readonly configOptions?: readonly MobileConfigOption[] | undefined
  readonly usage?: MobileUsage | undefined
  readonly socketState: SocketState
  readonly online: boolean
  readonly busyConfigId?: string | undefined
  /** Effective subagent model; absent until the settings query has loaded. */
  readonly subagentValue?: string | undefined
  readonly onOpenSubagent?: (() => void) | undefined
  /** `<enabled>/<pool>` once the settings query has loaded. */
  readonly mcpValue?: string | undefined
  readonly onOpenMcp?: (() => void) | undefined
  /** Parent session title when this session is a side task. */
  readonly parentTitle?: string | undefined
  readonly onOpenParent?: (() => void) | undefined
  /** Opens the trigger-run report; absent for sessions no trigger started. */
  readonly onOpenReport?: (() => void) | undefined
  readonly onBack: () => void
  readonly onOpenConfig: (configOptionId: string) => void
  readonly onToggleBoolean: (option: MobileConfigOption) => void
  readonly onOpenMenu: () => void
}

export function SessionHeader({
  summary,
  configOptions,
  usage,
  socketState,
  online,
  busyConfigId,
  subagentValue,
  onOpenSubagent,
  mcpValue,
  onOpenMcp,
  parentTitle,
  onOpenParent,
  onOpenReport,
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
              <ContextUsageMeter usage={usage} />
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
              {onOpenReport !== undefined && (
                <button
                  type="button"
                  className="session-parent-chip"
                  data-testid="session-report"
                  disabled={!online}
                  onClick={onOpenReport}
                >
                  {strings.sessionReportAction}
                </button>
              )}
            </>
          )}
          {summary === undefined && socketState !== 'connected' && (
            <span className="session-header__status">{statusText(socketState)}</span>
          )}
        </div>
        {(options.length > 0 || onOpenSubagent !== undefined || onOpenMcp !== undefined) && (
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
                  className="config-chip"
                  data-testid="config-chip"
                  data-config-id={option.id}
                  aria-label={strings.configOpen(option.name)}
                  disabled={!online || busyConfigId === option.id}
                  onClick={() => onOpenConfig(option.id)}
                >
                  <span className="config-chip__name">{option.name}</span>
                  <span className="config-chip__value">{option.currentValue}</span>
                </button>
              ),
            )}
            {onOpenSubagent !== undefined && (
              <button
                type="button"
                className="config-chip"
                data-testid="subagent-chip"
                aria-label={strings.subagentChipOpen}
                disabled={!online}
                onClick={onOpenSubagent}
              >
                <span className="config-chip__name">{strings.subagentChipLabel}</span>
                {subagentValue !== undefined && (
                  <span className="config-chip__value">{subagentValue}</span>
                )}
              </button>
            )}
            {onOpenMcp !== undefined && (
              <button
                type="button"
                className="config-chip"
                data-testid="mcp-chip"
                aria-label={strings.mcpChipOpen}
                disabled={!online}
                onClick={onOpenMcp}
              >
                <span className="config-chip__name">{strings.mcpChipLabel}</span>
                {mcpValue !== undefined && <span className="config-chip__value">{mcpValue}</span>}
              </button>
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
