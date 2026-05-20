/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  No-op telemetry implementation — used in the workbench until a real sink is wired in.
 *--------------------------------------------------------------------------------------------*/

import type {
  ITelemetryData,
  ITelemetrySink,
  ITelemetrySinkRegistry,
  ITelemetryService,
} from './telemetryService.js'

export class TelemetrySinkRegistry implements ITelemetrySinkRegistry {
  private readonly _sinks: ITelemetrySink[] = []

  registerSink(sink: ITelemetrySink): void {
    this._sinks.push(sink)
  }

  getSinks(): readonly ITelemetrySink[] {
    return this._sinks
  }
}

export class NoopTelemetryService implements ITelemetryService {
  declare readonly _serviceBrand: undefined

  private readonly _sessionId = crypto.randomUUID()

  publicLog(_eventName: string, _data?: ITelemetryData): void {}

  publicLogError(_errorEventName: string, _data?: ITelemetryData): void {}

  publicLogMeasure(_eventName: string, _value: number, _dimensions?: ITelemetryData): void {}

  getTelemetryInfo(): Promise<{ sessionId: string; machineId: string }> {
    return Promise.resolve({ sessionId: this._sessionId, machineId: 'noop' })
  }
}
