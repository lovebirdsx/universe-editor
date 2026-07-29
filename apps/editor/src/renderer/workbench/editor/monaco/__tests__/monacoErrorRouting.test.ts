/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression: a workspace swap relaunches the extension host; ChannelClient
 *  rejects every in-flight language-provider RPC with IpcChannelDisposedError.
 *  Monaco catches those provider rejections and — via its default ErrorHandler —
 *  rethrew them as synthetic `new Error(message + '\n\n' + stack)` copies whose
 *  name is plain 'Error', so isBenignError could never classify them and each
 *  torn-down call surfaced as "[error] Error: IPC channel disposed before
 *  response" in the renderer log. monacoErrorRouting forwards the original
 *  instance to the workbench's onUnexpectedError instead.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { IpcChannelDisposedError, setUnexpectedErrorHandler } from '@universe-editor/platform'
import { isBenignError } from '../../../../errors.js'
import { installMonacoErrorRouting, type MonacoErrorsModuleLike } from '../monacoErrorRouting.js'

/** Replica of monaco's default ErrorHandler (vs/base/common/errors.js). */
function monacoDefaultRethrow(e: unknown): void {
  const err = e as Error
  setTimeout(() => {
    if (err.stack) {
      throw new Error(`${err.message}\n\n${err.stack}`)
    }
    throw e
  }, 0)
}

function makeFakeErrorsModule(): MonacoErrorsModuleLike {
  return { errorHandler: { unexpectedErrorHandler: monacoDefaultRethrow } }
}

describe('monacoErrorRouting', () => {
  afterEach(() => {
    setUnexpectedErrorHandler((e) => console.error('[UnexpectedError]', e))
  })

  it('reproduces the root cause: monaco synthetic rethrow copies defeat isBenignError', () => {
    const original = new IpcChannelDisposedError()
    expect(isBenignError(original)).toBe(true)

    // What monaco's default handler would rethrow: name collapses to 'Error',
    // instanceof is lost — the benign classification can never match.
    const synthetic = new Error(`${original.message}\n\n${original.stack ?? ''}`)
    expect(isBenignError(synthetic)).toBe(false)
  })

  it('forwards the original error instance so the benign filter still applies', () => {
    const received: unknown[] = []
    setUnexpectedErrorHandler((e) => received.push(e))

    const errors = makeFakeErrorsModule()
    installMonacoErrorRouting(errors)

    const err = new IpcChannelDisposedError()
    errors.errorHandler.unexpectedErrorHandler(err)

    expect(received).toEqual([err])
    expect(isBenignError(received[0])).toBe(true)
  })

  it('still surfaces genuine errors to the workbench handler', () => {
    const received: unknown[] = []
    setUnexpectedErrorHandler((e) => received.push(e))

    const errors = makeFakeErrorsModule()
    installMonacoErrorRouting(errors)

    const boom = new Error('boom')
    errors.errorHandler.unexpectedErrorHandler(boom)

    expect(received).toEqual([boom])
    expect(isBenignError(boom)).toBe(false)
  })

  it('drops cancellation errors (platform onUnexpectedError filters them)', () => {
    const received: unknown[] = []
    setUnexpectedErrorHandler((e) => received.push(e))

    const errors = makeFakeErrorsModule()
    installMonacoErrorRouting(errors)

    // Monaco's CancellationError shape: name and message both 'Canceled'.
    const canceled = new Error('Canceled')
    canceled.name = 'Canceled'
    errors.errorHandler.unexpectedErrorHandler(canceled)

    expect(received).toEqual([])
  })
})
