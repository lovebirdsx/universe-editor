/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/errors.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ErrorNoTelemetry,
  onUnexpectedError,
  setErrorTelemetryHook,
  setUnexpectedErrorHandler,
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
