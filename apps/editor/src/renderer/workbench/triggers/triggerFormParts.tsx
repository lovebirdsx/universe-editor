/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Thin editor-side wrappers over the workbench-ui form primitives, plus the
 *  trigger-specific toggle row and the shared error message helper.
 *--------------------------------------------------------------------------------------------*/

import { FormField, FormSection, Toggle } from '@universe-editor/workbench-ui'
import styles from './triggerFormParts.module.css'

export { FormField as Field, FormSection }

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
    <FormField label={label}>
      <div className={styles['toggleField']}>
        <Toggle checked={checked} onChange={onChange} aria-label={label} data-testid={testId} />
      </div>
    </FormField>
  )
}
