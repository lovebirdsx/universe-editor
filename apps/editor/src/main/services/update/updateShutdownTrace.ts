/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process shutdown trace for the "restart to install update" flow. The stall
 *  between clicking install and the freshly-installed app painting spans THREE
 *  processes — the old one quitting, the NSIS installer overwriting files, and the
 *  new one starting — so an in-process `performance.mark` cannot bridge it (each
 *  process has its own timeOrigin, and the synchronous `will-quit` truncates the
 *  debounced file logger before it flushes).
 *
 *  Instead the old process appends wall-clock epoch-ms marks (the same base as
 *  `process.getCreationTime()`) to a file under userData, written SYNCHRONOUSLY so
 *  they survive the abrupt exit. The next launch reads them back, subtracts the last
 *  mark from its own OS creation time to expose the NSIS install gap, logs the whole
 *  timeline, then deletes the file. Measurement only — no behaviour change.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface ShutdownTraceEntry {
  readonly label: string
  /** Wall-clock epoch milliseconds (`Date.now()`), comparable to `process.getCreationTime()`. */
  readonly at: number
}

const TRACE_FILE = 'update-shutdown-trace.json'

// Only the install-quit path arms the trace; a normal quit's will-quit marks are
// then no-ops, so we never pollute the file outside an update restart.
let _armed = false

function tracePath(): string {
  return join(app.getPath('userData'), TRACE_FILE)
}

/** Start a fresh trace (overwrites any leftover) and stamp the click moment. */
export function beginShutdownTrace(): void {
  _armed = true
  try {
    writeFileSync(tracePath(), '')
  } catch {
    // userData unavailable (e.g. unit tests mock electron without getPath): the
    // trace is best-effort diagnostics and must never break the install flow.
  }
  recordShutdownMark('click')
}

/** Append a wall-clock mark. No-op unless {@link beginShutdownTrace} armed this process. */
export function recordShutdownMark(label: string): void {
  if (!_armed) return
  try {
    appendFileSync(tracePath(), `${JSON.stringify({ label, at: Date.now() })}\n`)
  } catch {
    // Best-effort; see beginShutdownTrace.
  }
}

/** Read back the trace written by the previous (updating) process, if any. */
export function readShutdownTrace(): ShutdownTraceEntry[] | undefined {
  let text: string
  try {
    text = readFileSync(tracePath(), 'utf8')
  } catch {
    return undefined
  }
  const entries: ShutdownTraceEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as ShutdownTraceEntry
      if (typeof parsed.label === 'string' && typeof parsed.at === 'number') entries.push(parsed)
    } catch {
      // Skip a torn final line (process died mid-append).
    }
  }
  return entries.length > 0 ? entries : undefined
}

export function clearShutdownTrace(): void {
  try {
    rmSync(tracePath(), { force: true })
  } catch {
    // Best-effort.
  }
}
