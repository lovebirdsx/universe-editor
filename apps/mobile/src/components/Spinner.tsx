import { strings } from '../strings.js'

export interface SpinnerProps {
  readonly label?: string
  readonly size?: 'small'
}

export function Spinner({ label, size }: SpinnerProps) {
  return (
    <span
      className={size === 'small' ? 'spinner spinner--small' : 'spinner'}
      role="status"
      aria-label={label ?? strings.statusConnecting}
    />
  )
}
