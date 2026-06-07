import type { ReactNode } from 'react'
import { cx } from './cx.js'
import styles from './Badge.module.css'

export interface BadgeProps {
  children: ReactNode
  tone?: 'default' | 'accent'
  className?: string
}

export function Badge({ children, tone = 'default', className }: BadgeProps) {
  return <span className={cx(styles['badge'], styles[tone], className)}>{children}</span>
}
