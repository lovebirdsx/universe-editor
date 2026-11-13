import { describe, expect, it } from 'vitest'
import { RunQueue, type RunQueueItem, type RunQueueOptions } from '../runQueue.js'

const item = (runId: string, triggerId = 'a'): RunQueueItem => ({ runId, triggerId })

const options = (overrides: Partial<RunQueueOptions> = {}): RunQueueOptions => ({
  concurrency: 1,
  overflow: 'queue',
  ...overrides,
})

describe('RunQueue', () => {
  it('starts runs up to the global limit, then queues', () => {
    const queue = new RunQueue(2)
    expect(queue.enqueue(item('r1', 'a'), options()).status).toBe('started')
    expect(queue.enqueue(item('r2', 'b'), options()).status).toBe('started')
    expect(queue.enqueue(item('r3', 'c'), options()).status).toBe('queued')
    expect(queue.stats()).toEqual({ running: 2, queued: 1 })
    expect(queue.complete('r1')).toEqual([item('r3', 'c')])
    expect(queue.stats()).toEqual({ running: 2, queued: 0 })
  })

  it('enforces per-trigger concurrency', () => {
    const queue = new RunQueue(10)
    expect(queue.enqueue(item('r1'), options({ concurrency: 2 })).status).toBe('started')
    expect(queue.enqueue(item('r2'), options({ concurrency: 2 })).status).toBe('started')
    expect(queue.enqueue(item('r3'), options({ concurrency: 2 })).status).toBe('queued')
    expect(queue.stats('a')).toEqual({ running: 2, queued: 1 })
    expect(queue.complete('r1')).toEqual([item('r3')])
    expect(queue.complete('r2')).toEqual([])
  })

  it('drops on overflow=drop', () => {
    const queue = new RunQueue(1)
    expect(queue.enqueue(item('r1'), options({ overflow: 'drop' })).status).toBe('started')
    expect(queue.enqueue(item('r2'), options({ overflow: 'drop' }))).toEqual({
      status: 'dropped',
      item: item('r2'),
    })
    expect(queue.stats('a')).toEqual({ running: 1, queued: 0 })
  })

  it('drops the oldest queued item when the queue is full', () => {
    const queue = new RunQueue(1)
    expect(queue.enqueue(item('r1'), options({ queueLimit: 2 })).status).toBe('started')
    expect(queue.enqueue(item('r2'), options({ queueLimit: 2 })).status).toBe('queued')
    expect(queue.enqueue(item('r3'), options({ queueLimit: 2 })).status).toBe('queued')
    expect(queue.enqueue(item('r4'), options({ queueLimit: 2 }))).toEqual({
      status: 'dropped-oldest',
      item: item('r4'),
      dropped: item('r2'),
    })
    expect(queue.stats('a')).toEqual({ running: 1, queued: 2 })
    expect(queue.complete('r1')).toEqual([item('r3')])
  })

  it('clears queued items without touching running ones', () => {
    const queue = new RunQueue(1)
    queue.enqueue(item('r1', 'a'), options())
    queue.enqueue(item('r2', 'a'), options())
    queue.enqueue(item('r3', 'b'), options())
    expect(queue.clear('a')).toBe(1)
    expect(queue.stats('a')).toEqual({ running: 1, queued: 0 })
    expect(queue.stats('b')).toEqual({ running: 0, queued: 1 })
    expect(queue.clear()).toBe(1)
    expect(queue.stats()).toEqual({ running: 1, queued: 0 })
  })

  it('starts queued items when the global limit is raised', () => {
    const queue = new RunQueue(1)
    queue.enqueue(item('r1', 'a'), options())
    queue.enqueue(item('r2', 'b'), options())
    expect(queue.setGlobalLimit(3)).toEqual([item('r2', 'b')])
    expect(queue.stats()).toEqual({ running: 2, queued: 0 })
  })

  it('returns an empty list when completing an unknown run', () => {
    const queue = new RunQueue(1)
    expect(queue.complete('missing')).toEqual([])
  })
})
