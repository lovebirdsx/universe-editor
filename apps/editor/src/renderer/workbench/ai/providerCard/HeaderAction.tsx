/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HeaderAction — a clickable affordance inside a card header. It cannot be a
 *  <button>: the header itself is one, and nesting them is invalid HTML that React
 *  will render but the browser will re-parent. Shared by the provider entry cards
 *  and the model knowledge cards so both headers behave identically.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import styles from '../AiSettingsEditor.module.css'

export function HeaderAction({
  label,
  disabled = false,
  onTrigger,
  children,
}: {
  readonly label: string
  readonly disabled?: boolean
  readonly onTrigger: () => void
  readonly children: ReactNode
}) {
  const trigger = () => {
    if (!disabled) onTrigger()
  }
  return (
    <span
      className={styles['cardHeaderAction']}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-tooltip={label}
      onClick={(e) => {
        e.stopPropagation()
        trigger()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          trigger()
        }
      }}
    >
      {children}
    </span>
  )
}
