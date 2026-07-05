/*---------------------------------------------------------------------------------------------
 *  Playwright fixture: launches the packaged Electron build with the E2E probe
 *  enabled (UNIVERSE_E2E=1), points userData at a fresh tmp dir so concurrent
 *  `pnpm dev` instances don't collide, and exposes a `page` already waiting on
 *  `window.__E2E__` so specs don't need to repeat the boilerplate.
 *--------------------------------------------------------------------------------------------*/

import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { WorkbenchPO, expectNoLeaks } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = resolve(__dirname, '..', '..')
export const MAIN_ENTRY = resolve(APP_ROOT, 'out', 'main', 'index.js')

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

export type E2EFixtures = {
  electronApp: ElectronApplication
  page: Page
  workbench: WorkbenchPO
}

export const test = base.extend<E2EFixtures>({
  electronApp: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-'))
    // Pin UI language for deterministic assertions across CI/dev machines.
    // Disable auto-update checks by default so the update state machine stays
    // idle unless a spec opts in (smoke.update drives it explicitly).
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ 'workbench.language': 'en-US', 'update.mode': 'manual' }, null, 2),
      'utf8',
    )
    // Mark the first-run Agent onboarding as already seen so the default layout
    // stays deterministic (the secondary sidebar stays hidden unless a spec
    // toggles it). smoke.agentOnboarding launches its own un-seeded instance to
    // cover the first-run reveal.
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2),
      'utf8',
    )
    // ELECTRON_RUN_AS_NODE=1 (set by Claude Code's shell) makes Electron behave as
    // plain Node.js, which rejects Chromium-only flags like --remote-debugging-port.
    // Explicitly unset it so the Electron binary runs as a full Chromium app.
    const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      cwd: APP_ROOT,
      env: {
        ...inheritedEnv,
        UNIVERSE_E2E: '1',
        NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      },
    })
    await use(app)
    await closeApp(app)
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // 等待 renderer 装上探针(LifecyclePhase.Ready 之后).
    await page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )
    await use(page)
    // Teardown gate: fail the test if the session leaked any Disposables. The
    // probe unmounts React first so React subscriptions don't count as leaks.
    // Tolerates a window already torn down by workbench.action.quit.
    await expectNoLeaks(page)
  },
  workbench: async ({ page }, use) => {
    await use(new WorkbenchPO(page))
  },
})

export { expect } from '@playwright/test'
