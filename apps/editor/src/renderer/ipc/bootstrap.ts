/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side IPC bootstrap: wraps the preload bridge in an IpcService.
 *--------------------------------------------------------------------------------------------*/

import {
  IpcService,
  formatIpcFrameAlert,
  frameTarget,
  setIpcEncodeObserver,
  setIpcFrameDiagnostics,
  type ILogger,
  type IpcDecodeObservation,
  type IpcEncodeObservation,
  type IpcFrameObservation,
} from '@universe-editor/platform'
import type { IpcBridge } from '../../preload/index.js'
import { formatBytes, pushPerfPhaseSample } from '../services/performance/perfPhases.js'
import { RendererElectronProtocol } from './electronProtocol.js'

/** A single frame's encode/decode must block the main thread at least this long to be recorded. */
const FRAME_SLOW_MS = 5

// 大帧即使解码很快也独立记录：此前约 18.5MiB 的消息未触及 32MiB 告警线，
// 且日志缺少通道，无法确定载荷来源。此诊断阈值不改变帧闸门的拒绝策略。
export const LARGE_FRAME_LOG_BYTES = 4 * 1024 * 1024

/** At most one line per target per window. */
const LARGE_FRAME_LOG_WINDOW_MS = 10_000
/** Hard cap on tracked targets, so a stream of distinct ones cannot grow the map. */
const LARGE_FRAME_LOG_MAX_KEYS = 64

// Key -> last admitted time, in Map insertion order (= LRU order: an admit re-inserts its
// key, so the oldest entry sits at the front and is the one evicted at capacity).
const largeFrameLoggedAt = new Map<string, number>()

/** Test seam: drop the limiter's state. */
export function resetIpcDecodeDiagnosticsForTests(): void {
  largeFrameLoggedAt.clear()
}

/**
 * Whether this occurrence may write a line. `now` is passed in (feed `Date.now()`) so the
 * window is testable without fake timers.
 */
export function admitLargeFrameLog(key: string, now: number): boolean {
  const last = largeFrameLoggedAt.get(key)
  if (last !== undefined && now - last < LARGE_FRAME_LOG_WINDOW_MS) return false
  if (last !== undefined) {
    largeFrameLoggedAt.delete(key)
  } else if (largeFrameLoggedAt.size >= LARGE_FRAME_LOG_MAX_KEYS) {
    const oldest = largeFrameLoggedAt.keys().next().value
    if (oldest !== undefined) largeFrameLoggedAt.delete(oldest)
  }
  largeFrameLoggedAt.set(key, now)
  return true
}

const describeFrame = (info: IpcFrameObservation): string =>
  `${frameTarget(info.type, info.channel, info.name, info.id)}, ${formatBytes(info.bytes)}`

/**
 * Sink for the platform's inbound-decode observation. Two independent reactions to one
 * measurement, so neither a fast-but-huge nor a slow-but-small frame can hide:
 *  - a slow decode becomes a single named perf phase (kind, channel, method, id, size)
 *    that the interaction/tab-switch reports can attribute — the size-only sample this
 *    replaces described the same decode and is gone, not joined;
 *  - a ≥4MiB frame is warned about through the frame log, rate-limited per target, so a
 *    loop of large replies cannot bury the log it exists to keep readable.
 * Only the frame's shape is ever written: the observation carries no body and no args.
 */
export function recordInboundDecode(info: IpcDecodeObservation): void {
  if (info.durationMs >= FRAME_SLOW_MS) {
    pushPerfPhaseSample(`ipc.decode (${describeFrame(info)})`, info.startTime, info.durationMs)
  }
  if (info.bytes < LARGE_FRAME_LOG_BYTES) return
  const key = `in|${info.type}|${info.channel}|${info.name}`
  if (!admitLargeFrameLog(key, Date.now())) return
  const size = formatIpcFrameAlert({
    bytes: info.bytes,
    direction: 'in',
    type: info.type,
    channel: info.channel,
    name: info.name,
    id: info.id,
  })
  emitFrameAlert('warn', `[ipc] ${size}, decode ${info.durationMs.toFixed(1)}ms`)
}

/** Cumulative outbound-encode diagnostics (E2E probe / crash reports). */
export interface IpcEncodeStats {
  readonly count: number
  readonly largeCount: number
  readonly slowCount: number
  readonly largestBytes: number
  readonly largest: IpcEncodeObservation | null
  readonly recent: readonly IpcEncodeObservation[]
}

