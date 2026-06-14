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
  if (isCancellationError(e)) return
  _errorTelemetryHook?.('unhandledError', {
    stack: e instanceof Error ? (e.stack ?? e.message) : String(e),
  })
  unexpectedErrorHandler(e)
}

/**
 * A cancellation error thrown when a pending async operation is cancelled
 * during disposal (e.g. Monaco's Delayer.cancel()). This is expected behaviour
 * and must not be treated as an unexpected error.
 */
export class CancellationError extends Error {
  constructor() {
    super('Canceled')
    this.name = 'Canceled'
  }
}

/** Returns true for any error that represents an intentional cancellation. */
export function isCancellationError(error: unknown): boolean {
  if (error instanceof CancellationError) return true
  return error instanceof Error && error.name === 'Canceled' && error.message === 'Canceled'
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

/**
 * Plain, structured-clone-safe shape of an `Error` for sending across a process
 * boundary (the IPC layer drops prototypes, so an `Error` instance arrives as a
 * bare object). Mirrors VSCode's `SerializedError` (base/common/errors.ts).
 */
export interface SerializedError {
  readonly $isError: true
  readonly name: string
  readonly message: string
  readonly stack?: string
  /** Preserved so `isCancellationError` survives the round-trip. */
  readonly noTelemetry?: boolean
}

/** Convert an arbitrary thrown value into a serializable {@link SerializedError}. */
export function transformErrorForSerialization(error: unknown): SerializedError {
  if (error instanceof Error) {
    const { name, message } = error
    const stack = (error as { stacktrace?: string }).stacktrace ?? error.stack
    const serialized: SerializedError = {
      $isError: true,
      name,
      message,
      ...(stack !== undefined ? { stack } : {}),
      ...((error as ErrorNoTelemetry).noTelemetry ? { noTelemetry: true } : {}),
    }
    return serialized
  }
  return { $isError: true, name: 'Error', message: String(error) }
}

function isSerializedError(thing: unknown): thing is SerializedError {
  return (
    thing !== null &&
    typeof thing === 'object' &&
    (thing as { $isError?: unknown }).$isError === true
  )
}

/** Rebuild an `Error` from a {@link SerializedError} (the inverse of transform). */
export function transformErrorFromSerialization(data: SerializedError): Error {
  let error: Error
  if (data.name === 'Canceled' && data.message === 'Canceled') {
    error = new CancellationError()
  } else if (data.noTelemetry) {
    error = new ErrorNoTelemetry()
    error.message = data.message
  } else {
    error = new Error()
    error.name = data.name
    error.message = data.message
  }
  if (data.stack !== undefined) {
    error.stack = data.stack
  }
  return error
}

/** Normalize an unknown value (possibly a {@link SerializedError}) into an `Error`. */
export function reviveError(thing: unknown): unknown {
  return isSerializedError(thing) ? transformErrorFromSerialization(thing) : thing
}
