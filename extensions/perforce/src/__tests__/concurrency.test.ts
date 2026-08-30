/**
 * Unit tests for {@link ConcurrencyGate}. This is the core repro for the
 * minutes-long diff-open wedge: every p4 command shares one FIFO gate, so a
 * reconcile disk re-verify fanning ~114 `reconcile -n` batches out through a
 * single `Promise.all` filled every slot for minutes, and the user's click
 * (`fstat` + `print`) queued at the tail. The fix is a *static* reserved slot:
 * background is hard-capped at `max - reserve` (default 4 - 1 = 3), so one slot
 * is always held back for interactive (user-triggered) work — interactive may
 * use all `max`, background never does. Static, not dynamic, because a burst of
 * background work would otherwise still fill every slot before the click lands.
 */
import { describe, expect, it } from 'vitest'
import { ConcurrencyGate } from '../concurrency.js'

/** A manually-resolved promise, as a controllable "task is still running" latch. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Flush pending microtasks (a macrotask turn) so queued gate tasks start. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('ConcurrencyGate priority + reserved slot', () => {
  it('reserves a slot: an interactive command starts immediately while background fills its cap', async () => {
    const gate = new ConcurrencyGate(4, 1) // _backgroundCap = 3, one reserved slot
    const latches = [deferred(), deferred(), deferred()]
    let backgroundStarted = 0
    for (const latch of latches) {
      void gate.run(async () => {
        backgroundStarted++
        await latch.promise
      })
    }
    await flush()
    // The three background tasks now hold every background slot.
    expect(backgroundStarted).toBe(3)

    // The user's click arrives while the background batch is still running. It
    // must start right away (into the reserved slot), not queue behind the batch.
    let interactiveInvoked = false
    void gate.run(async () => {
      interactiveInvoked = true
    }, 'interactive')
    await flush()
    expect(interactiveInvoked).toBe(true)

    latches.forEach((l) => l.resolve())
    await flush()
  })

  it('hard-caps background at max - reserve even when max slots are free', async () => {
    const gate = new ConcurrencyGate(4, 1) // _backgroundCap = 3
    let peak = 0
    let running = 0
    const latches: (() => void)[] = []
    const tasks: Promise<void>[] = []
    for (let i = 0; i < 5; i++) {
      const d = deferred()
      latches.push(d.resolve)
      tasks.push(
        gate.run(async () => {
          running++
          peak = Math.max(peak, running)
          await d.promise
          running--
        }),
      )
    }
    await flush()
    // Five background tasks on a (4,1) gate → only three may run at once; the
    // remaining two queue even though the fourth (reserved) slot is idle.
    expect(peak).toBe(3)

    latches.forEach((r) => r())
    await Promise.all(tasks)
  })

  it('drains interactive ahead of background enqueued earlier', async () => {
    const gate = new ConcurrencyGate(4, 1)
    const bgLatches = [deferred(), deferred(), deferred()]
    const intLatch = deferred()
    for (const l of bgLatches)
      void gate.run(async () => {
        await l.promise
      }, 'background')
    void gate.run(async () => {
      await intLatch.promise
    }, 'interactive')
    await flush()
    // All four slots are now occupied (3 background + 1 interactive).

    const order: string[] = []
    void gate.run(async () => {
      order.push('bg3')
    }, 'background')
    void gate.run(async () => {
      order.push('bg4')
    }, 'background')
    void gate.run(async () => {
      order.push('interactive')
    }, 'interactive')
    await flush()
    expect(order).toEqual([])

    // Free exactly one background slot: the queued interactive must jump the
    // queue ahead of the two queued background tasks.
    bgLatches[0]!.resolve()
    await flush()
    expect(order).toEqual(['interactive'])

    bgLatches[1]!.resolve()
    bgLatches[2]!.resolve()
    intLatch.resolve()
    await flush()
  })

  it('releases same-priority tasks in FIFO order', async () => {
    const gate = new ConcurrencyGate(1, 1) // backgroundCap = 1
    const latch = deferred()
    const order: string[] = []
    const first = gate.run(
      async () => {
        await latch.promise
      },
      'background',
      () => order.push('a'),
    )
    const second = gate.run(
      async () => {},
      'background',
      () => order.push('b'),
    )
    const third = gate.run(
      async () => {},
      'background',
      () => order.push('c'),
    )
    await flush()
    expect(order).toEqual(['a'])

    latch.resolve()
    await Promise.all([first, second, third])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('setMax raises the background cap and drains queued background work', async () => {
    const gate = new ConcurrencyGate(2, 1) // backgroundCap = 1
    const latch = deferred()
    const order: string[] = []
    void gate.run(
      async () => {
        await latch.promise
      },
      'background',
      () => order.push('a'),
    )
    void gate.run(
      async () => {},
      'background',
      () => order.push('b'),
    )
    void gate.run(
      async () => {},
      'background',
      () => order.push('c'),
    )
    await flush()
    expect(order).toEqual(['a']) // b and c queue behind the single background slot

    gate.setMax(8) // backgroundCap becomes 7
    await flush()
    expect(order).toEqual(['a', 'b', 'c'])

    latch.resolve()
    await flush()
  })

  it('setMax lowering keeps the reserved slot: backgroundCap stays at max(1, max - reserve)', async () => {
    const gate = new ConcurrencyGate(4, 1)
    const latch = deferred()
    const order: string[] = []
    void gate.run(
      async () => {
        await latch.promise
      },
      'background',
      () => order.push('a'),
    )
    await flush()
    expect(order).toEqual(['a'])

    gate.setMax(2) // max 2, reserve 1 → backgroundCap = max(1, 1) = 1
    void gate.run(
      async () => {},
      'background',
      () => order.push('b'),
    )
    await flush()
    // b queues: the now-free second slot is reserved, background may not use it.
    expect(order).toEqual(['a'])

    latch.resolve()
    await flush()
    expect(order).toEqual(['a', 'b'])
  })

  it('reserve >= max still lets background run (never starves, cap >= 1)', async () => {
    const gate = new ConcurrencyGate(1, 5) // max 1, reserve 5 → backgroundCap = max(1, -4) = 1
    const latch = deferred()
    const order: string[] = []
    void gate.run(
      async () => {
        await latch.promise
      },
      'background',
      () => order.push('a'),
    )
    await flush()
    expect(order).toEqual(['a'])

    latch.resolve()
    await flush()
  })

  it('reports waitedMs > 0 after queueing and ~0 on an immediate slot', async () => {
    const gate = new ConcurrencyGate(2, 1) // backgroundCap = 1
    const latch = deferred()
    const waits: number[] = []
    const slow = gate.run(
      async () => {
        await latch.promise
      },
      'background',
      (w) => waits.push(w),
    )
    await flush()
    const queued = gate.run(
      async () => {},
      'background',
      (w) => waits.push(w),
    )
    // Let real time elapse while `queued` waits behind the held slot.
    await new Promise((r) => setTimeout(r, 10))
    latch.resolve()
    await Promise.all([slow, queued])

    expect(waits).toHaveLength(2)
    expect(waits[0]!).toBeLessThan(10) // immediate — acquired its slot on the same turn
    expect(waits[1]!).toBeGreaterThan(0) // queued — waited a real macrotask
  })

  it('releases the slot when onStart throws (a throwing hook must not leak _active)', async () => {
    const gate = new ConcurrencyGate(1, 1)
    let taskRan = false
    const first = gate.run(
      async () => {
        taskRan = true
      },
      'background',
      () => {
        throw new Error('onStart boom')
      },
    )
    await expect(first).rejects.toThrow('onStart boom')
    expect(taskRan).toBe(false) // the throw aborted the task before it ran

    // The slot was released despite the throw — a follow-up task acquires it
    // instead of queueing forever behind a leaked `_active` count.
    let secondRan = false
    await gate.run(async () => {
      secondRan = true
    })
    expect(secondRan).toBe(true)
  })
})
