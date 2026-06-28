/*---------------------------------------------------------------------------------------------
 *  Tests for AcpSessionConnection — the connection lifecycle state machine. The
 *  behaviours that the previous implicit flag soup got wrong are pinned here:
 *  queued prompts flush exactly once on connect, are REJECTED (not silently
 *  dropped) on fail/close, and the settled gate always resolves.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { AcpConnectionError, AcpSessionConnection } from '../acpSessionConnection.js'
import type { IAcpClientConnection } from '../acpClientService.js'

const FAKE_CONN = { conn: {} } as unknown as IAcpClientConnection

describe('AcpSessionConnection — phases', () => {
  it('starts connecting and is not settled', () => {
    const c = new AcpSessionConnection()
    expect(c.phase).toBe('connecting')
    expect(c.isSettled).toBe(false)
    expect(c.conn).toBeUndefined()
  })

  it('connecting → connected binds the conn and settles', async () => {
    const c = new AcpSessionConnection()
    let settled = false
    void c.whenSettled().then(() => {
      settled = true
    })
    c.open(FAKE_CONN)
    expect(c.phase).toBe('connected')
    expect(c.conn).toBe(FAKE_CONN)
    expect(c.isSettled).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('connecting → failed settles without binding a conn', async () => {
    const c = new AcpSessionConnection()
    expect(c.fail('boom')).toBe(true)
    expect(c.phase).toBe('failed')
    expect(c.conn).toBeUndefined()
    await expect(c.whenSettled()).resolves.toBeUndefined()
  })

  it('open / fail are no-ops once settled', () => {
    const c = new AcpSessionConnection()
    c.open(FAKE_CONN)
    expect(c.fail('late')).toBe(false)
    expect(c.phase).toBe('connected')

    const c2 = new AcpSessionConnection()
    c2.fail('first')
    expect(c2.open(FAKE_CONN)).toEqual([])
    expect(c2.phase).toBe('failed')
    expect(c2.conn).toBeUndefined()
  })

  it('close from connecting settles the gate', async () => {
    const c = new AcpSessionConnection()
    c.close()
    expect(c.phase).toBe('closed')
    await expect(c.whenSettled()).resolves.toBeUndefined()
  })
})

describe('AcpSessionConnection — queued prompts', () => {
  it('flushes queued prompts exactly once on connect, in order', () => {
    const c = new AcpSessionConnection()
    const p1 = c.enqueue('first', [])
    const p2 = c.enqueue('second', [])
    void p1
    void p2
    const drained = c.open(FAKE_CONN)
    expect(drained.map((q) => q.text)).toEqual(['first', 'second'])
    // Second open drains nothing.
    expect(c.open(FAKE_CONN)).toEqual([])
  })

  it('resolves a queued prompt when the drained deferred is resolved', async () => {
    const c = new AcpSessionConnection()
    const done = vi.fn()
    const p = c.enqueue('hello', []).then(done)
    const [q] = c.open(FAKE_CONN)
    q!.resolve()
    await p
    expect(done).toHaveBeenCalledOnce()
  })

  it('REJECTS queued prompts on fail (not silently dropped)', async () => {
    const c = new AcpSessionConnection()
    const p = c.enqueue('lost', [])
    c.fail('agent crashed')
    await expect(p).rejects.toBeInstanceOf(AcpConnectionError)
    await expect(p).rejects.toThrow('agent crashed')
  })

  it('REJECTS queued prompts on close before connect', async () => {
    const c = new AcpSessionConnection()
    const p = c.enqueue('lost', [])
    c.close()
    await expect(p).rejects.toBeInstanceOf(AcpConnectionError)
  })
})
