import { useEffect, useRef, type ReactNode } from 'react'
import { cx } from './cx.js'
import styles from './Checkbox.module.css'

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  indeterminate?: boolean
  className?: string
  'data-testid'?: string
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  indeterminate = false,
  className,
  'data-testid': testId,
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label className={cx(styles['wrapper'], disabled && styles['disabled'], className)}>
      <input
        ref={ref}
        type="checkbox"
        className={styles['box']}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      {label}
    </label>
  )
}
