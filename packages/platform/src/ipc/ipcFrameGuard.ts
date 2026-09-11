/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Frame-size guard for the JSON IPC envelope.
 *
 *  Why this exists: `defaultCodec.decode` is `JSON.parse(TextDecoder().decode(data))`,
 *  so a single inbound frame costs several times its wire size before anything in the
 *  app can react — the decoded string, the parse tree, and (for `$u8` payloads) the
 *  base64 text plus the rebuilt bytes all coexist. A renderer already holding gigabytes
 *  of live strings dies inside that one allocation, which is exactly what the crash
 *  dumps show: `parse ← decode`, `ran out of reservation`, 3.8GB of live lo_space.
 *
 *  So the frame size is treated as a first-class bound rather than a diagnostic: frames
 *  above the limit are refused, and every frame that crosses the warn line is counted
 *  so the next crash report can name the payload instead of guessing.
 *--------------------------------------------------------------------------------------------*/

const KIB = 1024
const MIB = 1024 * KIB

/**
 * Frames at or above this are counted and reported but still delivered. Set just above
 * the largest legitimate frame the app produces (ACP agent stdout is capped at 16MB by
 * `MAX_STDOUT_LINE_BYTES`, the workspace listing peaks around 8MB) yet below the
 * image-bearing prompt envelope (~34MB), so an oversized-by-design payload shows up in
 * the log rather than silently costing ~3.5× its size on decode.
 */
export const IPC_FRAME_WARN_BYTES = 32 * MIB

/**
 * Frames above this are refused. The default-config worst case is ~35MB, so this leaves
 * 3.6× headroom while keeping the worst decode peak (~3.5 × 128MB) inside what a 4GB
 * heap can absorb. Refusing is deliberately louder than dying: the sender degrades to an
 * `IPC_FRAME_TOO_LARGE` error response, so callers get a rejected promise instead of a
 * promise that never settles.
 */
export const IPC_FRAME_MAX_BYTES = 128 * MIB

export const IPC_FRAME_TOO_LARGE_CODE = 'IPC_FRAME_TOO_LARGE'

export type IpcFrameVerdict = 'ok' | 'warn' | 'oversized'

/** Single decision point for frame size — pure, so codec, senders and tests agree. */
export function classifyIpcFrame(bytes: number): IpcFrameVerdict {
  if (bytes > IPC_FRAME_MAX_BYTES) return 'oversized'
  if (bytes >= IPC_FRAME_WARN_BYTES) return 'warn'
  return 'ok'
}

/**
 * Throws when the frame is over the limit. The one assertion every codec calls in both
 * directions, which is what makes the bound hold no matter which codec is in play — the
 * JSON one, the extension host's newline codec, or the remote tunnel's binary one.
 *
 * Returns normally rather than returning a verdict on purpose: the caller's next act is
 * always to build or parse the payload, and a boolean nobody checks is no guard at all.
 */
export function assertIpcFrameWithinLimit(bytes: number): void {
  if (bytes > IPC_FRAME_MAX_BYTES) throw new IpcFrameTooLargeError(bytes)
}

/**
 * Carries `code` so it survives the wire as a structured `WireError`: the receiving
 * side branches on identity rather than the human message.
 */
export class IpcFrameTooLargeError extends Error {
  readonly code = IPC_FRAME_TOO_LARGE_CODE
  constructor(
    readonly bytes: number,
    readonly limit: number = IPC_FRAME_MAX_BYTES,
  ) {
    super(`IPC frame of ${bytes} bytes exceeds the ${limit}-byte limit`)
    this.name = 'IpcFrameTooLargeError'
  }
}

export interface IpcFrameRecord {
  readonly ts: number
  readonly direction: 'in' | 'out'
  readonly bytes: number
  /** Message kind, or `'unparsed'` when the frame was refused before decoding. */
  readonly type: string
  readonly channel: string
  /** Command / event name within the channel; empty when unknown. */
  readonly name: string
}

export interface IpcFrameSizeInfo {
  readonly bytes: number
  readonly direction: 'in' | 'out'
  readonly channel: string
  readonly name: string
}

export interface IpcFrameOversizedInfo extends IpcFrameSizeInfo {
  readonly limit: number
  /**
   * Refusals of this same target folded away since the previous report. Absent on the
   * first report; the durable counter holds the true total either way.
   */
  readonly suppressed?: number
}

