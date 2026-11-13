/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process exit watchdog (Windows only). A native crash, OOM abort or external
 *  TerminateProcess kills the process before any JS handler can run, so the next
 *  launch otherwise sees only "no clean shutdown" — identical for a taskkill, an
 *  access violation and a power loss. A tiny detached `ELECTRON_RUN_AS_NODE` child
 *  opens the main pid while it still exists, waits on it through the process-job
 *  addon (libuv thread pool, no polling), and writes `main-exit.json` into the
 *  session log directory after the exit code is known.
 *
 *  Why detached: the editor's own direct children are placed in libuv's global
 *  kill-on-close job, which would take the watchdog down with the process it is
 *  watching. `detached: true` opts out (verified by killing a parent with
 *  `taskkill /F` and observing the detached child survive). The watchdog is also
 *  not registered with the process-lifecycle registry, so owner reclaim never
 *  targets it.
 *
 *  Failure policy: the watchdog is diagnostics, never a dependency. Missing addon,
 *  spawn failure or a target that already vanished all end silently; the forensics
 *  reader treats a missing file as "no record" and says so.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_EXIT_FILE } from './mainExitForensics.js'

/** Minimal logger seam — avoids importing the platform logger into this pure helper. */
export interface MainExitWatchdogLogger {
  info(message: string): void
  warn(message: string): void
}

export interface MainExitWatchdogOptions {
  /** Current session's log directory (`<logsRoot>/<sessionId>`). */
  readonly sessionDir: string
  /** `process.execPath` — Electron's own binary, run with ELECTRON_RUN_AS_NODE. */
  readonly execPath: string
  /** `process_job.node`, resolved by the caller (dev tree vs packaged resources). */
  readonly addonPath: string
  readonly logger?: MainExitWatchdogLogger
  /** Test seam; defaults to the current process. */
  readonly targetPid?: number
}

/**
 * Self-contained CommonJS passed to `electron.exe -e` (ELECTRON_RUN_AS_NODE). It
 * must not import application code: the child has no bundler and may run while the
 * app is being upgraded on disk. Parameters travel through env to avoid quoting.
 */
const WATCHDOG_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const pid = Number(process.env.UE_WATCHDOG_PID)
const out = process.env.UE_WATCHDOG_OUT
const addonPath = process.env.UE_WATCHDOG_ADDON
if (!Number.isInteger(pid) || pid <= 0 || !out || !addonPath) process.exit(0)
let waitForProcessExit
try {
  waitForProcessExit = require(addonPath).waitForProcessExit
} catch {
  process.exit(0)
}
if (typeof waitForProcessExit !== 'function') process.exit(0)
waitForProcessExit(pid).then(
  (code) => {
    const exitCode = code >>> 0
    const record = {
      pid: pid,
      exitCode: exitCode,
      exitCodeHex: '0x' + exitCode.toString(16).toUpperCase().padStart(8, '0'),
      exitedAt: Date.now(),
    }
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      // Rename is atomic: the next launch can never read a half-written record.
      const temp = out + '.' + process.pid + '.tmp'
      fs.writeFileSync(temp, JSON.stringify(record))
      fs.renameSync(temp, out)
    } catch {}
    process.exit(0)
  },
  () => process.exit(0),
)
`

/**
 * Spawn the watchdog. Returns whether a process was started; callers treat the
 * whole feature as best-effort and must not branch startup on it.
 */
export function startMainExitWatchdog(options: MainExitWatchdogOptions): boolean {
  if (process.platform !== 'win32') return false
  if (!existsSync(options.addonPath)) {
    options.logger?.warn('exit watchdog disabled: native addon missing')
    return false
  }
  const env: NodeJS.ProcessEnv = { ...process.env }
  // A user/tooling NODE_OPTIONS can inject --require hooks the watchdog does not
  // expect; it needs no options of its own, so drop the inherited value.
  delete env['NODE_OPTIONS']
  env['ELECTRON_RUN_AS_NODE'] = '1'
  env['UE_WATCHDOG_PID'] = String(options.targetPid ?? process.pid)
  env['UE_WATCHDOG_OUT'] = join(options.sessionDir, MAIN_EXIT_FILE)
  env['UE_WATCHDOG_ADDON'] = options.addonPath
  try {
    const child = spawn(options.execPath, ['-e', WATCHDOG_SCRIPT], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env,
    })
    // An async spawn error (e.g. execPath vanished) must not become an
    // uncaughtException in the process the watchdog is meant to observe. Log only
    // the error code: the message usually embeds the (user-visible) exec path.
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
      options.logger?.warn(`exit watchdog failed to start (${code})`)
    })
    child.unref()
    options.logger?.info(
      `exit watchdog started pid=${child.pid ?? '?'} target=${env['UE_WATCHDOG_PID']}`,
    )
    return true
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code ?? 'unknown')
        : 'unknown'
    options.logger?.warn(`exit watchdog failed to start (${code})`)
    return false
  }
}
