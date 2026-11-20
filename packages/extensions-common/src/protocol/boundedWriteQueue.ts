/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Bounded, single-flight write queue for an async byte sink.
 *
 *  Why: the stdio RPC transport used to hand every frame straight to
 *  `writeStdin`, which is fire-and-forget — a fast producer (a multi-MB
 *  language-service response, a typing burst) could pile an unbounded number of
 *  promises / frames in the process while the child's stdin pipe was
 *  backpressured. This queue keeps at most one sink call in flight, batches the
 *  frames that accumulate behind it, and bounds the memory it can hold.
 *
 *  Coalescing is opt-in per frame via `coalesceKey`: only frames the caller
 *  declares "latest-wins" (a complete state snapshot) are collapsed to their
 *  newest copy while over the soft limit. Requests and incremental content must
 *  return `undefined` so they are never dropped or reordered.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '@universe-editor/platform'

export const DEFAULT_SOFT_LIMIT_BYTES = 8 * 1024 * 1024
export const DEFAULT_HARD_LIMIT_BYTES = 64 * 1024 * 1024
export const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024
/** Minimum spacing between soft-limit warnings so a flood produces one line, not thousands. */
export const DEFAULT_SOFT_LIMIT_WARN_INTERVAL_MS = 5_000

export interface WriteQueueStats {
  /** Frames currently queued behind the in-flight sink call. */
  readonly depth: number
  /** Sum of queued frame sizes (UTF-16 code units — ≈ bytes for the ASCII-dominant JSON wire). */
  readonly queuedBytes: number
  readonly peakDepth: number
  readonly peakQueuedBytes: number
  /** Frames dropped by coalescing over the queue's lifetime. */
  readonly coalescedFrames: number
  /** Sink calls dispatched over the queue's lifetime. */
  readonly batches: number
  /** Longest time a batch's oldest frame waited between enqueue and dispatch. */
  readonly maxWaitMs: number
  readonly inFlight: boolean
  readonly failed: boolean
  readonly disposed: boolean
}

export interface WriteQueueOverflowInfo extends WriteQueueStats {
  /** Size of the frame whose enqueue crossed the hard limit. */
  readonly frameBytes: number
}

export interface WriteQueueSoftLimitInfo {
  readonly depth: number
  readonly queuedBytes: number
  readonly coalescedFrames: number
}

export interface WriteQueueBatchInfo {
  /** Frames in this batch. */
  readonly frames: number
  /** Total size of this batch. */
  readonly bytes: number
  /** How long the batch's oldest frame waited before dispatch. */
  readonly waitMs: number
  /** Queue depth at dispatch (this batch plus frames still waiting). */
  readonly depth: number
}

export interface BoundedWriteQueueOptions {
  /** Receives one (possibly batched) write. Its settlement is the drain signal. */
  readonly sink: (batch: string) => Promise<void>
  /**
   * Returns a coalescing key for latest-wins frames, or `undefined` for frames
   * that must never be merged (requests, responses, incremental content).
   */
  readonly coalesceKey: (frame: string) => string | undefined
  readonly softLimitBytes?: number
  readonly hardLimitBytes?: number
  readonly maxBatchBytes?: number
  /** Called once when queued bytes cross the hard limit; the queue then stops. */
  readonly onOverflow?: (info: WriteQueueOverflowInfo) => void
  /** Called once on the first sink rejection; the queue then stops. */
  readonly onFailure?: (error: unknown, info: WriteQueueStats) => void
  /** Rate-limited warning when queued bytes first cross the soft limit. */
  readonly onSoftLimit?: (info: WriteQueueSoftLimitInfo) => void
  /** Per-batch observation (used for perf phases). */
  readonly onBatchDrained?: (info: WriteQueueBatchInfo) => void
  /** Spacing between soft-limit warnings. */
  readonly softLimitWarnIntervalMs?: number
}

interface QueuedFrame {
  /** Cleared when the frame is coalesced so the payload is not retained. */
  frame: string
  readonly size: number
  readonly key: string | undefined
  readonly enqueuedAt: number
  tombstoned: boolean
}

export class BoundedWriteQueue extends Disposable {
  /**
   * Append-only within a compaction window; `_head` marks the first entry that
   * has not been dispatched. Coalesced entries are tombstoned in place and
   * skipped by `_pump`, so dequeue is O(1) instead of O(n) `shift()`.
   */
  private _queue: QueuedFrame[] = []
  private _head = 0
  /** Live (non-tombstoned) frames still queued. */
  private _depth = 0
  private _queuedBytes = 0
  /**
   * Live queued frames per coalescing key. A key can have several entries while
   * the queue is under the soft limit (they are only merged once it is crossed).
   */
  private readonly _liveByKey = new Map<string, Set<QueuedFrame>>()
  private _peakDepth = 0
  private _peakQueuedBytes = 0
  private _coalescedFrames = 0
  private _batches = 0
  private _maxWaitMs = 0
  private _inFlight = false
  private _failed = false
  private _disposed = false
  private _lastSoftLimitWarnAt = Number.NEGATIVE_INFINITY

  private readonly _softLimitBytes: number
  private readonly _hardLimitBytes: number
  private readonly _maxBatchBytes: number
  private readonly _softLimitWarnIntervalMs: number

  constructor(private readonly _options: BoundedWriteQueueOptions) {
    super()
    this._softLimitBytes = _options.softLimitBytes ?? DEFAULT_SOFT_LIMIT_BYTES
    this._hardLimitBytes = _options.hardLimitBytes ?? DEFAULT_HARD_LIMIT_BYTES
    this._maxBatchBytes = _options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
    this._softLimitWarnIntervalMs =
      _options.softLimitWarnIntervalMs ?? DEFAULT_SOFT_LIMIT_WARN_INTERVAL_MS
  }

