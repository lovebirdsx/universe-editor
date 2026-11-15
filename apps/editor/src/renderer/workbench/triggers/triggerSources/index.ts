/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Source-type descriptor registry. Adding a new trigger source = add one
 *  descriptor file next to this one and one entry below; the configuration form,
 *  create wizard, draft mapping and source wording all follow from it.
 *--------------------------------------------------------------------------------------------*/

import type { TriggerSourceConfig, TriggerSourceType } from '../../../../shared/triggers/types.js'
import { eventTriggerSource } from './event.js'
import { manualTriggerSource } from './manual.js'
import { pollTriggerSource } from './poll.js'
import { scheduleTriggerSource } from './schedule.js'
import type { TriggerSourceDescriptor } from './types.js'

export * from './types.js'

export const TRIGGER_SOURCE_ORDER: readonly TriggerSourceType[] = [
  'manual',
  'schedule',
  'poll',
  'event',
]

export const TRIGGER_SOURCE_DESCRIPTORS: Readonly<
  Record<TriggerSourceType, TriggerSourceDescriptor>
> = {
  manual: manualTriggerSource,
  schedule: scheduleTriggerSource,
  poll: pollTriggerSource,
  event: eventTriggerSource,
}

export function triggerSourceDescriptor(type: TriggerSourceType): TriggerSourceDescriptor {
  return TRIGGER_SOURCE_DESCRIPTORS[type]
}

/** Descriptor for a parsed source, tolerating a config type this build does not know. */
export function triggerSourceDescriptorFor(source: TriggerSourceConfig): TriggerSourceDescriptor {
  return triggerSourceDescriptor(source.type)
}
