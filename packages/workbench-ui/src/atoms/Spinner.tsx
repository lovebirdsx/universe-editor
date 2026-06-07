import type { CSSProperties } from 'react'
import { cx } from './cx.js'
import styles from './Spinner.module.css'

export interface SpinnerProps {
  size?: number
  className?: string
  style?: CSSProperties
}

export function Spinner({ size = 16, className, style }: SpinnerProps) {
  return (
    <span
      className={cx(styles['spinner'], className)}
      style={{ width: size, height: size, ...style }}
      role="status"
      aria-label="Loading"
    />
  )
}
