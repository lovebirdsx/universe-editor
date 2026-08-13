/**
 * InterestGate: unique interests cross the wire only on their 0↔n transitions;
 * leases are one-shot; dispose() sends exactly one unsubscribe per unique
 * interest (counts are moot once the owner is gone); failed flips warn, never
 * throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InterestGate } from '../interestGate.js'

interface InterestDto {
  readonly base: string
  readonly pattern: string
}

function makeGate(): {
  gate: InterestGate<InterestDto>
  subscribed: InterestDto[]
  unsubscribed: InterestDto[]
} {
  const subscribed: InterestDto[] = []
  const unsubscribed: InterestDto[] = []
  const gate = new InterestGate<InterestDto>(
    (dto) => {
      subscribed.push(dto)
      return Promise.resolve()
    },
    (dto) => {
      unsubscribed.push(dto)
      return Promise.resolve()
    },
    'test',
  )
  return { gate, subscribed, unsubscribed }
}

const dtoA: InterestDto = { base: '/w', pattern: '**/*.ts' }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InterestGate', () => {
  it('subscribes once for N references of the same key and unsubscribes at zero', () => {
    const { gate, subscribed, unsubscribed } = makeGate()

    const l1 = gate.acquire('k1', dtoA)
    const l2 = gate.acquire('k1', dtoA)
    expect(subscribed).toEqual([dtoA])
    expect(gate.size).toBe(1)

    l1.dispose()
    expect(unsubscribed).toEqual([])
    l2.dispose()
    expect(unsubscribed).toEqual([dtoA])
    expect(gate.size).toBe(0)
  })

  it('tracks distinct keys independently', () => {
    const { gate, subscribed, unsubscribed } = makeGate()
    const dtoB: InterestDto = { base: '/w', pattern: '**/*.js' }

    const la = gate.acquire('a', dtoA)
    const lb = gate.acquire('b', dtoB)
    expect(subscribed).toEqual([dtoA, dtoB])

    la.dispose()
    expect(unsubscribed).toEqual([dtoA])
    lb.dispose()
    expect(unsubscribed).toEqual([dtoA, dtoB])
  })

  it('a lease is one-shot: double dispose releases the interest once', () => {
    const { gate, subscribed, unsubscribed } = makeGate()

    const lease = gate.acquire('k1', dtoA)
    lease.dispose()
    lease.dispose()
    expect(subscribed).toHaveLength(1)
    expect(unsubscribed).toEqual([dtoA])
  })

  it('dispose() unsubscribes each unique interest exactly once, even when shared', () => {
    const { gate, subscribed, unsubscribed } = makeGate()
    const dtoB: InterestDto = { base: '/w', pattern: '**/*.js' }

    gate.acquire('a', dtoA)
    gate.acquire('a', dtoA) // shared: still one unique interest
    gate.acquire('b', dtoB)
    expect(gate.size).toBe(2)

    gate.dispose()
    expect(unsubscribed).toEqual([dtoA, dtoB])
    expect(gate.size).toBe(0)
    expect(subscribed).toHaveLength(2)
  })

  it('leases disposed after dispose() are no-ops', () => {
    const { gate, unsubscribed } = makeGate()

    const lease = gate.acquire('k1', dtoA)
    gate.dispose()
    lease.dispose()
    expect(unsubscribed).toEqual([dtoA])
  })

  it('a failed flip warns and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const gate = new InterestGate<InterestDto>(
      () => Promise.reject(new Error('sub broken')),
      () => Promise.reject(new Error('unsub broken')),
      'test',
    )

    const lease = gate.acquire('k1', dtoA)
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sub broken'))

    lease.dispose()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsub broken'))
  })
})
