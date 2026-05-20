/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Telemetry service interface — no-op by default; attach real sinks via ITelemetrySinkRegistry.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'

export interface ITelemetryData {
  readonly [key: string]: string | number | boolean | undefined
}

export interface ITelemetrySink {
  log(eventName: string, data: ITelemetryData): void
  logError(errorEventName: string, data: ITelemetryData): void
  logMeasure(eventName: string, value: number, dimensions?: ITelemetryData): void
}

export interface ITelemetrySinkRegistry {
  registerSink(sink: ITelemetrySink): void
  getSinks(): readonly ITelemetrySink[]
}

export interface ITelemetryService {
  readonly _serviceBrand: undefined
  publicLog(eventName: string, data?: ITelemetryData): void
  publicLogError(errorEventName: string, data?: ITelemetryData): void
  publicLogMeasure(eventName: string, value: number, dimensions?: ITelemetryData): void
  getTelemetryInfo(): Promise<{ sessionId: string; machineId: string }>
}

export const ITelemetryService = createDecorator<ITelemetryService>('telemetryService')
