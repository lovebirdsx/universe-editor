import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx.js'
import { Spinner } from './Spinner.js'
import styles from './Button.module.css'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md'
  busy?: boolean
  children: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', busy = false, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(styles['button'], styles[variant], styles[size], className)}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <Spinner size={12} />}
      {children}
    </button>
  )
})
