import type { SocketState } from '../socket/mobileSocket.js'
import { strings } from '../strings.js'

export function statusText(state: SocketState): string {
  switch (state) {
    case 'connected':
      return strings.statusConnected
    case 'reconnecting':
      return strings.statusReconnecting
    case 'invalid':
      return strings.statusInvalid
    case 'protocol_mismatch':
      return strings.statusVersionMismatch
    case 'connecting':
    default:
      return strings.statusConnecting
  }
}

export interface StatusBarProps {
  readonly pcName: string
  readonly state: SocketState
  readonly onOpenSettings: () => void
}

export function StatusBar({ pcName, state, onOpenSettings }: StatusBarProps) {
  return (
    <header className="status-bar">
      <div className="status-bar__identity">
        <span className="status-bar__pc-name">
          {pcName === '' ? strings.statusUnknownPc : pcName}
        </span>
        <span className={`status-bar__state status-bar__state--${state}`}>{statusText(state)}</span>
      </div>
      <button
        type="button"
        className="status-bar__settings"
        aria-label={strings.settings}
        onClick={onOpenSettings}
      >
        {strings.settings}
      </button>
    </header>
  )
}
