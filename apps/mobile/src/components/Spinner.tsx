import { strings } from '../strings.js'

export interface SpinnerProps {
  readonly label?: string
}

export function Spinner({ label }: SpinnerProps) {
  return <span className="spinner" role="status" aria-label={label ?? strings.statusConnecting} />
}
