/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Schedule trigger source: cron expression or fixed interval, plus missed-run policy.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { FormField, Input, Select } from '@universe-editor/workbench-ui'
import {
  summarizeTriggerSource,
  triggerSourceLabel,
} from '../../../services/triggers/triggerPresentation.js'
import type { TriggerOnMissed, TriggerSourceConfig } from '../../../../shared/triggers/types.js'
import type { TriggerSourceDescriptor, TriggerSourceFormProps } from './types.js'
import styles from './sourceForms.module.css'

type ScheduleDraft = Extract<TriggerSourceFormProps['draft'], { type: 'schedule' }>

function scheduleDraft(props: TriggerSourceFormProps): ScheduleDraft | undefined {
  return props.draft.type === 'schedule' ? props.draft : undefined
}

function ScheduleSourceForm(props: TriggerSourceFormProps) {
  const { update, fieldError, testIdPrefix } = props
  const draft = scheduleDraft(props)
  if (draft === undefined) return null
  const cronMode: 'cron' | 'everyMin' = draft.cron.trim().length > 0 ? 'cron' : 'everyMin'
  return (
    <>
      <div className={styles['row']}>
        <FormField
          label={localize('trigger.manager.config.schedule.mode', 'Schedule as')}
          error={fieldError('source.cron', 'source.everyMin')}
        >
          <Select<'cron' | 'everyMin'>
            value={cronMode}
            onChange={(mode) =>
              update(
                mode === 'cron'
                  ? {
                      cron: draft.cron.trim().length > 0 ? draft.cron : '0 9 * * 1',
                      everyMin: '',
                    }
                  : {
                      everyMin: draft.everyMin.trim().length > 0 ? draft.everyMin : '10',
                      cron: '',
                    },
              )
            }
            options={[
              { value: 'cron', label: localize('trigger.manager.config.schedule.cron', 'Cron') },
              {
                value: 'everyMin',
                label: localize('trigger.manager.config.schedule.interval', 'Interval'),
              },
            ]}
            aria-label={localize('trigger.manager.config.schedule.mode', 'Schedule as')}
            data-testid={`${testIdPrefix}-schedule-mode`}
          />
        </FormField>
        <FormField
          label={
            cronMode === 'cron'
              ? localize('trigger.manager.config.schedule.cronExpression', 'Cron expression')
              : localize('trigger.manager.config.schedule.everyMinutes', 'Every N minutes')
          }
          error={fieldError('source.cron', 'source.everyMin')}
        >
          {cronMode === 'cron' ? (
            <Input
              value={draft.cron}
              invalid={fieldError('source.cron') !== undefined}
              onChange={(event) => update({ cron: event.target.value })}
              data-testid={`${testIdPrefix}-cron`}
            />
          ) : (
            <Input
              type="number"
              min={1}
              value={draft.everyMin}
              invalid={fieldError('source.everyMin') !== undefined}
              onChange={(event) => update({ everyMin: event.target.value })}
              data-testid={`${testIdPrefix}-every-min`}
            />
          )}
        </FormField>
      </div>
      <FormField
        label={localize('trigger.manager.config.schedule.onMissed', 'On missed runs')}
        error={fieldError('source.onMissed')}
      >
        <Select<TriggerOnMissed>
          value={draft.onMissed}
          onChange={(onMissed) => update({ onMissed })}
          options={[
            { value: 'skip', label: localize('trigger.manager.source.onMissed.skip', 'skip') },
            {
              value: 'catch-up-once',
              label: localize('trigger.manager.source.onMissed.catchUpOnce', 'catch up once'),
            },
          ]}
          aria-label={localize('trigger.manager.config.schedule.onMissed', 'On missed runs')}
          data-testid={`${testIdPrefix}-on-missed`}
        />
      </FormField>
    </>
  )
}

export const scheduleTriggerSource: TriggerSourceDescriptor = {
  type: 'schedule',
  label: triggerSourceLabel('schedule'),
  summary: summarizeTriggerSource,
  empty: () => ({ type: 'schedule', cron: '0 9 * * 1', everyMin: '', onMissed: 'skip' }),
  fromConfig: (source) =>
    source.type === 'schedule'
      ? {
          type: 'schedule',
          cron: source.cron ?? '',
          everyMin: source.everyMin === undefined ? '' : String(source.everyMin),
          onMissed: source.onMissed,
        }
      : { type: 'schedule', cron: '', everyMin: '', onMissed: 'skip' },
  build: (draft) =>
    draft.type !== 'schedule'
      ? { type: 'schedule', cron: '0 9 * * 1', onMissed: 'skip' }
      : draft.cron.trim().length > 0
        ? { type: 'schedule', cron: draft.cron, onMissed: draft.onMissed }
        : {
            type: 'schedule',
            everyMin: Number(draft.everyMin.trim().length === 0 ? Number.NaN : draft.everyMin),
            onMissed: draft.onMissed,
          },
  Form: ScheduleSourceForm,
}

export type ScheduleSourceConfig = Extract<TriggerSourceConfig, { type: 'schedule' }>
