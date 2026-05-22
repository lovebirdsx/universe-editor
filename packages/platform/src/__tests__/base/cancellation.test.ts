/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/cancellation.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { CancellationToken, CancellationTokenSource } from '../../base/cancellation.js'

describe('CancellationToken.None', () => {
  it('never cancels', () => {
    expect(CancellationToken.None.isCancellationRequested).toBe(false)
    const cb = vi.fn()
    const sub = CancellationToken.None.onCancellationRequested(cb)
    sub.dispose()
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('CancellationToken.Cancelled', () => {
  it('is always cancelled', () => {
    expect(CancellationToken.Cancelled.isCancellationRequested).toBe(true)
  })

  it('fires the listener asynchronously on subscribe', async () => {
    const cb = vi.fn()
    CancellationToken.Cancelled.onCancellationRequested(cb)
    expect(cb).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 5))
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('CancellationTokenSource', () => {
  it('starts un-cancelled', () => {
    const cts = new CancellationTokenSource()
    expect(cts.token.isCancellationRequested).toBe(false)
  })

  it('cancel() flips token and fires onCancellationRequested once', () => {
    const cts = new CancellationTokenSource()
    const cb = vi.fn()
    cts.token.onCancellationRequested(cb)
    cts.cancel()
    expect(cts.token.isCancellationRequested).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    cts.cancel()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('subscribing after cancel still fires (async)', async () => {
    const cts = new CancellationTokenSource()
    cts.cancel()
    const cb = vi.fn()
    cts.token.onCancellationRequested(cb)
    await new Promise((r) => setTimeout(r, 5))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('propagates cancel from a parent token', () => {
    const parent = new CancellationTokenSource()
    const child = new CancellationTokenSource(parent.token)
    const cb = vi.fn()
    child.token.onCancellationRequested(cb)
    parent.cancel()
    expect(child.token.isCancellationRequested).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('dispose without cancel leaves token un-cancelled', () => {
    const cts = new CancellationTokenSource()
    cts.dispose()
    expect(cts.token.isCancellationRequested).toBe(false)
  })

  it('dispose(true) cancels', () => {
    const cts = new CancellationTokenSource()
    cts.dispose(true)
    expect(cts.token.isCancellationRequested).toBe(true)
  })
})

describe('CancellationToken.isCancellationToken', () => {
  it('accepts None / Cancelled / live tokens', () => {
    expect(CancellationToken.isCancellationToken(CancellationToken.None)).toBe(true)
    expect(CancellationToken.isCancellationToken(CancellationToken.Cancelled)).toBe(true)
    expect(CancellationToken.isCancellationToken(new CancellationTokenSource().token)).toBe(true)
  })

  it('rejects non-tokens', () => {
    expect(CancellationToken.isCancellationToken(null)).toBe(false)
    expect(CancellationToken.isCancellationToken({})).toBe(false)
    expect(CancellationToken.isCancellationToken({ isCancellationRequested: false })).toBe(false)
  })
})
