/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Modal shell for view-level dialogs: focus trap, Escape / backdrop dismissal and
 *  the backdrop + centered dialog surface. Content and footer are provided by the
 *  caller; no host services are involved.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import { cx } from '../atoms/cx.js'
import { FocusScopeOverlay } from './FocusScopeOverlay.js'
import styles from './ModalShell.module.css'

export interface ModalShellProps {
  readonly title: string
  readonly ariaLabel?: string | undefined
  /** Called for Escape, the backdrop and the header close action. */
  readonly onDismiss: () => void
  /** Suppresses dismissal while a destructive async operation is running. */
  readonly dismissDisabled?: boolean | undefined
  readonly footer?: ReactNode
  readonly children: ReactNode
  readonly className?: string | undefined
  readonly 'data-testid'?: string
}

export function ModalShell({
  title,
  ariaLabel,
  onDismiss,
  dismissDisabled = false,
  footer,
  children,
  className,
  'data-testid': testId,
}: ModalShellProps) {
  const dismiss = (): void => {
    if (!dismissDisabled) onDismiss()
  }
  return (
    <FocusScopeOverlay visible onEscape={dismiss}>
      <div className={styles['backdrop']} onClick={dismiss} />
      <div
        className={cx(styles['dialog'], className)}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        data-testid={testId}
      >
        <h2 className={styles['title']}>{title}</h2>
        {children}
        {footer !== undefined && <div className={styles['actions']}>{footer}</div>}
      </div>
    </FocusScopeOverlay>
  )
}
