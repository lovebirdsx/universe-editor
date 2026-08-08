/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useFullCommitMessages } from '../useFullCommitMessages.js'

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useFullCommitMessages', () => {
  it('fetches on demand and caches the result', async () => {
    const fetchBody = vi.fn(async (id: string) => `body of ${id}`)
    const { result } = renderHook(() => useFullCommitMessages(fetchBody))

    expect(result.current.get('a')).toBeUndefined()

    let body: string | null = null
    await act(async () => {
      body = await result.current.load('a')
    })
    expect(body).toBe('body of a')
    expect(result.current.get('a')).toBe('body of a')

    await act(async () => {
      body = await result.current.load('a')
    })
    expect(fetchBody).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent loads of the same id', async () => {
    let resolve: ((body: string) => void) | undefined
    const fetchBody = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r
        }),
    )
    const { result } = renderHook(() => useFullCommitMessages(fetchBody))

    let first: string | null = null
    let second: string | null = null
    await act(async () => {
      const p1 = result.current.load('a').then((b) => (first = b))
      const p2 = result.current.load('a').then((b) => (second = b))
      resolve?.('full body')
      await Promise.all([p1, p2])
    })
    expect(fetchBody).toHaveBeenCalledTimes(1)
    expect(first).toBe('full body')
    expect(second).toBe('full body')
    expect(result.current.get('a')).toBe('full body')
  })

  it('returns null on fetch failure and allows a retry', async () => {
    const fetchBody = vi
      .fn<(id: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered')
    const { result } = renderHook(() => useFullCommitMessages(fetchBody))

    let body: string | null = 'unset'
    await act(async () => {
      body = await result.current.load('a')
    })
    expect(body).toBeNull()
    expect(result.current.get('a')).toBeUndefined()

    await act(async () => {
      body = await result.current.load('a')
    })
    expect(body).toBe('recovered')
  })

  it('keeps a stable identity across re-renders', async () => {
    const fetchBody = vi.fn(async () => 'body')
    const { result, rerender } = renderHook(() => useFullCommitMessages(fetchBody))
    const first = result.current
    await flush()
    rerender()
    expect(result.current).toBe(first)
  })
})
