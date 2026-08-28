/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer ITelemetryService: folds repeated errors (same dedup model as
 *  VSCode's BaseErrorTelemetry — normalized-stack key, count merge) and ships
 *  them to the main-side error sink once per tick. Error events are the only
 *  thing persisted locally; usage/measure events stay unwired until a real
 *  remote sink exists.
 *--------------------------------------------------------------------------------------------*/

import {
  AggregationBuffer,
  Disposable,
  computeErrorDedupKey,
  computeErrorFingerprint,
  type ITelemetryData,
  type ITelemetryService,
} from '@universe-editor/platform'
import type { IErrorSinkService, WireErrorRecord } from '../../../shared/ipc/services.js'

/** Settings key gating local error collection (registered in SettingsContribution). */
export const ERROR_COLLECTION_ENABLED_KEY = 'telemetry.errorCollection.enabled'

interface PendingRecord extends WireErrorRecord {
  readonly dedupKey: string
  count: number
}

/** Bound against a dead renderer racing IPC teardown — pending records beyond this are dropped. */
const MAX_PENDING_WITHOUT_SINK = 100
const MAX_DIMENSIONS = 10
const MAX_MESSAGE_LENGTH = 500

function extractDimensions(data: ITelemetryData | undefined): PendingRecord['dimensions'] {
  if (!data) return undefined
  const out: { [key: string]: string | number | boolean } = {}
  for (const [k, v] of Object.entries(data)) {
    if (k === 'stack' || k === 'error' || k === 'message') continue
    if (typeof v === 'string') out[k] = v.slice(0, 200)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    if (Object.keys(out).length >= MAX_DIMENSIONS) break
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export class TelemetryClientService extends Disposable implements ITelemetryService {
  declare readonly _serviceBrand: undefined

  private readonly _sessionId = crypto.randomUUID()
  private readonly _buffer = new AggregationBuffer<PendingRecord>((r) => r.dedupKey)
  private _sink: IErrorSinkService | null = null
  private _recorder: { recordTelemetry(name: string, data?: ITelemetryData): void } | null = null
  private _enabled = true
  private _flushScheduled = false

  /** Wire the main-side sink. Pending records buffered before this point flush immediately. */
  bindSink(sink: IErrorSinkService): void {
    this._sink = sink
    this._flush()
  }

  /**
   * Mirror usage events into bug recording. Wired here rather than at each of the
   * ~20 publicLog call sites, which already carry the events worth recording.
   */
  bindRecorder(recorder: { recordTelemetry(name: string, data?: ITelemetryData): void }): void {
    this._recorder = recorder
  }

  /** Settings gate (`telemetry.errorCollection.enabled`). Disabling drops pending records. */
  setCollectionEnabled(enabled: boolean): void {
    this._enabled = enabled
    if (!enabled) this._buffer.flush()
  }

  publicLog(eventName: string, data?: ITelemetryData): void {
    // Local sink persists errors only; usage events stay unwired by design —
    // except while a bug recording is active, where they are the step stream.
    this._recorder?.recordTelemetry(eventName, data)
  }

  publicLogMeasure(_eventName: string, _value: number, _dimensions?: ITelemetryData): void {
    // Same as publicLog — no local consumer yet.
  }

  publicLogError(errorEventName: string, data?: ITelemetryData): void {
    if (!this._enabled) return
    const stackValue = data?.['stack']
    const errorValue = data?.['error']
    const messageValue = data?.['message']
    const stack = typeof stackValue === 'string' ? stackValue : undefined
    const rawMessage =
      typeof messageValue === 'string'
        ? messageValue
        : typeof errorValue === 'string'
          ? errorValue
          : (stack?.split('\n', 1)[0] ?? errorEventName)
    const message = rawMessage.split('\n', 1)[0]?.slice(0, MAX_MESSAGE_LENGTH) ?? errorEventName
    const dimensions = extractDimensions(data)
    const record: PendingRecord = {
      dedupKey: `${errorEventName}|${computeErrorDedupKey(stack, rawMessage)}`,
      v: 1,
      ts: Date.now(),
      event: errorEventName,
      fingerprint: computeErrorFingerprint(stack, rawMessage),
      count: 1,
      message,
      ...(stack !== undefined ? { stack } : {}),
      sessionId: this._sessionId,
      ...(dimensions !== undefined ? { dimensions } : {}),
    }
    this._buffer.insert(record)
    this._scheduleFlush()
  }

  getTelemetryInfo(): Promise<{ sessionId: string; machineId: string }> {
    return Promise.resolve({ sessionId: this._sessionId, machineId: 'local' })
  }

  /** Flush on the next tick: errors raised in the same turn merge into one IPC call. */
  private _scheduleFlush(): void {
    if (this._flushScheduled) return
    this._flushScheduled = true
    setTimeout(() => {
      this._flushScheduled = false
      this._flush()
    }, 0)
  }

  private _flush(): void {
    if (this._buffer.size === 0) return
    if (!this._sink) {
      if (this._buffer.size > MAX_PENDING_WITHOUT_SINK) {
        // IPC never came up (renderer crashing in a loop?) — shed oldest rather
        // than grow unbounded.
        const kept = this._buffer.flush().slice(-MAX_PENDING_WITHOUT_SINK / 2)
        for (const r of kept) this._buffer.insert(r)
      }
      return
    }
    const drained = this._buffer.flush()
    const sink = this._sink
    // Strip the internal dedupKey off the wire shape.
    void sink
      .ingestErrors(drained.map(({ dedupKey: _dedupKey, ...record }) => record))
      .catch(() => {
        // Channel torn down mid-reload: requeue so a surviving sink can still
        // pick these up on the next flush instead of losing them silently.
        for (const r of drained) this._buffer.insert(r)
      })
  }

  override dispose(): void {
    this._flush()
    super.dispose()
  }
}
