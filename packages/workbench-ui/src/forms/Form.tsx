/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generic form layout pieces: one labelled field (label / control / error / hint)
 *  and a titled section. Pure presentation — no DI, no host services.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import { cx } from '../atoms/cx.js'
import styles from './Form.module.css'

export interface FormFieldProps {
  readonly label: string
  readonly error?: string | undefined
  readonly hint?: string | undefined
  readonly children: ReactNode
  readonly className?: string | undefined
  readonly 'data-testid'?: string
}

export function FormField({
  label,
  error,
  hint,
  children,
  className,
  'data-testid': testId,
}: FormFieldProps) {
  return (
    <div className={cx(styles['field'], className)} data-testid={testId}>
      <span className={styles['label']}>{label}</span>
      {children}
      {error !== undefined && <span className={styles['error']}>{error}</span>}
      {error === undefined && hint !== undefined && <span className={styles['hint']}>{hint}</span>}
    </div>
  )
}

export interface FormSectionProps {
  readonly title: string
  readonly children: ReactNode
  readonly actions?: ReactNode
  readonly className?: string | undefined
  readonly 'data-testid'?: string
}

export function FormSection({
  title,
  children,
  actions,
  className,
  'data-testid': testId,
}: FormSectionProps) {
  return (
    <section className={cx(styles['section'], className)} data-testid={testId}>
      <div className={styles['sectionHeader']}>
        <h3 className={styles['sectionTitle']}>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}
