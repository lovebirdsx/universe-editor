/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/errors.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CancellationError,
  ErrorNoTelemetry,
  isCancellationError,
  onUnexpectedError,
  reviveError,
  setErrorTelemetryHook,
  setUnexpectedErrorHandler,
  transformErrorForSerialization,
  transformErrorFromSerialization,
} from '../../base/errors.js'

afterEach(() => {
  // Reset handler to default (console.error) after each test
  setUnexpectedErrorHandler((e) => console.error('[UnexpectedError]', e))
  // Reset telemetry hook
  setErrorTelemetryHook(() => {})
})

describe('setUnexpectedErrorHandler / onUnexpectedError', () => {
  it('routes to the registered handler', () => {
    const received: unknown[] = []
    setUnexpectedErrorHandler((e) => received.push(e))
    const err = new Error('test error')
    onUnexpectedError(err)
    expect(received).toHaveLength(1)
    expect(received[0]).toBe(err)
  })

  it('silently skips ErrorNoTelemetry instances', () => {
    const received: unknown[] = []
    setUnexpectedErrorHandler((e) => received.push(e))
    onUnexpectedError(new ErrorNoTelemetry('noop'))
    expect(received).toHaveLength(0)
  })
})

describe('ErrorNoTelemetry', () => {
  it('is an Error with noTelemetry=true', () => {
    const err = new ErrorNoTelemetry('quiet error')
    expect(err).toBeInstanceOf(Error)
    expect(err.noTelemetry).toBe(true)
    expect(err.message).toBe('quiet error')
  })

  it('fromError copies message and stack', () => {
    const original = new Error('original')
    const wrapped = ErrorNoTelemetry.fromError(original)
    expect(wrapped.noTelemetry).toBe(true)
    expect(wrapped.message).toBe('original')
    expect(wrapped.stack).toBe(original.stack)
  })
})

describe('setErrorTelemetryHook', () => {
  it('calls hook with error stack on onUnexpectedError', () => {
    const hook = vi.fn()
    setErrorTelemetryHook(hook)
    setUnexpectedErrorHandler(() => {})
    const err = new Error('boom')
    onUnexpectedError(err)
    expect(hook).toHaveBeenCalledOnce()
    expect(hook).toHaveBeenCalledWith(
      'unhandledError',
      expect.objectContaining({ stack: expect.stringContaining('boom') }),
    )
  })

  it('does not call hook for ErrorNoTelemetry', () => {
    const hook = vi.fn()
    setErrorTelemetryHook(hook)
    setUnexpectedErrorHandler(() => {})
    onUnexpectedError(new ErrorNoTelemetry('silent'))
    expect(hook).not.toHaveBeenCalled()
  })
})

describe('transformErrorForSerialization', () => {
  it('round-trips a plain Error preserving name/message/stack', () => {
    const err = new Error('boom')
    err.name = 'CustomError'
    const serialized = transformErrorForSerialization(err)
    expect(serialized.$isError).toBe(true)
    expect(serialized.name).toBe('CustomError')
    expect(serialized.message).toBe('boom')
    const revived = transformErrorFromSerialization(serialized)
    expect(revived).toBeInstanceOf(Error)
    expect(revived.name).toBe('CustomError')
    expect(revived.message).toBe('boom')
    expect(revived.stack).toBe(serialized.stack)
  })

  it('preserves cancellation across the round-trip', () => {
    const serialized = transformErrorForSerialization(new CancellationError())
    const revived = transformErrorFromSerialization(serialized)
    expect(isCancellationError(revived)).toBe(true)
  })

  it('preserves noTelemetry across the round-trip', () => {
    const serialized = transformErrorForSerialization(new ErrorNoTelemetry('quiet'))
    expect(serialized.noTelemetry).toBe(true)
    const revived = transformErrorFromSerialization(serialized)
    expect((revived as ErrorNoTelemetry).noTelemetry).toBe(true)
  })

  it('handles non-Error throwables', () => {
    const serialized = transformErrorForSerialization('just a string')
    expect(serialized.message).toBe('just a string')
  })
})

describe('reviveError', () => {
  it('revives a SerializedError but passes other values through', () => {
    const serialized = transformErrorForSerialization(new Error('x'))
    expect(reviveError(serialized)).toBeInstanceOf(Error)
    expect(reviveError('not an error')).toBe('not an error')
    expect(reviveError(undefined)).toBeUndefined()
  })
})
