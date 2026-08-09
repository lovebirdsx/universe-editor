import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx.js'
import styles from './IconButton.module.css'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: drives both aria-label and the tooltip. */
  label: string
  /**
   * Command the button triggers. Sets `data-tooltip-command` so the tooltip
   * shows the command's effective keybinding ("Label (Ctrl+…)").
   */
  command?: string
  /** Square edge length in px. Defaults to 22 (workbench toolbar standard). */
  size?: number
  /** Selected/active visual state (independent of aria-expanded). */
  active?: boolean
  /** The icon element. The library never depends on an icon set. */
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, command, size = 22, active = false, className, style, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      data-tooltip={label}
      data-tooltip-command={command}
      className={cx(styles['iconButton'], active && styles['active'], className)}
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      {children}
    </button>
  )
})
