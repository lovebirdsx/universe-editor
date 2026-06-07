import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx.js'
import styles from './IconButton.module.css'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: drives both aria-label and the native title tooltip. */
  label: string
  /** Square edge length in px. Defaults to 22 (workbench toolbar standard). */
  size?: number
  /** Selected/active visual state (independent of aria-expanded). */
  active?: boolean
  /** The icon element. The library never depends on an icon set. */
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 22, active = false, className, style, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cx(styles['iconButton'], active && styles['active'], className)}
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      {children}
    </button>
  )
})
