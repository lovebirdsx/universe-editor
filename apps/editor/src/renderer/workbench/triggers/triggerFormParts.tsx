/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Small form pieces shared by the trigger configuration form and the create
 *  wizard. Kept out of workbench-ui because the labels / error wording are
 *  trigger-specific, not generic controls.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import { localize } from '@universe-editor/platform'
import { Toggle } from '@universe-editor/workbench-ui'
import type { TriggerActionType } from '../../../shared/triggers/types.js'
import styles from './TriggerManager.module.css'

export const ACTION_LABELS: Readonly<Record<TriggerActionType, string>> = {
  'swarm.vote': localize('trigger.manager.config.action.vote', 'Vote on Swarm reviews'),
  'swarm.comment': localize('trigger.manager.config.action.comment', 'Comment on Swarm reviews'),
  'swarm.approve': localize('trigger.manager.config.action.approve', 'Approve Swarm reviews'),
}

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