export interface IpcFrameDiagnosticsOptions {
  readonly onOversized?: (info: IpcFrameOversizedInfo) => void
  readonly onWarn?: (info: IpcFrameSizeInfo) => void
}

let diagnostics: IpcFrameDiagnosticsOptions | undefined

function now(): number {
  return clock()
}
let clock: () => number = Date.now

/**
 * Wire the process-side sinks (logger + telemetry). `packages/platform` is Node-only and
 * cannot reach Electron's log paths, so each embedder installs its own sink at startup.
 * Not installing one is safe: frames are still classified, counted and recorded.
 */
export function setIpcFrameDiagnostics(options: IpcFrameDiagnosticsOptions | undefined): void {
  diagnostics = options
}

/**
 * A systematic oversize — one huge file read on a loop, a channel that always returns
 * too much — would otherwise emit a line per call and bury its own signal: the crash
 * package this guard came from contained 225 copies of a single message. Repeats of the
 * same target inside the window are counted and reported once, with the multiplier, when
 * the window turns over. The durable counter keeps the true total, so folding loses no
 * information, only noise.
 */
const ALERT_FOLD_WINDOW_MS = 1000
let alertKey = ''
let alertSince = 0
let alertSuppressed = 0

/** `undefined` = stay quiet; otherwise how many occurrences were folded since last time. */
function admitAlert(key: string): number | undefined {
  const at = now()
  if (key !== alertKey) {
    alertKey = key
    alertSince = at
    alertSuppressed = 0
    return 0
  }
  if (at - alertSince >= ALERT_FOLD_WINDOW_MS) {
    const suppressed = alertSuppressed
    alertSince = at
    alertSuppressed = 0
    return suppressed
  }
  alertSuppressed++
  return undefined
}

// Preallocated ring over *every* frame. Recording runs on the hot path, so it must not
// allocate — `push`/`shift` would churn garbage precisely while the heap is under
// pressure. 64 slots is the tail a crash report is read for; sizes are kept both here
// and in the durable counters below because a burst of small frames can evict the tail.
const RING_SIZE = 64
// Mutable twin of IpcFrameRecord: the public shape is readonly, the slots are rewritten
// in place so recording never allocates.
type MutableFrameRecord = {
  ts: number
  direction: 'in' | 'out'
  bytes: number
  type: string
  channel: string
  name: string
}
const ring: MutableFrameRecord[] = []
let ringCursor = 0
let ringFilled = 0

for (let i = 0; i < RING_SIZE; i++) {
  ring.push({ ts: 0, direction: 'in', bytes: 0, type: '', channel: '', name: '' })
}

// Durable scalars, immune to ring eviction. The interesting question after a crash is
// usually "what is the largest thing this process ever put on the wire", which a tail
// window cannot answer once traffic resumes.
let framesSeen = 0
let warnedFrames = 0
let oversizedFrames = 0
let largestBytes = 0
let largestLabel = ''

/**
 * File one frame: ring slot, durable counters, and the sinks when it crosses a line.
 *
 * Positional args and no object literal on the steady path on purpose — this runs once
 * per message, and allocating per frame is exactly the garbage the heap does not need
 * while it is already under pressure. The info objects the sinks receive are built only
 * on the rare tiers, where the allocation cannot matter.
 */
export function reportIpcFrame(
  direction: 'in' | 'out',
  bytes: number,
  type: string,
  channel: string,
  name: string,
): void {
  framesSeen++
  // Tracked for every frame, not just the flagged ones: "what is the largest frame this
  // process ever sent" is the question worth answering after a crash, and a 31MiB frame
  // that stayed under the warn line is still the answer.
  if (bytes > largestBytes) {
    largestBytes = bytes
    largestLabel = labelFor(direction, type, channel, name)
  }
  const verdict = classifyIpcFrame(bytes)
  if (verdict !== 'ok') {
    if (verdict === 'oversized') {
      oversizedFrames++
      const key = `${direction}|${channel}|${name}`
      const suppressed = admitAlert(key)
      if (suppressed !== undefined) {
        diagnostics?.onOversized?.({
          bytes,
          direction,
          channel,
          name,
          limit: IPC_FRAME_MAX_BYTES,
          ...(suppressed > 0 ? { suppressed } : {}),
        })
      }
    } else {
      warnedFrames++
      diagnostics?.onWarn?.({ bytes, direction, channel, name })
    }
  }
  const slot = ring[ringCursor]
  if (slot) {
    slot.ts = Date.now()
    slot.direction = direction
    slot.bytes = bytes
    slot.type = type
    slot.channel = channel
    slot.name = name
  }
  ringCursor = (ringCursor + 1) % RING_SIZE
  if (ringFilled < RING_SIZE) ringFilled++
}

