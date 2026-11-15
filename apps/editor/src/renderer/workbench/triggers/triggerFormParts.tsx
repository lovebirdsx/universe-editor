/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Small form pieces shared by the trigger configuration form and the create
 *  wizard. Kept out of workbench-ui because the labels / error wording are
 *  trigger-specific, not generic controls.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import { Toggle } from '@universe-editor/workbench-ui'
import styles from './TriggerManager.module.css'

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  readonly label: string
  readonly error?: string | undefined
  readonly hint?: string | undefined
  readonly children: ReactNode
}) {
  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{label}</span>
      {children}
      {error !== undefined && <span className={styles['fieldError']}>{error}</span>}
      {error === undefined && hint !== undefined && (
        <span className={styles['fieldHint']}>{hint}</span>
      )}
    </div>
  )
}

export function ToggleField({
  label,
  checked,
  onChange,
  testId,
}: {
  readonly label: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly testId: string
}) {
  return (
    <div className={styles['toggleField']}>
      <span className={styles['fieldLabel']}>{label}</span>
      <Toggle checked={checked} onChange={onChange} aria-label={label} data-testid={testId} />
    </div>
  )
}
