import { cx } from './cx.js'
import styles from './Toggle.module.css'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  className?: string | undefined
  'aria-label'?: string
  'data-testid'?: string
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      className={cx(
        styles['toggle'],
        checked && styles['on'],
        disabled && styles['disabled'],
        className,
      )}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className={styles['thumb']} aria-hidden="true" />
    </button>
  )
}
