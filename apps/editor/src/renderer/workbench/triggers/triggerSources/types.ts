/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Trigger-source descriptor contract. One descriptor owns everything the UI needs
 *  for a source type: the form draft shape/defaults, config ↔ draft mapping, the
 *  parameter form, and the label/summary wording. Adding a source type means one
 *  descriptor file plus one line in `index.ts`.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import type {
  TriggerEventName,
  TriggerOnMissed,
  TriggerSourceConfig,
  TriggerSourceType,
} from '../../../../shared/triggers/types.js'

export interface TriggerSourceDraftMap {
  readonly manual: { readonly type: 'manual' }
  readonly schedule: {
    readonly type: 'schedule'
    readonly cron: string
    readonly everyMin: string
    readonly onMissed: TriggerOnMissed
  }
  readonly poll: {
    readonly type: 'poll'
    readonly intervalSec: string
    readonly command: string
    readonly pollTimeoutSec: string
    readonly keyField: string
  }
  readonly event: {
    readonly type: 'event'
    readonly eventName: TriggerEventName
  }
}

export type TriggerSourceDraft = TriggerSourceDraftMap[TriggerSourceType]
export type TriggerSourceDraftOf<T extends TriggerSourceType> = TriggerSourceDraftMap[T]

/** Patch accepted by a source form; irrelevant keys are ignored by the owning descriptor. */
export type TriggerSourceDraftPatch = {
  readonly type?: TriggerSourceType
  readonly cron?: string
  readonly everyMin?: string
  readonly onMissed?: TriggerOnMissed
  readonly intervalSec?: string
  readonly command?: string
  readonly pollTimeoutSec?: string
  readonly keyField?: string
  readonly eventName?: TriggerEventName
}

export interface TriggerSourceFormProps {
  readonly draft: TriggerSourceDraft
  readonly update: (patch: TriggerSourceDraftPatch) => void
  /** Looks up a validation message by absolute issue path (`source.cron`, …). */
  readonly fieldError: (...paths: string[]) => string | undefined
  /** `trigger-manager-config` / `trigger-manager-wizard`; keeps e2e test ids stable. */
  readonly testIdPrefix: string
}

export interface TriggerSourceDescriptor {
  readonly type: TriggerSourceType
  readonly label: string
  readonly summary: (source: TriggerSourceConfig) => string
  /** Fresh form state for a newly selected source type. */
  readonly empty: () => TriggerSourceDraft
  /** Reads a parsed config (of this type) into the form state. */
  readonly fromConfig: (source: TriggerSourceConfig) => TriggerSourceDraft
  /** Raw JSON object handed to `parseTriggersConfig`; mirrors `configParse`. */
  readonly build: (draft: TriggerSourceDraft) => unknown
  readonly Form: (props: TriggerSourceFormProps) => ReactNode
}
