/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generic event-source registry for editor-pushed trigger events. A source knows
 *  how to validate one IPC item, derive its stable dedupe key and turn it into a
 *  prompt payload. Trigger core (scheduler / ledger / catalog) stays unaware of any
 *  concrete source; feature-specific descriptors live in their own modules.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '@universe-editor/platform'
import type { TriggerPayloadValue } from '../../../shared/triggers/types.js'

/** One normalized item: the stable event key and the agent-visible payload. */
export interface TriggerEventSourceItem {
  /** Prefixed with the source namespace (`swarm:<reviewId>`), used for dedupe. */
  readonly key: string
  readonly payload: Record<string, TriggerPayloadValue>
}

/**
 * Validates untrusted IPC items and maps them to trigger events. Returning
 * `undefined` drops the item; a malformed item must never enter the baseline.
 */
export interface TriggerEventSource {
  readonly eventName: string
  normalize(item: unknown): TriggerEventSourceItem | undefined
}

export class TriggerEventSourceRegistry implements IDisposable {
  private readonly _sources = new Map<string, TriggerEventSource>()

  register(source: TriggerEventSource): IDisposable {
    if (this._sources.has(source.eventName)) {
      throw new Error(`trigger event source already registered: ${source.eventName}`)
    }
    this._sources.set(source.eventName, source)
    return {
      dispose: () => {
        if (this._sources.get(source.eventName) === source) {
          this._sources.delete(source.eventName)
        }
      },
    }
  }

  get(eventName: string): TriggerEventSource | undefined {
    return this._sources.get(eventName)
  }

  dispose(): void {
    this._sources.clear()
  }
}
