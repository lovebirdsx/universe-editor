import { describe, expect, it } from 'vitest'
import {
  forget,
  isProcessed,
  markQueued,
  markStarted,
  pendingQueued,
  prune,
  type ProcessedKeys,
} from '../dedupe.js'

describe('dedupe', () => {
  it('marks keys queued and started without mutating the input', () => {
    const empty: ProcessedKeys = {}
    const queued = markQueued(empty, 'swarm:1', 100)
    expect(empty).toEqual({})
    expect(queued['swarm:1']).toEqual({ at: 100, status: 'queued' })
    const started = markStarted(queued, 'swarm:1', 200)
    expect(queued['swarm:1']).toEqual({ at: 100, status: 'queued' })
    expect(started['swarm:1']).toEqual({ at: 200, status: 'started' })
  })

  it('reports processed keys and forgets them', () => {
    const keys = markStarted(markQueued({}, 'poll:a', 1), 'poll:b', 2)
    expect(isProcessed(keys, 'poll:a')).toBe(true)
    expect(isProcessed(keys, 'poll:c')).toBe(false)
    const next = forget(keys, 'poll:a')
    expect(isProcessed(next, 'poll:a')).toBe(false)
    expect(isProcessed(next, 'poll:b')).toBe(true)
    expect(forget(next, 'missing')).toBe(next)
  })

  it('lists only queued keys in chronological order', () => {
    let keys: ProcessedKeys = {}
    keys = markQueued(keys, 'late', 300)
    keys = markQueued(keys, 'early', 100)
    keys = markStarted(keys, 'started', 50)
    keys = markQueued(keys, 'middle', 200)
    expect(pendingQueued(keys)).toEqual(['early', 'middle', 'late'])
  })

  it('prunes expired keys by age', () => {
    let keys: ProcessedKeys = {}
    keys = markQueued(keys, 'old', 1_000)
    keys = markQueued(keys, 'fresh', 9_000)
    const pruned = prune(keys, 10_000, { limit: 100, ttlMs: 5_000 })
    expect(Object.keys(pruned)).toEqual(['fresh'])
  })

  it('evicts the oldest keys beyond the limit', () => {
    let keys: ProcessedKeys = {}
    for (let index = 0; index < 5; index++) keys = markQueued(keys, `k${index}`, index)
    const pruned = prune(keys, 10, { limit: 2, ttlMs: 1_000_000 })
    expect(Object.keys(pruned).sort()).toEqual(['k3', 'k4'])
  })

  it('keeps nothing when the limit is zero', () => {
    expect(prune(markQueued({}, 'k', 1), 2, { limit: 0, ttlMs: 1_000 })).toEqual({})
  })
})
