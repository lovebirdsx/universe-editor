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

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Env var the app's extension-host bootstrap reads as an allowlist (P2). When
// unset the host activates every scanned extension; when set (even to empty) it
// gates built-ins WITH an entry module down to the listed ids — declaration-only
// built-ins (pure contributes, e.g. theme-defaults) and user-installed
// extensions always activate, since they cost no host process.
export const ENABLED_EXTENSIONS_ENV = 'UNIVERSE_ENABLED_EXTENSIONS'

export interface EditorBuild {
  /** cwd for electron.launch (the editor package root, apps/editor). */
  readonly appRoot: string
  /** Path to the packaged main entry (apps/editor/out/main/index.js). */
  readonly mainEntry: string
}

/**
 * Locate the editor's packaged build by walking up from this module until a
 * directory containing `apps/editor/out/main/index.js` is found. Lets per-
 * extension e2e fixtures (which sit at different depths under the workspace)
 * resolve the app without hardcoding `../../..` relative paths. Throws with a
 * clear hint when the build is missing (run `pnpm build` first).
 */
export function resolveEditorBuild(): EditorBuild {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    const appRoot = join(dir, 'apps', 'editor')
    const mainEntry = join(appRoot, 'out', 'main', 'index.js')
    if (existsSync(mainEntry)) return { appRoot, mainEntry }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    'resolveEditorBuild: could not find apps/editor/out/main/index.js — run `pnpm build` first',
  )
}

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
// no longer resolves. So on Windows we pull the whole process table in ONE
// CIM query and walk the parent→child graph in JS. (An earlier variant
// recursed with one Get-CimInstance call per descendant; under full-suite load
// the compounded WMI latency blew the timeout, the catch fell back to a /T on
// the already-dead root, and nothing got killed — the CDP pipe stayed open.)
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
  const pids = new Set<number>([pid])
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$ErrorActionPreference='SilentlyContinue';` +
          `Get-CimInstance Win32_Process|ForEach-Object{'{0} {1}' -f $_.ProcessId,$_.ParentProcessId}`,
      ],
      { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const children = new Map<number, number[]>()
    for (const line of out.split(/\r?\n/)) {
      const [child, parent] = line.trim().split(/\s+/).map(Number)
      if (!Number.isInteger(child) || !Number.isInteger(parent)) continue
      const siblings = children.get(parent!) ?? []
      siblings.push(child!)
      children.set(parent!, siblings)
    }
    const queue = [pid]
    while (queue.length > 0) {
      const current = queue.pop()!
      for (const child of children.get(current) ?? []) {
        if (!pids.has(child)) {
          pids.add(child)
          queue.push(child)
        }
      }
    }
  } catch {
    // Enumeration failed — fall back to a best-effort /T on the root below.
  }
  // One batched call: taskkill keeps processing later /pid args when an
  // earlier one is already gone, and a single spawn is much cheaper than one
  // per pid — worker teardown closes apps sequentially against a shared
  // budget, so every second here counts.
  if (pids.size > 0) {
    const pidArgs: string[] = []
    for (const p of pids) pidArgs.push('/pid', String(p))
    try {
      execFileSync('taskkill', [...pidArgs, '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // Already exited, or unkillable — nothing actionable for teardown.
    }
  }
}

// Sweep ORPHANED descendants the tree walk above cannot reach: the walk
// follows live ParentProcessId links, so a child whose intermediate parent
// died first (renderer → ConPTY host, CLI → forked tsserver, codex CLI →
// `where git` probe, …) is invisible from the root. Left alive such a process
// holds an inherited pipe open and wedges `app.close()` past the worker-
// teardown budget. Match by (name, commandline) fingerprints of processes OUR
// app tree is known to spawn, and only kill when the PARENT no longer exists
// (a true orphan). Cross-worker-safe: a still-running worker's processes have
// a live parent, so they never match the dead-parent filter.
//   - electron.exe helpers / vendored tsserver+LSP CLIs
//   - node/electron running the vendored ACP agents (codex-acp,
//     claude-agent-acp) — the agent re-spawns itself, so the respawned
//     grandchild survives the app's own taskkill /T
//   - probe processes those agents shell out to and leak when wedged:
//     `where <tool>` lookups, `wmic baseboard` fingerprinting, and conhost
//     corpses (a dead-parent conhost's console app is gone — headless ConPTY
//     hosts and plain `0x4` hosts alike are pure leftovers)
function killOrphanedElectronProcesses(): void {
  if (process.platform !== 'win32') return
  try {
    const script =
      `$ErrorActionPreference='SilentlyContinue';` +
      `$procs=Get-CimInstance Win32_Process;` +
      `$alive=@{};foreach($p in $procs){$alive[$p.ProcessId]=$true};` +
      `foreach($p in $procs){` +
      `if($alive[$p.ParentProcessId]){continue};` +
      `$n=$p.Name;$cl=[string]$p.CommandLine;` +
      `$hit=$false;` +
      `if($n -eq 'electron.exe' -and $cl -match '--type=|tsserver\\.js|typescript-language-server'){$hit=$true}` +
      `elseif(($n -eq 'node.exe' -or $n -eq 'electron.exe') -and $cl -match 'codex-acp|claude-agent-acp'){$hit=$true}` +
      `elseif($n -eq 'where.exe' -and $cl -match 'git|codex|claude'){$hit=$true}` +
      `elseif($n -eq 'conhost.exe'){$hit=$true}` +
      `elseif(($n -eq 'WMIC.exe' -or $n -eq 'cmd.exe') -and $cl -match 'wmic'){$hit=$true};` +
      `if($hit){Stop-Process -Id $p.ProcessId -Force}}`
    execFileSync('powershell', ['-NoProfile', '-Command', script], {
      timeout: 10_000,
      stdio: 'ignore',
    })
  } catch {
    // Best-effort teardown hygiene — never fail a passing test over cleanup.
  }
}

// Diagnostic for the "CDP pipe still open after force-kill" path: print every
// process that could plausibly hold an inherited pipe handle — dead-parent
// orphans plus anything from our spawn ecosystem — with pid/ppid/name/cmdline.
// Post-mortem scans miss the culprit (wedged probes eventually exit on their
// own), so this must run at the moment the pipe is stuck.
function dumpSuspectProcesses(): void {
  if (process.platform !== 'win32') return
  try {
    // Only lines with diagnostic value: anything from OUR ecosystem (command
    // line mentions the repo / userData temp dirs, both contain
    // "universe-editor"), plus dead-parent orphans whose name matches our
    // known leak fingerprints. Unrelated desktop software and Docker's WSL
    // fleet dominated earlier full dumps without ever being the culprit.
    const script =
      `$ErrorActionPreference='SilentlyContinue';` +
      `$procs=Get-CimInstance Win32_Process;` +
      `$alive=@{};foreach($p in $procs){$alive[$p.ProcessId]=$true};` +
      `foreach($p in $procs){` +
      `$n=$p.Name;$dead=-not $alive[$p.ParentProcessId];` +
      `$cl=[string]$p.CommandLine;` +
      `$ours=$cl -match 'universe-editor';` +
      `$fp=$dead -and $n -match 'electron|node|git|where|wsl|conhost|WMIC';` +
      `if($ours -or $fp){` +
      `if($cl.Length -gt 180){$cl=$cl.Substring(0,180)};` +
      `Write-Output ('{0} ppid={1}{2} {3} {4}' -f $p.ProcessId,$p.ParentProcessId,$(if($dead){'(dead)'}else{''}),$n,$cl)}}`
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    console.warn(`[e2e] closeApp: suspect processes at stuck-pipe time:\n${out.trimEnd()}`)
  } catch {
    // Diagnostics only.
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
    // Loud on purpose: worker stderr surfaces in the Playwright report, so a
    // teardown that went down the force-kill path is attributable to its app.
    console.warn(
      `[e2e] closeApp: graceful close still pending after ${CLOSE_TIMEOUT_MS}ms (pid=${pid}) — force-killing the process tree`,
    )
    forceKillTree(pid)
    // The tree walk misses processes detached from the app root (an
    // intermediate parent died first). Sweep those dead-parent orphans too,
    // else they hold the pipe open and app.close() never resolves.
    killOrphanedElectronProcesses()

    // Killing the orphans EOFs the pipe → the pending close() resolves. Wait
    // briefly so Playwright's connection is fully torn down before the worker
    // exits (otherwise its own teardown can still block).
    const stillOpen = await Promise.race([
      closePromise,
      new Promise<boolean>((res) => setTimeout(() => res(true), 3_000)),
    ])
    if (stillOpen) {
      // Something unreachable (a stray process that inherited the pipe's child
      // end during a concurrent spawn) is keeping EOF from ever arriving. We
      // don't need it: Node fires the child's 'close' event once every
      // PARENT-side stdio stream is closed, and those are ours to destroy.
      // The tree is already force-killed, so tearing the streams down is safe
      // and lets the pending close() (and the worker teardown waiting on it)
      // resolve instead of blowing the 30s worker-teardown budget.
      console.warn(
        `[e2e] closeApp: CDP pipe still open after force-kill (pid=${pid}) — destroying parent-side stdio to unblock close()`,
      )
      dumpSuspectProcesses()
      for (const stream of proc.stdio) stream?.destroy()
      const unblocked = await Promise.race([
        closePromise,
        new Promise<boolean>((res) => setTimeout(() => res(true), 3_000)),
      ])
      if (unblocked) {
        // Playwright's transport still notices the dead pipe and tears down
        // without blowing the worker budget — this line is just breadcrumbs.
        console.warn(`[e2e] closeApp: close() still pending after stdio destroy (pid=${pid})`)
      }
    }
  }
}

/** userData files every fixture seeds a fresh instance with. */
export const INITIAL_SETTINGS = JSON.stringify(
  {
    'workbench.language': 'en-US',
    'update.mode': 'manual',
    // wsl.exe probes hang when wslservice is contended by parallel workers,
    // and a stuck wsl.exe survives Node's SIGTERM — orphaning a process that
    // wedges app.close(). WSL profile detection is covered by unit tests;
    // e2e doesn't need the machine-dependent probe.
    'terminal.integrated.useWslProfiles': false,
  },
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
  // Isolate the read-only VSCode-compat layers from the host machine's real
  // %APPDATA%/Code/User/*.json — otherwise a developer's own VSCode settings
  // (e.g. workbench.iconTheme) leak into the run and flip assertions.
  writeFileSync(join(userDataDir, 'vscode-user-settings.json'), '{}\n', 'utf8')
  writeFileSync(join(userDataDir, 'vscode-user-keybindings.json'), '[]\n', 'utf8')
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
  /** Extra positional args appended after --user-data-dir (e.g. a workspace folder to open). */
  readonly extraArgs?: readonly string[]
}

// CI runners intermittently fail the spawn itself, before any app code runs:
//  - Windows: Defender scans electron.exe / icudtl.dat and holds a lock — the
//    process dies before Playwright's pipe connects ("Process failed to
//    launch!" with an ICU-load or "file is being used by another process"
//    stderr). The scan window was observed to outlast 3×5s retries AND a full
//    Playwright test retry, so the backoff escalates to ride out ~40s.
//  - Linux: `spawn ETXTBSY` — a concurrently forking worker briefly holds a
//    write fd on the electron binary; the window is milliseconds, any retry
//    clears it.
//  - Windows variant: "Electron failed to install correctly" — Playwright's
//    pre-launch executable check can't run electron.exe while Defender holds
//    the lock; same file-lock window, same retry cure.
// Retrying with the SAME userDataDir is safe in both cases (seeded state is
// untouched). The escalating delays stay within the 60s fixture timeout; a
// self-launching spec's 30s test timeout may cut the tail attempts short,
// which is no worse than failing immediately.
const TRANSIENT_LAUNCH_ERROR =
  /Process failed to launch|spawn ETXTBSY|Electron failed to install correctly/i
const LAUNCH_RETRY_DELAYS_MS = [5_000, 10_000, 20_000]

/**
 * `electron.launch` with transient-failure retry. Use this instead of the bare
 * `_electron.launch` in self-launching specs so a runner-level file-lock window
 * doesn't fail the test before the app under test even starts.
 */
export async function launchElectron(
  options: Parameters<typeof electron.launch>[0],
): Promise<ElectronApplication> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await electron.launch(options)
    } catch (err) {
      const delay = LAUNCH_RETRY_DELAYS_MS[attempt - 1]
      if (delay === undefined || !TRANSIENT_LAUNCH_ERROR.test(String(err))) throw err
      console.warn(
        `[e2e] electron.launch failed (attempt ${attempt}/${LAUNCH_RETRY_DELAYS_MS.length + 1}), retrying in ${delay}ms: ${String(err).split('\n', 1)[0]}`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
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
  const {
    ELECTRON_RUN_AS_NODE: _ignored,
    // A developer's own ext-dev env must not leak into the e2e instance (an
    // inherited UNIVERSE_INSPECT_EXTENSIONS would make every spawned host try to
    // bind the same debug port).
    UNIVERSE_EXTENSION_DEV_PATH: _ignoredDevPath,
    UNIVERSE_INSPECT_EXTENSIONS: _ignoredInspect,
    UNIVERSE_INSPECT_BRK_EXTENSIONS: _ignoredInspectBrk,
    ...inheritedEnv
  } = process.env
  const extraEnv: Record<string, string> = { ...(options.env ?? {}) }
  if (options.extensions !== undefined) {
    extraEnv[ENABLED_EXTENSIONS_ENV] = options.extensions.join(',')
  }
  // Route the read-only VSCode-compat layers at the isolated tmp files seeded by
  // seedBaselineUserData (see there). Specs overriding these envs via options.env
  // still win — extraEnv is spread after these defaults.
  extraEnv['UNIVERSE_VSCODE_SETTINGS_PATH'] ??= join(
    options.userDataDir,
    'vscode-user-settings.json',
  )
  extraEnv['UNIVERSE_VSCODE_KEYBINDINGS_PATH'] ??= join(
    options.userDataDir,
    'vscode-user-keybindings.json',
  )
  return launchElectron({
    args: [
      options.mainEntry,
      `--user-data-dir=${options.userDataDir}`,
      ...(options.extraArgs ?? []),
    ],
    cwd: options.appRoot,
    env: {
      ...inheritedEnv,
      UNIVERSE_E2E: '1',
      NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      ...extraEnv,
    },
  })
}

export async function waitForProbe(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
}

// The guards in launchElectron only cover `electron.launch` THROWING. A
// distinct runner-level failure mode is launch succeeding but the first window
// never appearing: on CI Windows the phase between process spawn and
// `new BrowserWindow` can be dragged past 30s by the same Defender/file-lock
// windows (cases 72/72b/72c cover the launch-throw variant). When that phase
// stalls, failure forensics can't be installed (they need a live Page), so the
// ONLY evidence of where the main process stopped is the app's own logs under
// <userData>/logs/<sessionId>/ (main.log, window-N/*.log, …). Print the tail
// of each so the CI console output carries the post-mortem.
function dumpUserDataLogsTail(userDataDir: string): void {
  try {
    const logsRoot = join(userDataDir, 'logs')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.log')) files.push(full)
      }
    }
    walk(logsRoot)
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      console.warn(`[e2e] log tail ${relative(logsRoot, file)}:\n${lines.slice(-30).join('\n')}`)
    }
  } catch {
    // Best-effort diagnostics — never mask the original readiness failure.
  }
}

const FIRST_WINDOW_TIMEOUT_MS = 30_000
const READY_ATTEMPTS = 2

/**
 * `launchApp` + the full readiness chain (first window → domcontentloaded →
 * e2e probe), retried once as a unit. Use this in fixtures instead of the bare
 * `launchApp` + `app.firstWindow()` pair: a launch that succeeds but never
 * shows a window would otherwise burn the whole fixture/test timeout with zero
 * diagnostics, and — for a fixture that throws before `use()` — skip teardown
 * entirely, orphaning the half-dead Electron (secondary symptom: "Worker
 * teardown timeout"). On failure this dumps the userData log tails, reaps the
 * process via closeApp, and retries once before rethrowing.
 */
export async function launchAppReady(
  options: LaunchAppOptions,
): Promise<{ app: ElectronApplication; page: Page }> {
  for (let attempt = 1; ; attempt++) {
    const app = await launchApp(options)
    try {
      const page = await app.firstWindow({ timeout: FIRST_WINDOW_TIMEOUT_MS })
      await page.waitForLoadState('domcontentloaded')
      await waitForProbe(page)
      return { app, page }
    } catch (err) {
      console.warn(
        `[e2e] app launched but window/probe not ready (attempt ${attempt}/${READY_ATTEMPTS}): ${String(err).split('\n', 1)[0]}`,
      )
      dumpUserDataLogsTail(options.userDataDir)
      // Swallow close errors — the readiness failure is the one to report.
      try {
        await closeApp(app)
      } catch {
        // best-effort
      }
      if (attempt >= READY_ATTEMPTS) throw err
    }
  }
}
