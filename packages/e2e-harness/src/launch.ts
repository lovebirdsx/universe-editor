/*---------------------------------------------------------------------------------------------
 *  Shared launch helpers for the packaged Electron build under Playwright.
 *
 *  This module is app-agnostic: callers pass the resolved `appRoot` / `mainEntry`
 *  (a thin shim in `apps/editor/e2e` binds them to the local build). It owns the
 *  cross-cutting launch concerns every fixture shares:
 *    - stripping ELECTRON_RUN_AS_NODE (Claude Code's shell injects it, degrading
 *      Electron to plain Node which rejects Chromium flags)
 *    - seeding a deterministic userData (pinned language, manual update, onboarding
 *      seen)
 *    - the minimal-extension-set seam: `extensions` (an allowlist) is forwarded to
 *      the app as `UNIVERSE_ENABLED_EXTENSIONS`; `undefined` means "activate all"
 *      (current behaviour), `[]` means "core only".
 *    - graceful-close-with-force-kill teardown (Windows orphan handling).
 *--------------------------------------------------------------------------------------------*/

import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Env var the app's extension-host bootstrap reads as an allowlist (P2). When
// unset the host activates every scanned extension; when set (even to empty) it
// activates only the listed ids plus core built-ins.
export const ENABLED_EXTENSIONS_ENV = 'UNIVERSE_ENABLED_EXTENSIONS'

// `app.close()` waits for Playwright's pipe connection to the Electron process
// to close. On Windows the main process can exit cleanly (exitCode 0) yet the
// child processes it spawned — node-pty, ACP agents, extension host — survive as
// orphans (Windows does not kill children with the parent) and keep inherited
// pipe fds open, so `app.close()` never resolves and the whole child tree stays
// alive, blowing past Playwright's 30s worker-teardown budget. When the graceful
// close doesn't finish promptly we force-kill the entire process tree; killing
// the orphans EOFs the pipe and lets the pending close() resolve.
const CLOSE_TIMEOUT_MS = 10_000

// Kill the Electron process AND every descendant. `taskkill /pid <root> /T`
// only works while the root is still alive; by teardown the main process has
// often already exited (exitCode 0) leaving orphaned children whose parent PID
// no longer resolves. So on Windows we enumerate the descendant tree ourselves
// (via WMIC/CIM) starting from the root PID and kill each survivor by PID.
// Non-Windows: a parent SIGKILL suffices (the orphan bug is Windows-only).
function forceKillTree(pid: number): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
    return
  }
  // Collect descendant PIDs first (root may already be dead, so /T is unreliable).
  const pids = new Set<number>([pid])
  try {
    const script =
      `$ErrorActionPreference='SilentlyContinue';` +
      `function t($p){Get-CimInstance Win32_Process -Filter "ParentProcessId=$p"|` +
      `ForEach-Object{$_.ProcessId; t $_.ProcessId}}; t ${pid}`
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of out.split(/\r?\n/)) {
      const n = Number(line.trim())
      if (Number.isInteger(n) && n > 0) pids.add(n)
    }
  } catch {
    // Enumeration failed — fall back to a best-effort /T on the root below.
  }
  for (const p of pids) {
    try {
      execFileSync('taskkill', ['/pid', String(p), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // Already exited, or unkillable — nothing actionable for teardown.
    }
  }
}

// Sweep ORPHANED language-server processes the tree walk above cannot reach. The
// typescript built-in plugin spawns a `typescript-language-server` CLI, which
// forks tsserver. On graceful shutdown that CLI reaps its own tsserver — but a
// semantic server that was still spawning at kill time gets DETACHED from the
// tree (its parent CLI dies first), so `forceKillTree` (descendants of the app
// root only) never sees it. Left alive it holds an inherited pipe open and wedges
// `app.close()` past the worker-teardown budget. Here we find every electron.exe
// running our vendored tsserver/CLI whose PARENT no longer exists (a true orphan)
// and kill it. Cross-worker-safe: a still-running worker's servers have a live
// parent, so they never match the dead-parent filter.
function killOrphanedLanguageServers(): void {
  if (process.platform !== 'win32') return
  try {
    const script =
      `$ErrorActionPreference='SilentlyContinue';` +
      `$targets=Get-CimInstance Win32_Process -Filter "Name='electron.exe'"|` +
      `Where-Object{$_.CommandLine -match 'tsserver\\.js|typescript-language-server'};` +
      `foreach($t in $targets){` +
      `if(-not(Get-CimInstance Win32_Process -Filter "ProcessId=$($t.ParentProcessId)")){` +
      `Stop-Process -Id $t.ProcessId -Force}}`
    execFileSync('powershell', ['-NoProfile', '-Command', script], {
      timeout: 5_000,
      stdio: 'ignore',
    })
  } catch {
    // Best-effort teardown hygiene — never fail a passing test over cleanup.
  }
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  let proc: ReturnType<ElectronApplication['process']>
  try {
    // workbench.action.quit already tore the process down; the Playwright
    // handle is disposed and process() throws. Nothing left to close.
    proc = app.process()
  } catch {
    return
  }
  const pid = proc.pid

  let timer: ReturnType<typeof setTimeout> | undefined
  // Hold the same close promise so we can await it again after force-killing
  // orphans (calling app.close() twice would race a second teardown).
  const closePromise = app
    .close()
    .then(() => false)
    .catch(() => false)
  const timedOut = await Promise.race([
    closePromise,
    new Promise<boolean>((res) => {
      timer = setTimeout(() => res(true), CLOSE_TIMEOUT_MS)
    }),
  ])
  if (timer) clearTimeout(timer)

  // Force-kill on timeout regardless of exitCode: the main process may have
  // already exited cleanly (exitCode 0) while orphaned children keep the pipe
  // open — that is exactly the case app.close() cannot resolve on its own.
  if (timedOut && pid !== undefined) {
    forceKillTree(pid)
    // The tree walk misses tsserver detached from the app root (its parent CLI
    // was reaped first on graceful shutdown). Sweep those dead-parent orphans too,
    // else they hold the pipe open and app.close() never resolves.
    killOrphanedLanguageServers()

    // Killing the orphans EOFs the pipe → the pending close() resolves. Wait
    // briefly so Playwright's connection is fully torn down before the worker
    // exits (otherwise its own teardown can still block).
    await Promise.race([closePromise, new Promise((res) => setTimeout(res, 3_000))])
  }
}

/** userData files every fixture seeds a fresh instance with. */
export const INITIAL_SETTINGS = JSON.stringify(
  { 'workbench.language': 'en-US', 'update.mode': 'manual' },
  null,
  2,
)
export const INITIAL_STATE = JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2)

