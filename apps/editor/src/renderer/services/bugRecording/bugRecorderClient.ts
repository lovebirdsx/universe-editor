/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-window producer side of bug recording. Mirrors main's recording status as
 *  an observable so the status bar and hooks can read it synchronously, and drops
 *  events on the floor while idle — recording must cost nothing when it is off.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  observableValue,
  transaction,
  type IDisposable,
  type IObservable,
} from '@universe-editor/platform'
import type {
  BugRecordEvent,
  BugRecordEventPayload,
  BugRecordingOrphanInfo,
  BugRecordingResult,
  BugRecordingStartMeta,
  BugRecordingStatus,
  BugRecordingStopOptions,
  IBugRecorderService,
} from '../../../shared/ipc/bugRecorderService.js'

/**
 * Separate decorator from IBugRecorderService: the client exposes an observable
 * status the wire contract cannot carry (same pattern as ILogMainService).
 */
export const IBugRecorderClient = createDecorator<BugRecorderClient>('bugRecorderClient')

const IDLE: BugRecordingStatus = { state: 'idle' }

export class BugRecorderClient extends Disposable {
  declare readonly _serviceBrand: undefined

  private readonly _status = observableValue<BugRecordingStatus>('bugRecordingStatus', IDLE)
  readonly status: IObservable<BugRecordingStatus> = this._status

  /**
   * Hooks that hold events not yet handed over — currently the debounced edit
   * aggregator. They must run while the status is still `recording`, otherwise
   * recordEvent drops what they emit; stopRecording drains them before telling
   * main to pack the bundle.
   */
  private readonly _flushParticipants = new Set<() => void>()

  constructor(private readonly _proxy: IBugRecorderService) {
    super()
    this._register(
      this._proxy.onDidChangeStatus((status) => {
        transaction((tx) => this._status.set(status, tx))
      }),
    )
    // Idle is the right fallback if the seed fails: recording is a side channel,
    // and an unhandled rejection here would surface during window startup.
    void this._proxy
      .getRecordingStatus()
      .then((status) => {
        transaction((tx) => this._status.set(status, tx))
      })
      .catch(() => undefined)
  }

  registerFlushParticipant(flush: () => void): IDisposable {
    this._flushParticipants.add(flush)
    return { dispose: () => this._flushParticipants.delete(flush) }
  }

  get isRecording(): boolean {
    return this._status.get().state === 'recording'
  }

  /** Fire-and-forget; a no-op while idle so hooks can call it unconditionally. */
  recordEvent(event: BugRecordEventPayload & { readonly ts?: number }): void {
    if (!this.isRecording) return
    const stamped: BugRecordEvent = { ...event, ts: event.ts ?? Date.now() }
    void this._proxy.recordEvents([stamped]).catch(() => {
      // Recording is a side channel — never surface its failures to the user.
    })
  }

  /** Bridges ITelemetryService.publicLog; drops undefined values the wire can't carry. */
  recordTelemetry(name: string, data?: Readonly<Record<string, unknown>>): void {
    if (!this.isRecording) return
    const flat: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(data ?? {})) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        flat[key] = value
      }
    }
    this.recordEvent({
      kind: 'telemetry',
      name,
      ...(Object.keys(flat).length > 0 ? { data: flat } : {}),
    })
  }

  async startRecording(meta: BugRecordingStartMeta): Promise<BugRecordingStatus> {
    const status = await this._proxy.startRecording(meta)
    transaction((tx) => this._status.set(status, tx))
    return status
  }

  async stopRecording(options: BugRecordingStopOptions): Promise<BugRecordingResult> {
    // Still `recording` here, so the events these emit are accepted. They land
    // in main's write chain, which stopRecording awaits before packing.
    for (const flush of this._flushParticipants) flush()
    try {
      const result = await this._proxy.stopRecording(options)
      transaction((tx) => this._status.set(IDLE, tx))
      return result
    } catch (err) {
      // Don't assume idle: main resumes the recording when packing fails so the
      // user can retry, and it broadcasts that. Re-read rather than guess.
      const status = await this._proxy.getRecordingStatus().catch(() => IDLE)
      transaction((tx) => this._status.set(status, tx))
      throw err
    }
  }

  markStep(): Promise<void> {
    return this._proxy.markStep()
  }

  consumeOrphanRecording(): Promise<BugRecordingOrphanInfo | null> {
    return this._proxy.consumeOrphanRecording()
  }

  exportOrphanRecording(options: BugRecordingStopOptions): Promise<BugRecordingResult> {
    return this._proxy.exportOrphanRecording(options)
  }
}