  get stats(): WriteQueueStats {
    return {
      depth: this._depth,
      queuedBytes: this._queuedBytes,
      peakDepth: this._peakDepth,
      peakQueuedBytes: this._peakQueuedBytes,
      coalescedFrames: this._coalescedFrames,
      batches: this._batches,
      maxWaitMs: this._maxWaitMs,
      inFlight: this._inFlight,
      failed: this._failed,
      disposed: this._disposed,
    }
  }

  /** Enqueue one self-delimiting frame. A no-op after a failure or dispose. */
  enqueue(frame: string): void {
    if (this._disposed || this._failed) return

    const size = frame.length
    const key = this._options.coalesceKey(frame)
    if (key !== undefined && this._queuedBytes + size > this._softLimitBytes) {
      this._coalesce(key)
    }

    const entry: QueuedFrame = { frame, size, key, enqueuedAt: now(), tombstoned: false }
    this._queue.push(entry)
    if (key !== undefined) {
      const live = this._liveByKey.get(key)
      if (live) live.add(entry)
      else this._liveByKey.set(key, new Set([entry]))
    }
    this._depth++
    this._queuedBytes += size
    if (this._depth > this._peakDepth) this._peakDepth = this._depth
    if (this._queuedBytes > this._peakQueuedBytes) this._peakQueuedBytes = this._queuedBytes

    if (this._queuedBytes > this._softLimitBytes) this._warnSoftLimit()
    if (this._queuedBytes > this._hardLimitBytes) {
      this._failOverflow(size)
      return
    }

    this._pump()
  }

  /** Drop every queued frame for `key`, keeping only the one about to be appended. */
  private _coalesce(key: string): void {
    const live = this._liveByKey.get(key)
    if (!live) return
    for (const entry of live) {
      if (entry.tombstoned) continue
      entry.tombstoned = true
      entry.frame = ''
      this._depth--
      this._queuedBytes -= entry.size
      this._coalescedFrames++
    }
    this._liveByKey.delete(key)
  }

  private _warnSoftLimit(): void {
    const timestamp = now()
    if (timestamp - this._lastSoftLimitWarnAt < this._softLimitWarnIntervalMs) return
    this._lastSoftLimitWarnAt = timestamp
    this._isolated(() =>
      this._options.onSoftLimit?.({
        depth: this._depth,
        queuedBytes: this._queuedBytes,
        coalescedFrames: this._coalescedFrames,
      }),
    )
  }

  private _pump(): void {
    if (this._inFlight || this._failed || this._disposed || this._depth === 0) return

    this._skipTombstones()
    const oldest = this._queue[this._head]
    if (!oldest) return
    const waitMs = Math.max(0, now() - oldest.enqueuedAt)
    const batch: string[] = []
    let bytes = 0

    while (this._head < this._queue.length) {
      const next = this._queue[this._head]!
      if (next.tombstoned) {
        this._head++
        continue
      }
      // Cap batches, but still send a single frame that is itself over the cap
      // (splitting a frame would corrupt the newline-delimited wire).
      if (batch.length > 0 && bytes + next.size > this._maxBatchBytes) break
      this._head++
      this._depth--
      this._queuedBytes -= next.size
      this._untrack(next)
      batch.push(next.frame)
      bytes += next.size
      if (bytes >= this._maxBatchBytes) break
    }
    this._compact()

    const depth = batch.length + this._depth
    this._inFlight = true
    this._batches++
    if (waitMs > this._maxWaitMs) this._maxWaitMs = waitMs

    let result: Promise<void>
    try {
      result = this._options.sink(batch.join(''))
    } catch (err) {
      result = Promise.reject(err)
    }
    result.then(
      () => this._onDrained(waitMs, batch.length, bytes, depth),
      (err: unknown) => this._onFailure(err),
    )
  }

  private _skipTombstones(): void {
    while (this._head < this._queue.length && this._queue[this._head]!.tombstoned) {
      this._head++
    }
  }

  private _untrack(entry: QueuedFrame): void {
    if (entry.key === undefined) return
    const live = this._liveByKey.get(entry.key)
    if (!live) return
    live.delete(entry)
    if (live.size === 0) this._liveByKey.delete(entry.key)
  }

  /** Reclaim the dead prefix once it dominates, bounding memory between drains. */
  private _compact(): void {
    if (this._head > 1024 && this._head > this._queue.length / 2) {
      this._queue = this._queue.slice(this._head)
      this._head = 0
    }
  }

  private _onDrained(waitMs: number, frames: number, bytes: number, depth: number): void {
    this._inFlight = false
    if (this._disposed || this._failed) return
    this._isolated(() => this._options.onBatchDrained?.({ frames, bytes, waitMs, depth }))
    this._pump()
  }

  private _onFailure(error: unknown): void {
    this._inFlight = false
    if (this._disposed || this._failed) return
    this._failed = true
    const stats = this.stats
    this._clear()
    this._isolated(() => this._options.onFailure?.(error, stats))
  }

  private _failOverflow(frameBytes: number): void {
    this._failed = true
    const info: WriteQueueOverflowInfo = { ...this.stats, frameBytes }
    this._clear()
    this._isolated(() => this._options.onOverflow?.(info))
  }

  private _clear(): void {
    this._queue = []
    this._head = 0
    this._depth = 0
    this._queuedBytes = 0
    this._liveByKey.clear()
  }

  /** Diagnostic callbacks must never break the queue's invariants. */
  private _isolated(run: () => void): void {
    try {
      run()
    } catch {
      /* observability is not a protocol failure */
    }
  }

  override dispose(): void {
    if (this._disposed) {
      super.dispose()
      return
    }
    this._disposed = true
    this._clear()
    super.dispose()
  }
}

function now(): number {
  return performance.now()
}
