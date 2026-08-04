/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Stack parsing + fingerprinting for error aggregation. Mirrors the intent of
 *  VSCode's errorTelemetry dedup (same root cause must collapse into one entry)
 *  while producing a short, display-friendly fingerprint for reports.
 *--------------------------------------------------------------------------------------------*/

export interface IStackFrame {
  readonly func: string | undefined
  readonly location: string
  readonly line: number | undefined
}

const FRAME_RE =
  /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?((?:file:\/\/)?[A-Za-z]:[\\/][^()]+?|(?:file:\/\/)?\/[^()]+?|[\w:./-]+):(\d+):\d+\)?$/

export function parseStackFrames(stack: string): IStackFrame[] {
  const frames: IStackFrame[] = []
  for (const rawLine of stack.split('\n')) {
    const m = FRAME_RE.exec(rawLine)
    if (!m || m[2] === undefined) continue
    frames.push({ func: m[1], location: m[2], line: Number(m[3]) })
  }
  return frames
}

/** Normalize a path found in a stack: forward slashes, no file:// prefix, no query/hash. */
export function normalizeStackPath(path: string): string {
  let p = path.replace(/[?#].*$/, '').replace(/^file:\/\//, '')
  // file:///C:/... leaves a leading slash before the drive letter.
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
  return p.replace(/\\/g, '/')
}

/** Last two path segments — enough to attribute without leaking directory layout. */
export function shortStackPath(path: string): string {
  const normalized = normalizeStackPath(path)
  const segments = normalized.split('/').filter(Boolean)
  return segments.slice(-2).join('/')
}

/**
 * Dedup key for "same error": normalized frame sequence (func + short path +
 * line). Line numbers are kept — identical errors from the same build share
 * them, and dropping them would merge distinct call sites.
 */
export function computeStackKey(stack: string): string {
  return parseStackFrames(stack)
    .map((f) => `${f.func ?? '<anon>'}@${shortStackPath(f.location)}:${f.line ?? 0}`)
    .join('|')
}

const MESSAGE_NOISE_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s'"]+|\b\d+\b/g

/**
 * Dedup key for one error occurrence: the normalized frame sequence when a
 * stack exists, else the normalized-message fingerprint. Producers on both
 * sides of the IPC boundary use this as their AggregationBuffer key.
 */
export function computeErrorDedupKey(stack: string | undefined, message: string): string {
  if (stack) {
    const key = computeStackKey(stack)
    if (key) return key
  }
  return computeErrorFingerprint(undefined, message)
}

/**
 * Short, stable, display-friendly fingerprint: `func@shortPath` of the first
 * frame. Falls back to a normalized first message line (paths and numbers
 * stripped) for errors without a usable stack.
 */
export function computeErrorFingerprint(stack: string | undefined, message: string): string {
  if (stack) {
    const first = parseStackFrames(stack)[0]
    if (first) {
      return `${first.func ?? '<anon>'}@${shortStackPath(first.location)}`
    }
  }
  const firstLine = message.split('\n', 1)[0] ?? message
  const normalized = firstLine.replace(MESSAGE_NOISE_RE, '?').trim()
  return normalized.slice(0, 80) || 'unknown'
}
