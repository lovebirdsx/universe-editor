import { forwardRef, type InputHTMLAttributes } from 'react'
import { cx } from './cx.js'
import styles from './Input.module.css'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(styles['input'], invalid && styles['invalid'], className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  )
})
