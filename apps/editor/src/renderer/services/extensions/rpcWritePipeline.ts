/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The renderer's outbound half of the extension-host RPC: a single-flight,
 *  bounded write queue feeding `writeStdin`, plus the stdin framing protocol.
 *  Extracted from HostConnection so the backpressure / recovery semantics can
 *  be unit-tested without building the workbench's full MainThread* graph.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type Event, type ILogger } from '@universe-editor/platform'
import {
  BoundedWriteQueue,
  DEFAULT_MAX_PENDING_FRAME_BYTES,
  StdioFramingProtocol,
  eventFrameKey,
  type WriteQueueBatchInfo,
} from '@universe-editor/extensions-common'
import type { ExtHostKind } from '../../../shared/ipc/extensionHostService.js'
import { formatBytes, pushPerfPhaseSample } from '../performance/perfPhases.js'

/**
 * Renderer→host event frames whose payload is a complete, latest-wins state
 * snapshot, so dropping an older queued copy cannot lose information.
 *
 * Deliberately empty today: every state push (active editor, visible editors,
 * selections, window focus, configuration, diagnostics, documents) crosses as
 * an `$accept*` *request*, which is never coalesced, and the only real event
 * frames on this direction are `mainThreadAi` chunk/end streams — incremental
 * content that must arrive in full and in order. Add a `channel:event` only
 * after confirming its payload is a whole snapshot.
 */
const LATEST_WINS_EVENT_KEYS: ReadonlySet<string> = new Set()

/** Queue waits at/above this are recorded as a perf phase. */
const SLOW_WRITE_QUEUE_MS = 5

export interface RpcWritePipelineOptions {
  readonly kind: ExtHostKind
  readonly handle: string
  /** Raw, unframed chunks arriving from the host. */
  readonly onData: Event<string>
  readonly writeStdin: (handle: string, data: string) => Promise<void>
  readonly logger: ILogger
  /** Override the inbound partial-frame cap (tests). */
  readonly maxPendingFrameBytes?: number
  /**
   * The transport is unusable (overflow or write failure). The owner marks the
   * connection dead and stops the host so the existing exit/crash path owns
   * recovery — the queue never invents its own restart.
   */
  readonly onFatal: (reason: string) => void
}

export class RpcWritePipeline extends Disposable {
  readonly protocol: StdioFramingProtocol
  private _failing = false

  constructor(private readonly _options: RpcWritePipelineOptions) {
    super()
    const { kind, handle, logger } = _options
    const prefix = `extension host RPC (${kind}, handle=${handle})`

    const queue = this._register(
      new BoundedWriteQueue({
        sink: (batch) => _options.writeStdin(handle, batch),
        coalesceKey: (frame) => {
          const key = eventFrameKey(frame)
          return key !== undefined && LATEST_WINS_EVENT_KEYS.has(key) ? key : undefined
        },
        onOverflow: (info) => {
          logger.error(
            `${prefix} write queue overflow: queued=${formatBytes(info.queuedBytes)} ` +
              `depth=${info.depth} peak=${formatBytes(info.peakQueuedBytes)}/${info.peakDepth} ` +
              `coalesced=${info.coalescedFrames} frame=${formatBytes(info.frameBytes)} — ` +
              `stopping the host`,
          )
          this._fatal('write queue overflow')
        },
        onFailure: (error, stats) => {
          logger.warn(
            `${prefix} write failed: ${errorMessage(error)} ` +
              `(queued=${formatBytes(stats.queuedBytes)} depth=${stats.depth} ` +
              `coalesced=${stats.coalescedFrames}) — stopping the host`,
          )
          this._fatal('write failure')
        },
        onSoftLimit: (info) => {
          logger.warn(
            `${prefix} write queue above soft limit: queued=${formatBytes(info.queuedBytes)} ` +
              `depth=${info.depth} coalesced=${info.coalescedFrames}`,
          )
        },
        onBatchDrained: (info) => this._recordPerfPhase(info),
      }),
    )

    this.protocol = this._register(
      new StdioFramingProtocol(
        {
          write: (frame) => queue.enqueue(frame),
          onData: _options.onData,
        },
        {
          maxPendingFrameBytes: _options.maxPendingFrameBytes ?? DEFAULT_MAX_PENDING_FRAME_BYTES,
          onOverflow: ({ pendingBytes, limit }) => {
            logger.error(
              `${prefix} inbound frame exceeded ${formatBytes(limit)} ` +
                `(${formatBytes(pendingBytes)} pending) — stopping the host`,
            )
            this._fatal('inbound frame overflow')
          },
        },
      ),
    )
  }

  private _recordPerfPhase(info: WriteQueueBatchInfo): void {
    if (info.waitMs < SLOW_WRITE_QUEUE_MS) return
    pushPerfPhaseSample(
      `extHost.rpcWriteQueue (depth ${info.depth}, ${formatBytes(info.bytes)})`,
      performance.now() - info.waitMs,
      info.waitMs,
    )
  }

  private _fatal(reason: string): void {
    if (this._failing) return
    this._failing = true
    this._options.onFatal(reason)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
