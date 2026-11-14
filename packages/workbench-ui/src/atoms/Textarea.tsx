import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cx } from './cx.js'
import styles from './Textarea.module.css'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className, rows = 4, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      spellCheck={false}
      className={cx(styles['textarea'], invalid && styles['invalid'], className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  )
})
