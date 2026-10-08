/**
 * The ordering this pins is invisible in the types: "subscribe then read" and
 * "read then subscribe" are the same shape, but the second one loses every
 * config change that lands during the read — which, at startup, is the
 * workspace settings layer itself. The first assertion below is the one that
 * fails on the wrong order.
 */
import { describe, expect, it, vi } from 'vitest'
import { watchConfig, type ConfigWatchSteps } from '../configWatch.js'

/** A reader whose every call is resolved by the test, so a read can be held in
 *  flight across an event. */
function controllableRead() {
  const pending: { resolve: (value: string) => void; reject: (error: unknown) => void }[] = []
  return {
    read: (): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
    pending,
  }
}

/** Flush the promise chain — every read here resolves through microtasks only. */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

function harness(): {
  steps: ConfigWatchSteps<string>
  applied: string[]
  errors: unknown[]
  fire: () => void
  subscribed: () => boolean
  read: ReturnType<typeof controllableRead>
} {
  const read = controllableRead()
  const applied: string[] = []
  const errors: unknown[] = []
  let listener: (() => void) | undefined
  let sub = false
  return {
    read,
    applied,
    errors,
    fire: () => listener?.(),
    subscribed: () => sub,
    steps: {
      read: read.read,
      apply: (value) => applied.push(value),
      subscribe: (onChange) => {
        listener = onChange
        sub = true
        return {
          dispose: () => {
            sub = false
          },
        }
      },
      onError: (error) => errors.push(error),
    },
  }
}

describe('watchConfig', () => {
  it('subscribes before the first read', async () => {
    const order: string[] = []
    const read = controllableRead()
    const watch = watchConfig<string>({
      read: () => {
        order.push('read')
        return read.read()
      },
      apply: (value) => order.push(`apply:${value}`),
      subscribe: () => {
        order.push('subscribe')
        return { dispose: () => {} }
      },
    })

    // Read-then-subscribe would log `read, apply:v1, subscribe` here — and lose
    // a settings layer that loaded while the read was in flight.
    expect(order).toEqual(['subscribe', 'read'])
    read.pending[0]!.resolve('v1')
    await watch.ready
    expect(order).toEqual(['subscribe', 'read', 'apply:v1'])
  })

  it('catches a change that lands while the initial read is still in flight', async () => {
    const h = harness()
    const watch = watchConfig(h.steps)

    // The workspace layer lands during the initial read (only deliverable
    // because of the ordering the previous test pins), then the newer read
    // resolves first and the overtaken one is dropped unapplied.
    h.fire()
    expect(h.read.pending).toHaveLength(2)
    h.read.pending[1]!.resolve('configured')
    await tick()
    h.read.pending[0]!.resolve('default')
    await watch.ready
    await tick()
    expect(h.applied).toEqual(['configured'])
  })

  it('keeps only the newest of two reads that resolve out of order', async () => {
    const h = harness()
    const watch = watchConfig(h.steps)
    h.read.pending[0]!.resolve('first')
    await watch.ready
    expect(h.applied).toEqual(['first'])

    h.fire()
    h.fire()
    h.read.pending[2]!.resolve('third')
    await tick()
    h.read.pending[1]!.resolve('second')
    await tick()
    expect(h.applied).toEqual(['first', 'third'])
  })

  it('routes a failed change-driven read to onError and keeps listening', async () => {
    const h = harness()
    const watch = watchConfig(h.steps)
    h.read.pending[0]!.resolve('default')
    await watch.ready

    h.fire()
    h.read.pending[1]!.reject(new Error('boom'))
    await tick()
    expect(h.errors).toHaveLength(1)
    expect((h.errors[0] as Error).message).toBe('boom')

    // A failed read is not a dead subscription: the next change still applies.
    h.fire()
    h.read.pending[2]!.resolve('recovered')
    await tick()
    expect(h.applied).toEqual(['default', 'recovered'])
  })

  it('rejects ready when the initial read fails, without applying', async () => {
    const apply = vi.fn()
    const read = controllableRead()
    const watch = watchConfig<string>({
      read: read.read,
      apply,
      subscribe: () => ({ dispose: () => {} }),
    })
    read.pending[0]!.reject(new Error('no settings layer'))
    await expect(watch.ready).rejects.toThrow('no settings layer')
    expect(apply).not.toHaveBeenCalled()
  })

  it('re-reads and re-applies on refresh (the switched-workspace path)', async () => {
    const h = harness()
    const watch = watchConfig(h.steps)
    h.read.pending[0]!.resolve('default')
    await watch.ready

    const refreshed = watch.refresh()
    h.read.pending[1]!.resolve('configured')
    await refreshed
    expect(h.applied).toEqual(['default', 'configured'])
  })

  it('disposes the subscription and drops a read that was still in flight', async () => {
    const h = harness()
    const watch = watchConfig(h.steps)
    h.read.pending[0]!.resolve('default')
    await watch.ready

    h.fire()
    watch.dispose()
    h.read.pending[1]!.resolve('late')
    await tick()
    expect(h.subscribed()).toBe(false)
    expect(h.applied).toEqual(['default'])
  })
})
