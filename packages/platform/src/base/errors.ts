/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Aligned with VSCode's vscode/src/vs/base/common/errors.ts public API.
 *--------------------------------------------------------------------------------------------*/

let unexpectedErrorHandler: (e: unknown) => void = (e: unknown) => {
  console.error('[UnexpectedError]', e)
}

export function setUnexpectedErrorHandler(handler: (e: unknown) => void): void {
  unexpectedErrorHandler = handler
}

type ErrorTelemetryHook = (errorEventName: string, data: { stack?: string }) => void
let _errorTelemetryHook: ErrorTelemetryHook | undefined

export function setErrorTelemetryHook(hook: ErrorTelemetryHook): void {
  _errorTelemetryHook = hook
}

export function onUnexpectedError(e: unknown): void {
  if (e instanceof ErrorNoTelemetry) return
  _errorTelemetryHook?.('unhandledError', {
    stack: e instanceof Error ? (e.stack ?? e.message) : String(e),
  })
  unexpectedErrorHandler(e)
}

/**
 * An error that should not be reported to telemetry.
 * Useful for expected user-facing errors (e.g. file not found, operation cancelled).
 */
export class ErrorNoTelemetry extends Error {
  readonly noTelemetry = true

  static fromError(e: Error): ErrorNoTelemetry {
    const result = new ErrorNoTelemetry(e.message)
    if (e.stack !== undefined) {
      result.stack = e.stack
    }
    return result
  }
}
