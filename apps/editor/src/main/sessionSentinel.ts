/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Abnormal-exit sentinel. A native crash or external kill (AV / OOM / task kill)
 *  ends the main process without any JS-level handler firing, so the log just
 *  stops mid-stream with no evidence. The sentinel file closes that gap: written
 *  synchronously once the session owns the single-instance lock, removed in
 *  will-quit. A leftover sentinel at the next launch proves the previous session
 *  never shut down cleanly, and its startedAt timestamp lets us associate any
 *  crash dumps written since.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SENTINEL_FILE = 'session-sentinel.json'

// Two consecutive abnormal exits suggest the crash follows the restored state
// (e.g. a workspace whose walk OOMs the main process) rather than being a
// one-off external kill — from then on the user is offered a restore-free start.
const RESTORE_SKIP_OFFER_THRESHOLD = 2

interface SessionSentinel {
  readonly sessionId: string
  readonly startedAt: number
  /** Abnormal exits already accumulated before this session started. */
  readonly priorAbnormalExits?: number
}

export interface AbnormalExitReport {
  readonly previousSessionId: string
  readonly previousStartedAt: number
  /** Length of the current crash streak, including the exit just detected. */
  readonly consecutiveAbnormalExits: number
  /** Absolute paths of crash dumps written since the previous session started. */
  readonly crashDumps: readonly string[]
}

/** Whether the crash streak is long enough to offer skipping workspace restore. */
export function shouldOfferRestoreSkip(consecutiveAbnormalExits: number): boolean {
  return consecutiveAbnormalExits >= RESTORE_SKIP_OFFER_THRESHOLD
}

// Only the process that wrote the sentinel may delete it: a second instance
// losing the single-instance lock still runs will-quit, and must not destroy
// the primary instance's sentinel.
let _armed = false

/** Detect a leftover sentinel from a previous session that never reached will-quit. */
export function readAbnormalExitReport(
  userDataDir: string,
  crashDumpsDir: string,
): AbnormalExitReport | undefined {
  let sentinel: SessionSentinel
  try {
    sentinel = JSON.parse(readFileSync(join(userDataDir, SENTINEL_FILE), 'utf8')) as SessionSentinel
  } catch {
    return undefined
  }
  if (typeof sentinel?.sessionId !== 'string' || typeof sentinel?.startedAt !== 'number') {
    return undefined
  }
  const prior = typeof sentinel.priorAbnormalExits === 'number' ? sentinel.priorAbnormalExits : 0
  return {
    previousSessionId: sentinel.sessionId,
    previousStartedAt: sentinel.startedAt,
    consecutiveAbnormalExits: prior + 1,
    crashDumps: findCrashDumpsSince(crashDumpsDir, sentinel.startedAt),
  }
}

/** Mark this session as live. Call only after the single-instance lock is held. */
export function armSessionSentinel(
  userDataDir: string,
  sessionId: string,
  priorAbnormalExits = 0,
): void {
  try {
    writeFileSync(
      join(userDataDir, SENTINEL_FILE),
      JSON.stringify({
        sessionId,
        startedAt: Date.now(),
        priorAbnormalExits,
      } satisfies SessionSentinel),
    )
    _armed = true
  } catch {
    // Best-effort diagnostics; must never break startup.
  }
}

/** Clean shutdown: remove the sentinel. No-op unless this process armed it. */
export function disarmSessionSentinel(userDataDir: string): void {
  if (!_armed) return
  _armed = false
  try {
    rmSync(join(userDataDir, SENTINEL_FILE), { force: true })
  } catch {
    // Best-effort.
  }
}

/** Crashpad nests dumps (e.g. reports/<uuid>.dmp), so scan a few levels deep. */
export function findCrashDumpsSince(dir: string, sinceMs: number, depth = 3): string[] {
  const found: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0) found.push(...findCrashDumpsSince(full, sinceMs, depth - 1))
    } else if (entry.name.toLowerCase().endsWith('.dmp')) {
      try {
        if (statSync(full).mtimeMs >= sinceMs) found.push(full)
      } catch {
        // Racing deletion; skip.
      }
    }
  }
  return found
}

export function _resetSentinelForTests(): void {
  _armed = false
}
