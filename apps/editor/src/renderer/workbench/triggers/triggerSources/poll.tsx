/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Command-poll trigger source: interval, shell command, timeout and key field.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { FormField, Input } from '@universe-editor/workbench-ui'
import {
  summarizeTriggerSource,
  triggerSourceLabel,
} from '../../../services/triggers/triggerPresentation.js'
import type { TriggerSourceConfig } from '../../../../shared/triggers/types.js'
import type { TriggerSourceDescriptor, TriggerSourceFormProps } from './types.js'
import styles from './sourceForms.module.css'

type PollDraft = Extract<TriggerSourceFormProps['draft'], { type: 'poll' }>

function pollDraft(props: TriggerSourceFormProps): PollDraft | undefined {
  return props.draft.type === 'poll' ? props.draft : undefined
}

function PollSourceForm(props: TriggerSourceFormProps) {
  const { update, fieldError, testIdPrefix } = props
  const draft = pollDraft(props)
  if (draft === undefined) return null
  return (
    <>
      <div className={styles['row']}>
        <FormField
          label={localize('trigger.manager.config.poll.interval', 'Poll interval (seconds)')}
          error={fieldError('source.intervalSec')}
        >
          <Input
            type="number"
            min={30}
            value={draft.intervalSec}
            invalid={fieldError('source.intervalSec') !== undefined}
            onChange={(event) => update({ intervalSec: event.target.value })}
            data-testid={`${testIdPrefix}-poll-interval`}
          />
        </FormField>
        <FormField
          label={localize('trigger.manager.config.poll.timeout', 'Command timeout (seconds)')}
          error={fieldError('source.fetch.timeoutSec')}
        >
          <Input
            type="number"
            min={1}
            max={600}
            value={draft.pollTimeoutSec}
            invalid={fieldError('source.fetch.timeoutSec') !== undefined}
            onChange={(event) => update({ pollTimeoutSec: event.target.value })}
            data-testid={`${testIdPrefix}-poll-timeout`}
          />
        </FormField>
      </div>
      <FormField
        label={localize('trigger.manager.config.poll.command', 'Command (prints a JSON array)')}
        error={fieldError('source.fetch.command')}
      >
        <Input
          value={draft.command}
          invalid={fieldError('source.fetch.command') !== undefined}
          onChange={(event) => update({ command: event.target.value })}
          data-testid={`${testIdPrefix}-poll-command`}
        />
      </FormField>
      <FormField
        label={localize('trigger.manager.config.poll.keyField', 'Event key field')}
        error={fieldError('source.keyField')}
      >
        <Input
          value={draft.keyField}
          invalid={fieldError('source.keyField') !== undefined}
          onChange={(event) => update({ keyField: event.target.value })}
          data-testid={`${testIdPrefix}-poll-key-field`}
        />
      </FormField>
    </>
  )
}

export const pollTriggerSource: TriggerSourceDescriptor = {
  type: 'poll',
  label: triggerSourceLabel('poll'),
  summary: summarizeTriggerSource,
  empty: () => ({
    type: 'poll',
    intervalSec: '600',
    command: '',
    pollTimeoutSec: '60',
    keyField: 'id',
  }),
  fromConfig: (source) =>
    source.type === 'poll'
      ? {
          type: 'poll',
          intervalSec: String(source.intervalSec),
          command: source.fetch.command,
          pollTimeoutSec: String(source.fetch.timeoutSec),
          keyField: source.keyField,
        }
      : { type: 'poll', intervalSec: '600', command: '', pollTimeoutSec: '60', keyField: 'id' },
  build: (draft) =>
    draft.type !== 'poll'
      ? {
          type: 'poll',
          intervalSec: 600,
          fetch: { type: 'command', command: '', timeoutSec: 60 },
          keyField: 'id',
        }
      : {
          type: 'poll',
          intervalSec: Number(
            draft.intervalSec.trim().length === 0 ? Number.NaN : draft.intervalSec,
          ),
          fetch: {
            type: 'command',
            command: draft.command,
            timeoutSec: Number(
              draft.pollTimeoutSec.trim().length === 0 ? Number.NaN : draft.pollTimeoutSec,
            ),
          },
          keyField: draft.keyField,
        },
  Form: PollSourceForm,
}

export type PollSourceConfig = Extract<TriggerSourceConfig, { type: 'poll' }>
