/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Event trigger source: an editor-pushed event name (currently Swarm reviews).
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { FormField, Select } from '@universe-editor/workbench-ui'
import {
  summarizeTriggerSource,
  triggerEventLabel,
  triggerSourceLabel,
} from '../../../services/triggers/triggerPresentation.js'
import {
  TRIGGER_EVENT_NAMES,
  type TriggerEventName,
  type TriggerSourceConfig,
} from '../../../../shared/triggers/types.js'
import type { TriggerSourceDescriptor, TriggerSourceFormProps } from './types.js'
import styles from './sourceForms.module.css'

type EventDraft = Extract<TriggerSourceFormProps['draft'], { type: 'event' }>

function eventDraft(props: TriggerSourceFormProps): EventDraft | undefined {
  return props.draft.type === 'event' ? props.draft : undefined
}

const DEFAULT_EVENT: TriggerEventName = TRIGGER_EVENT_NAMES[0] ?? 'swarm.reviewNeedsAction'

function EventSourceForm(props: TriggerSourceFormProps) {
  const { update, fieldError, testIdPrefix } = props
  const draft = eventDraft(props)
  if (draft === undefined) return null
  return (
    <>
      <FormField
        label={localize('trigger.manager.config.event.name', 'Event')}
        error={fieldError('source.event')}
      >
        <Select<TriggerEventName>
          value={draft.eventName}
          onChange={(eventName) => update({ eventName })}
          options={TRIGGER_EVENT_NAMES.map((eventName) => ({
            value: eventName,
            label: triggerEventLabel(eventName),
          }))}
          aria-label={localize('trigger.manager.config.event.name', 'Event')}
          data-testid={`${testIdPrefix}-event`}
        />
      </FormField>
      <p className={styles['note']}>
        {localize(
          'trigger.manager.config.source.swarmNote',
          'Runs once for every Swarm review that needs action.',
        )}
      </p>
    </>
  )
}

export const eventTriggerSource: TriggerSourceDescriptor = {
  type: 'event',
  label: triggerSourceLabel('event'),
  summary: summarizeTriggerSource,
  empty: () => ({ type: 'event', eventName: DEFAULT_EVENT }),
  fromConfig: (source) =>
    source.type === 'event'
      ? { type: 'event', eventName: source.event }
      : { type: 'event', eventName: DEFAULT_EVENT },
  build: (draft) => ({
    type: 'event',
    event: draft.type === 'event' ? draft.eventName : DEFAULT_EVENT,
  }),
  Form: EventSourceForm,
}

export type EventSourceConfig = Extract<TriggerSourceConfig, { type: 'event' }>
