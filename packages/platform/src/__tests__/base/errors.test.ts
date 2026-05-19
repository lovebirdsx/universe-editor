/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/errors.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ErrorNoTelemetry,
  onUnexpectedError,
  setUnexpectedErrorHandler,
} from '../../base/errors.js'

afterEach(() => {
  // Reset handler to default (console.error) after each test
  setUnexpectedErrorHandler((e) => console.error('[UnexpectedError]', e))
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
