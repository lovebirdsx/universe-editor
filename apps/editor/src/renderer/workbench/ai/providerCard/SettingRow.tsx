/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SettingRow — one provider setting on one line: label on the left, control on
 *  the right, and whatever the field needs to say underneath the control.
 *
 *  The label column has a fixed width so every row in a card lines up on the same
 *  edge; when the card itself gets too narrow for that (the settings editor's
 *  panel is resizable) the grid collapses to a single column and the row goes back
 *  to being stacked, which is the only layout that still fits.
 *
 *  The "Saved" flag belongs next to the label rather than the control: a commit
 *  can land while the control is mid-interaction, and the label is the one part
 *  of the row that never moves.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import { SavedIndicator } from './SavedIndicator.js'
import type { SavedStamp } from './useProviderField.js'
import styles from '../AiSettingsEditor.module.css'

export interface SettingRowProps {
  readonly label: string
  readonly control: ReactNode
  /** Rendered under the control — inheritance notes, hints, validation messages. */
  readonly note?: ReactNode
  readonly saved?: SavedStamp | undefined
  /** Field name the "Saved" flag matches on; omit to render no flag. */
  readonly field?: string | undefined
  readonly className?: string | undefined
  readonly testId?: string | undefined
}

export function SettingRow({
  label,
  control,
  note,
  saved,
  field,
  className,
  testId,
}: SettingRowProps) {
  const rowClass =
    className === undefined ? styles['settingRow'] : `${styles['settingRow']} ${className}`
  return (
    <div className={rowClass} {...(testId !== undefined ? { 'data-testid': testId } : {})}>
      <div className={styles['settingRowLabel']}>
        <span className={styles['label']}>{label}</span>
        {field !== undefined && <SavedIndicator saved={saved} field={field} />}
      </div>
      <div className={styles['settingRowControl']}>
        {control}
        {note}
      </div>
    </div>
  )
}
