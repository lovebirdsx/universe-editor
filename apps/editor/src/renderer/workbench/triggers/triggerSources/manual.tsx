/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Manual trigger source: no parameters; runs only on an explicit run-now event.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import {
  summarizeTriggerSource,
  triggerSourceLabel,
} from '../../../services/triggers/triggerPresentation.js'
import type { TriggerSourceConfig } from '../../../../shared/triggers/types.js'
import type { TriggerSourceDescriptor, TriggerSourceFormProps } from './types.js'
import styles from './sourceForms.module.css'

function ManualSourceForm(_props: TriggerSourceFormProps) {
  return (
    <p className={styles['note']}>
      {localize(
        'trigger.manager.config.source.manualNote',
        'Runs only when started manually (or by another command).',
      )}
    </p>
  )
}

export const manualTriggerSource: TriggerSourceDescriptor = {
  type: 'manual',
  label: triggerSourceLabel('manual'),
  summary: summarizeTriggerSource,
  empty: () => ({ type: 'manual' }),
  fromConfig: () => ({ type: 'manual' }),
  build: () => ({ type: 'manual' }),
  Form: ManualSourceForm,
}

/** Kept for the descriptor registry's config type narrowing. */
export type ManualSourceConfig = Extract<TriggerSourceConfig, { type: 'manual' }>