/**
 * Write the deterministic userData baseline (language pin, manual update,
 * onboarding seen) into `userDataDir`. Shared by cold-launch seeding and the
 * shared-instance reset.
 */
export function seedBaselineUserData(userDataDir: string): void {
  writeFileSync(join(userDataDir, 'settings.json'), INITIAL_SETTINGS, 'utf8')
  writeFileSync(join(userDataDir, 'state.json'), INITIAL_STATE, 'utf8')
}

export interface LaunchAppOptions {
  readonly appRoot: string
  readonly mainEntry: string
  readonly userDataDir: string
  /**
   * Extension allowlist (P2 minimal-extension-set). `undefined` → activate all
   * scanned extensions (current behaviour). An array (incl. empty) → forwarded to
   * the app as UNIVERSE_ENABLED_EXTENSIONS so the host activates only these +
   * core built-ins.
   */
  readonly extensions?: readonly string[]
  /** Extra env merged on top (e.g. perforce fake wiring). */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Launch the packaged Electron build with the E2E probe enabled. Centralizes the
 * ELECTRON_RUN_AS_NODE strip + the enabled-extensions seam so every fixture and
 * self-launching spec agrees on how the app is started.
 */
export async function launchApp(options: LaunchAppOptions): Promise<ElectronApplication> {
  // ELECTRON_RUN_AS_NODE=1 (set by Claude Code's shell) makes Electron behave as
  // plain Node.js, which rejects Chromium-only flags like --remote-debugging-port.
  // Explicitly unset it so the Electron binary runs as a full Chromium app.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const extraEnv: Record<string, string> = { ...(options.env ?? {}) }
  if (options.extensions !== undefined) {
    extraEnv[ENABLED_EXTENSIONS_ENV] = options.extensions.join(',')
  }
  return electron.launch({
    args: [options.mainEntry, `--user-data-dir=${options.userDataDir}`],
    cwd: options.appRoot,
    env: {
      ...inheritedEnv,
      UNIVERSE_E2E: '1',
      NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      ...extraEnv,
    },
  })
}