function labelFor(direction: string, type: string, channel: string, name: string): string {
  const target = name.length > 0 ? `${channel}.${name}` : channel
  return `${direction} ${type} ${target}`
}

export interface IpcFrameStats {
  readonly seen: number
  readonly warned: number
  readonly oversized: number
  readonly largestBytes: number
  readonly largestLabel: string
}

export function ipcFrameStats(): IpcFrameStats {
  return {
    seen: framesSeen,
    warned: warnedFrames,
    oversized: oversizedFrames,
    largestBytes,
    largestLabel,
  }
}

/** Oldest-first snapshot of the recent tail. */
export function snapshotIpcFrames(): readonly IpcFrameRecord[] {
  if (ringFilled === 0) return []
  const start = ringFilled < RING_SIZE ? 0 : ringCursor
  const out: IpcFrameRecord[] = []
  for (let i = 0; i < ringFilled; i++) {
    const slot = ring[(start + i) % RING_SIZE]
    if (slot) out.push({ ...slot })
  }
  return out
}

/**
 * One-line description of an alert, shared by every process's sink so main and renderer
 * logs read the same. Kept here rather than in each embedder because the wording is part
 * of what a future reader greps for, and two copies would drift.
 */
export function formatIpcFrameAlert(info: IpcFrameSizeInfo | IpcFrameOversizedInfo): string {
  const target = info.name.length > 0 ? `${info.channel}.${info.name}` : info.channel
  const where = target.length > 0 ? ` (${target})` : ''
  const size = `${(info.bytes / MIB).toFixed(1)}MB`
  if ('limit' in info) {
    const folded = info.suppressed ? `, +${info.suppressed} more folded` : ''
    return `refused ${info.direction}bound ipc frame ${size}, over the ${(info.limit / MIB).toFixed(0)}MB limit${where}${folded}`
  }
  return `large ${info.direction}bound ipc frame ${size}${where}`
}

/** Human-readable dump for a crash report: the durable summary, then the recent tail. */
export function formatIpcFrames(limit = 24): string {
  const stats = ipcFrameStats()
  const headline =
    `ipc frames seen=${stats.seen} warned>=${Math.round(IPC_FRAME_WARN_BYTES / MIB)}MiB=${stats.warned} ` +
    `oversized=${stats.oversized} largest=${Math.round(stats.largestBytes / KIB)}KiB` +
    (stats.largestLabel.length > 0 ? ` (${stats.largestLabel})` : '')
  const frames = snapshotIpcFrames()
  const shown = limit > 0 ? frames.slice(Math.max(0, frames.length - limit)) : frames
  if (shown.length === 0) return `${headline}\nno ipc frames recorded`
  const lines = shown.map((f) => {
    const target = f.name.length > 0 ? `${f.channel}.${f.name}` : f.channel
    return `  ${new Date(f.ts).toISOString()} ${f.direction} ${Math.round(f.bytes / KIB)}KiB ${f.type} ${target}`
  })
  return `${headline}\n${lines.join('\n')}`
}

/** Test seam: drop the ring, the counters, the fold window and the installed sinks. */
export function resetIpcFrameDiagnosticsForTests(nowOverride?: () => number): void {
  diagnostics = undefined
  clock = nowOverride ?? Date.now
  alertKey = ''
  alertSince = 0
  alertSuppressed = 0
  ringCursor = 0
  ringFilled = 0
  framesSeen = 0
  warnedFrames = 0
  oversizedFrames = 0
  largestBytes = 0
  largestLabel = ''
  for (const slot of ring) {
    slot.ts = 0
    slot.bytes = 0
    slot.type = ''
    slot.channel = ''
    slot.name = ''
  }
}
