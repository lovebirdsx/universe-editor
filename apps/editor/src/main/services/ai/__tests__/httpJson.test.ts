/*---------------------------------------------------------------------------------------------
 *  Tests for the shared http-json plumbing: url/header assembly and — the part that
 *  regressed — releasing the cancellation subscription synchronously when the token
 *  fires while a request is still in flight (shutdown cancels, the process-exit leak
 *  check runs before the request's own `finally` gets a turn).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CancellationTokenSource,
  DisposableTracker,
  setDisposableTracker,
} from '@universe-editor/platform'
import { buildHeaders, fetchJson, resolveUrl } from '../remote/httpJson.js'

afterEach(() => {
  setDisposableTracker(null)
  vi.unstubAllGlobals()
})

describe('http-json plumbing', () => {
  it('joins base url and path', () => {
    expect(
      resolveUrl({ typeId: 'p', instanceName: 'p', baseUrl: 'https://gw.example.com/' }, {}, '/x'),
    ).toBe('https://gw.example.com/x')
  })

  it('sends the api key as a bearer token by default', () => {
    expect(buildHeaders({ typeId: 'p', instanceName: 'p', apiKey: 'ak-1' }, {}).Authorization).toBe(
      'Bearer ak-1',
    )
  })

  it('releases the cancellation subscription synchronously when cancelled in flight', async () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    vi.stubGlobal(
      'fetch',
      (_input: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    )

    const cts = new CancellationTokenSource()
    const pending = fetchJson('https://gw.example.com/rates', {}, cts.token, 30_000)

    cts.cancel()
    // Same tick as the cancel: this is where the process-exit leak check looks.
    const report = tracker.computeLeakingDisposables()
    expect(report?.details).toBeUndefined()

    await expect(pending).resolves.toBeUndefined()
    cts.dispose()
  })
})
