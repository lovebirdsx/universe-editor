/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Concurrency / overflow decisions for trigger runs. This class only tracks slots and
 *  queues; it never executes anything. Callers start the returned items themselves.
 *--------------------------------------------------------------------------------------------*/

import { TRIGGER_DEFAULTS, type TriggerOverflow } from './types.js'

export interface RunQueueItem {
  readonly runId: string
  readonly triggerId: string
}

export interface RunQueueOptions {
  readonly concurrency: number
  readonly overflow: TriggerOverflow
  readonly queueLimit?: number
}

export type RunQueueEnqueueResult<T extends RunQueueItem> =
  | { readonly status: 'started'; readonly item: T }
  | { readonly status: 'queued'; readonly item: T }
  | { readonly status: 'dropped'; readonly item: T }
  | { readonly status: 'dropped-oldest'; readonly item: T; readonly dropped: T }

export interface RunQueueStats {
  readonly running: number
  readonly queued: number
}

interface QueuedEntry<T extends RunQueueItem> {
  readonly item: T
  readonly options: RunQueueOptions
}

interface TriggerQueue<T extends RunQueueItem> {
  readonly items: QueuedEntry<T>[]
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.floor(value))
}

export class RunQueue<T extends RunQueueItem = RunQueueItem> {
  private readonly _running = new Map<string, { readonly triggerId: string }>()
  private readonly _queues = new Map<string, TriggerQueue<T>>()
  private _globalLimit: number

  constructor(globalLimit: number = TRIGGER_DEFAULTS.maxConcurrentRuns) {
    this._globalLimit = Math.max(0, Math.floor(globalLimit))
  }

  enqueue(item: T, options: RunQueueOptions): RunQueueEnqueueResult<T> {
    const concurrency = normalizeConcurrency(options.concurrency)
    if (this._canStart(item.triggerId, concurrency)) {
      this._running.set(item.runId, { triggerId: item.triggerId })
      return { status: 'started', item }
    }
    if (options.overflow === 'drop') return { status: 'dropped', item }

    const queueLimit = Math.max(0, Math.floor(options.queueLimit ?? TRIGGER_DEFAULTS.queueLimit))
    if (queueLimit === 0) return { status: 'dropped', item }
    const queue = this._queues.get(item.triggerId) ?? { items: [] }
    this._queues.set(item.triggerId, queue)
    if (queue.items.length >= queueLimit) {
      const dropped = queue.items.shift()
      queue.items.push({ item, options })
      if (dropped === undefined) return { status: 'queued', item }
      return { status: 'dropped-oldest', item, dropped: dropped.item }
    }
    queue.items.push({ item, options })
    return { status: 'queued', item }
  }

  /** Frees the run's slot and returns every item that may start now. */
  complete(runId: string): T[] {
    this._running.delete(runId)
    return this._drain()
  }

  /** Clears queued (not running) items; returns how many were discarded. */
  clear(triggerId?: string): number {
    if (triggerId !== undefined) {
      const queue = this._queues.get(triggerId)
      if (queue === undefined) return 0
      const cleared = queue.items.length
      queue.items.length = 0
      return cleared
    }
    let cleared = 0
    for (const queue of this._queues.values()) {
      cleared += queue.items.length
      queue.items.length = 0
    }
    return cleared
  }

  setGlobalLimit(limit: number): T[] {
    this._globalLimit = Math.max(0, Math.floor(limit))
    return this._drain()
  }

  /** Per-trigger stats; without `triggerId`, totals across all triggers. */
  stats(triggerId?: string): RunQueueStats {
    if (triggerId !== undefined) {
      return { running: this._runningFor(triggerId), queued: this._queuedFor(triggerId) }
    }
    let queued = 0
    for (const queue of this._queues.values()) queued += queue.items.length
    return { running: this._running.size, queued }
  }

  private _runningFor(triggerId: string): number {
    let count = 0
    for (const entry of this._running.values()) {
      if (entry.triggerId === triggerId) count++
    }
    return count
  }

  private _queuedFor(triggerId: string): number {
    return this._queues.get(triggerId)?.items.length ?? 0
  }

  private _canStart(triggerId: string, concurrency: number): boolean {
    return this._running.size < this._globalLimit && this._runningFor(triggerId) < concurrency
  }

  private _drain(): T[] {
    const started: T[] = []
    for (const [triggerId, queue] of this._queues) {
      while (queue.items.length > 0) {
        const next = queue.items[0]
        if (next === undefined || !this._canStart(triggerId, next.options.concurrency)) break
        queue.items.shift()
        this._running.set(next.item.runId, { triggerId })
        started.push(next.item)
      }
    }
    return started
  }
}
