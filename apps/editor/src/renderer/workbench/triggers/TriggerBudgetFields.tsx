/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Budget block (cost / active-time / approval-time limits) shared by the
 *  configuration panel and the create wizard.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { FormField, Input } from '@universe-editor/workbench-ui'
import type { TriggerConfigDraft } from './triggerConfigDraft.js'
import styles from './TriggerFields.module.css'

export interface TriggerBudgetFieldsProps {
  readonly draft: TriggerConfigDraft
  readonly update: (patch: Partial<TriggerConfigDraft>) => void
  readonly fieldError: (...paths: string[]) => string | undefined
  readonly testIdPrefix: string
}

export function TriggerBudgetFields({
  draft,
  update,
  fieldError,
  testIdPrefix,
}: TriggerBudgetFieldsProps) {
  return (
    <>
      <FormField
        label={localize('trigger.manager.config.budget.maxCost', 'Maximum cost (USD)')}
        error={fieldError('session.budget.maxCostUsd')}
        hint={localize('trigger.manager.config.budget.maxCostHint', 'Empty = no cost limit.')}
      >
        <Input
          type="number"
          min={0}
          step="0.01"
          value={draft.maxCostUsd}
          invalid={fieldError('session.budget.maxCostUsd') !== undefined}
          onChange={(event) => update({ maxCostUsd: event.target.value })}
          data-testid={`${testIdPrefix}-max-cost`}
        />
      </FormField>
      <div className={styles['row']}>
        <FormField
          label={localize('trigger.manager.config.budget.timeout', 'Run timeout (minutes)')}
          error={fieldError('session.budget.timeoutMin')}
        >
          <Input
            type="number"
            min={1}
            value={draft.timeoutMin}
            invalid={fieldError('session.budget.timeoutMin') !== undefined}
            onChange={(event) => update({ timeoutMin: event.target.value })}
            data-testid={`${testIdPrefix}-timeout`}
          />
        </FormField>
        <FormField
          label={localize(
            'trigger.manager.config.budget.approvalTimeout',
            'Approval timeout (minutes)',
          )}
          error={fieldError('session.budget.approvalTimeoutMin')}
        >
          <Input
            type="number"
            min={1}
            value={draft.approvalTimeoutMin}
            invalid={fieldError('session.budget.approvalTimeoutMin') !== undefined}
            onChange={(event) => update({ approvalTimeoutMin: event.target.value })}
            data-testid={`${testIdPrefix}-approval-timeout`}
          />
        </FormField>
      </div>
    </>
  )
}
