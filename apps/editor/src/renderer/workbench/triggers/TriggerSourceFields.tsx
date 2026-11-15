/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Source block shared by the configuration panel and the create wizard: the
 *  type selector plus the form contributed by that type's descriptor.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { FormField, Select } from '@universe-editor/workbench-ui'
import type { TriggerSourceType } from '../../../shared/triggers/types.js'
import type { TriggerSourceDraft, TriggerSourceDraftPatch } from './triggerSources/types.js'
import { TRIGGER_SOURCE_ORDER, triggerSourceDescriptor } from './triggerSources/index.js'

export interface TriggerSourceFieldsProps {
  readonly source: TriggerSourceDraft
  readonly setSourceType: (type: TriggerSourceType) => void
  readonly updateSource: (patch: TriggerSourceDraftPatch) => void
  readonly fieldError: (...paths: string[]) => string | undefined
  readonly testIdPrefix: string
}

export function TriggerSourceFields({
  source,
  setSourceType,
  updateSource,
  fieldError,
  testIdPrefix,
}: TriggerSourceFieldsProps) {
  const descriptor = triggerSourceDescriptor(source.type)
  return (
    <>
      <FormField
        label={localize('trigger.manager.config.sourceType', 'Type')}
        error={fieldError('source.type')}
      >
        <Select<TriggerSourceType>
          value={source.type}
          onChange={setSourceType}
          options={TRIGGER_SOURCE_ORDER.map((type) => ({
            value: type,
            label: triggerSourceDescriptor(type).label,
          }))}
          aria-label={localize('trigger.manager.config.sourceType', 'Type')}
          data-testid={`${testIdPrefix}-source-type`}
        />
      </FormField>
      <descriptor.Form
        draft={source}
        update={updateSource}
        fieldError={fieldError}
        testIdPrefix={testIdPrefix}
      />
    </>
  )
}