const ENCODE_RECENT_MAX = 32
let encodeCount = 0
let encodeLargeCount = 0
let encodeSlowCount = 0
let encodeLargestBytes = 0
let encodeLargest: IpcEncodeObservation | null = null
let encodeRecent: IpcEncodeObservation[] = []

export function resetIpcEncodeStats(): void {
  encodeCount = 0
  encodeLargeCount = 0
  encodeSlowCount = 0
  encodeLargestBytes = 0
  encodeLargest = null
  encodeRecent = []
}

export function getIpcEncodeStats(): IpcEncodeStats {
  return {
    count: encodeCount,
    largeCount: encodeLargeCount,
    slowCount: encodeSlowCount,
    largestBytes: encodeLargestBytes,
    largest: encodeLargest,
    recent: encodeRecent,
  }
}

/**
 * Sink for the platform's outbound-encode observation. An encode is the sender's
 * half of the same stall: a multi-MB request serializes synchronously before it
 * can be sent. A slow one becomes an `ipc.encode` phase naming kind, channel,
 * method, id and size; a ≥4MiB one also warns through the same per-target limiter
 * as inbound frames (with an `out` key so the two directions do not mask each
 * other). The body is never observed or logged.
 */
export function recordOutboundEncode(info: IpcEncodeObservation): void {
  encodeCount++
  if (info.bytes >= LARGE_FRAME_LOG_BYTES) encodeLargeCount++
  if (info.durationMs >= FRAME_SLOW_MS) encodeSlowCount++
  if (info.bytes > encodeLargestBytes) {
    encodeLargestBytes = info.bytes
    encodeLargest = info
  }
  encodeRecent.push(info)
  if (encodeRecent.length > ENCODE_RECENT_MAX) {
    encodeRecent.splice(0, encodeRecent.length - ENCODE_RECENT_MAX)
  }
  if (info.durationMs >= FRAME_SLOW_MS) {
    pushPerfPhaseSample(`ipc.encode (${describeFrame(info)})`, info.startTime, info.durationMs)
  }
  if (info.bytes < LARGE_FRAME_LOG_BYTES) return
  const key = `out|${info.type}|${info.channel}|${info.name}`
  if (!admitLargeFrameLog(key, Date.now())) return
  const size = formatIpcFrameAlert({
    bytes: info.bytes,
    direction: 'out',
    type: info.type,
    channel: info.channel,
    name: info.name,
    id: info.id,
  })
  emitFrameAlert('warn', `[ipc] ${size}, encode ${info.durationMs.toFixed(1)}ms`)
}

type FrameLogSink = Pick<ILogger, 'warn' | 'error'>

/**
 * Late-bound, because the ordering is forced: the frame guard has to be armed before the
 * first frame arrives, and frames start flowing the moment the first channel is proxied —
 * which is during DI construction, a hundred lines before the file-backed logger exists.
 * The console fallback covers only that window; in practice it never fires, since nothing
 * oversized crosses during the handshake.
 */
let frameLog: FrameLogSink | undefined

export function bindIpcFrameLog(logger: FrameLogSink): void {
  frameLog = logger
}

function emitFrameAlert(level: 'warn' | 'error', message: string): void {
  if (frameLog) {
    if (level === 'error') frameLog.error(message)
    else frameLog.warn(message)
  } else {
    console[level](message)
  }
}

export function createRendererIpcService(bridge: IpcBridge = window.ipc): IpcService {
  // Attribute slow frame encodes; decoding is attributed from the observation below, which
  // additionally knows what the frame turned out to be.
  setIpcEncodeObserver(recordOutboundEncode)
  // Surface what the frame guard refuses. Silently dropping an over-limit frame would
  // turn a size problem into an unexplained "this file will not open", and the whole
  // point of the guard is that the next crash report can name the payload.
  setIpcFrameDiagnostics({
    onWarn: (info) => emitFrameAlert('warn', `[ipc] ${formatIpcFrameAlert(info)}`),
    onOversized: (info) => emitFrameAlert('error', `[ipc] ${formatIpcFrameAlert(info)}`),
  })
  return new IpcService(new RendererElectronProtocol(bridge), { onDecoded: recordInboundDecode })
}
