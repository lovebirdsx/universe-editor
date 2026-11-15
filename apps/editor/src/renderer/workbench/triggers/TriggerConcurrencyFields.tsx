/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-trigger concurrency / overflow block shared by the configuration panel and
 *  the create wizard.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { FormField, Input, Select } from '@universe-editor/workbench-ui'
import type { TriggerOverflow } from '../../../shared/triggers/types.js'
import type { TriggerConfigDraft } from './triggerConfigDraft.js'
import styles from './TriggerFields.module.css'

export interface TriggerConcurrencyFieldsProps {
  readonly draft: TriggerConfigDraft
  readonly update: (patch: Partial<TriggerConfigDraft>) => void
  readonly fieldError: (...paths: string[]) => string | undefined
  readonly testIdPrefix: string
}

export function TriggerConcurrencyFields({
  draft,
  update,
  fieldError,
  testIdPrefix,
}: TriggerConcurrencyFieldsProps) {
  return (
    <div className={styles['row']}>
      <FormField
        label={localize('trigger.manager.config.concurrency', 'Concurrency')}
        error={fieldError('concurrency')}
        hint={localize('trigger.manager.config.concurrencyHint', '1–10')}
      >
        <Input
          type="number"
          min={1}
          max={10}
          value={draft.concurrency}
          invalid={fieldError('concurrency') !== undefined}
          onChange={(event) => update({ concurrency: event.target.value })}
          data-testid={`${testIdPrefix}-concurrency`}
        />
      </FormField>
      <FormField
        label={localize('trigger.manager.config.overflow', 'When busy')}
        error={fieldError('overflow')}
      >
        <Select<TriggerOverflow>
          value={draft.overflow}
          onChange={(overflow) => update({ overflow })}
          options={[
            { value: 'queue', label: localize('trigger.manager.config.overflow.queue', 'Queue') },
            { value: 'drop', label: localize('trigger.manager.config.overflow.drop', 'Drop') },
          ]}
          aria-label={localize('trigger.manager.config.overflow', 'When busy')}
          data-testid={`${testIdPrefix}-overflow`}
        />
      </FormField>
    </div>
  )
}
