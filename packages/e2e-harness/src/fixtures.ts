/*---------------------------------------------------------------------------------------------
 *  Playwright fixture factories, parameterized by the resolved app build.
 *
 *  Two launch models (mirrors the pre-extraction fixtures):
 *    - createColdAppTest:   cold-launch a fresh Electron per test. Use when a spec
 *                           touches main-process state (extra windows, terminal
 *                           PTYs, ACP sessions, restart/restore) — a reload won't
 *                           reset those.
 *    - createSharedAppTest: ONE Electron per worker, reset between tests by
 *                           rewriting userData + reloading the window. Amortizes
 *                           cold start (~2.5s). Use only when state lives entirely
 *                           in the renderer.
 *
 *  Both take {appRoot, mainEntry, extensions?}. `extensions` is the P2 seam: pass
 *  an allowlist to activate a minimal extension set, or omit it to activate all
 *  (current behaviour).
 *--------------------------------------------------------------------------------------------*/

import {
  test as base,
  type ElectronApplication,
  type Page,
  type TestType,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
} from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { WorkbenchPO, expectNoLeaks } from './pages/WorkbenchPO.js'
import { closeApp, launchAppReady, seedBaselineUserData, waitForProbe } from './launch.js'
import { installFailureForensics } from './forensics.js'

// Lives in launch.ts (launchAppReady needs it); re-exported so existing deep
// imports from this module keep working.
export { waitForProbe } from './launch.js'

export interface AppFixtureConfig {
  readonly appRoot: string
  readonly mainEntry: string
  /** Extension allowlist (P2). Omit to activate all scanned extensions. */
  readonly extensions?: readonly string[]
  /**
   * Extra env merged onto the launch (e.g. UNIVERSE_USER_EXTENSIONS_DIR to load
   * an out-of-workspace marketplace extension straight off disk, VSCode's
   * `--extensionDevelopmentPath` model). Applied to every launch this fixture makes.
   */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Extra CLI args appended to every launch (e.g.
   * `['--extension-development-path', dir]` to exercise the real CLI path rather
   * than an env injection). Placed before any workspace positional arg.
   */
  readonly extraArgs?: readonly string[]
}

export interface E2EFixtures {
  electronApp: ElectronApplication
  page: Page
  workbench: WorkbenchPO
  /**
   * Option: seed content into a per-test workspace folder that the app is
   * launched WITH (positional argv → openWindowForFolder). Pinning the folder
   * at launch keeps the extension host single-generation: it skips both the
   * workspace re-pin restart and the trust-flip revoke restart that a post-boot
   * `openWorkspace` triggers — the race window behind flaky LSP-provider polls
   * and dying-host Disposable leaks. Default undefined → launch with an empty
   * window (unchanged).
   *
   * Playwright treats a bare function passed via `test.use` as a fixture
   * override (its `TestFixtureValue` type even `Exclude`s `Function`), so the
   * callback is wrapped in an object — same pitfall as p4Seeds' bare array.
   */
  workspaceSeeder: WorkspaceSeeder | undefined
  /** The launched workspace, or undefined when no workspaceSeeder is set. */
  launchWorkspace: LaunchWorkspace | undefined
}

export interface WorkspaceSeeder {
  /** Populate the per-test workspace folder before the app launches. */
  seed(dir: string): void
}

export interface LaunchWorkspace {
  /** Launched workspace folder (absolute, forward-slashed, realpath-normalized). */
  readonly dir: string
  /** Absolute forward-slashed path of a file inside the workspace. */
  file(relPath: string): string
}

export type E2ETest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & E2EFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>

/**
 * Cold-launch fixture: a fresh Electron process per test. See module header for
 * when to prefer this over the shared instance.
 */
export function createColdAppTest(config: AppFixtureConfig): E2ETest {
  return base.extend<E2EFixtures>({
    workspaceSeeder: [undefined, { option: true }],
    launchWorkspace: async ({ workspaceSeeder }, use) => {
      if (!workspaceSeeder) {
        await use(undefined)
        return
      }
      // realpathSync.native: CI Windows tmpdir can be an 8.3 short path; normalize
      // to the long form so path comparisons inside the app agree.
      const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'universe-editor-e2e-ws-')))
      workspaceSeeder.seed(dir)
      const posix = dir.replace(/\\/g, '/')
      await use({ dir: posix, file: (rel) => `${posix}/${rel}` })
    },
    electronApp: [
      async ({ launchWorkspace }, use, testInfo) => {
        const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-'))
        seedBaselineUserData(userDataDir)
        // launchAppReady covers the launch-succeeded-but-no-window failure mode:
        // it retries the whole chain once, and on failure reaps the half-dead
        // process itself — a fixture throwing here before use() would skip this
        // teardown's closeApp and orphan the Electron (secondary symptom:
        // "Worker teardown timeout").
        const { app, page } = await launchAppReady({
          appRoot: config.appRoot,
          mainEntry: config.mainEntry,
          userDataDir,
          ...(config.extensions !== undefined ? { extensions: config.extensions } : {}),
          ...(config.env !== undefined ? { env: config.env } : {}),
          // Positional folder arg → main's parseFileToOpen → openWindowForFolder:
          // the app boots with this workspace already attached.
          extraArgs: [
            ...(config.extraArgs ?? []),
            ...(launchWorkspace ? [launchWorkspace.dir] : []),
          ],
        })
        // After closeApp so the log tail is flushed before the failure copy.
        const finalizeForensics = installFailureForensics(page, userDataDir)
        await use(app)
        await closeApp(app)
        await finalizeForensics(testInfo)
      },
      // Own budget: the worst-case launchAppReady path is launch-layer retries
      // (~40s) + 2×30s firstWindow waits + a force-kill closeApp on the failed
      // attempt (~20s), and teardown's own closeApp can legitimately take ~20s
      // on the force-kill path (10s graceful wait + tree enumeration + orphan
      // sweep); sharing the 30s test budget with the body risks flagging a
      // successful teardown.
      { timeout: 120_000 },
    ],
    page: async ({ electronApp }, use) => {
      const page = await electronApp.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      // 等待 renderer 装上探针(LifecyclePhase.Ready 之后).
      await waitForProbe(page)
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
}

type WorkerApp = {
  app: ElectronApplication
  page: Page
  userDataDir: string
  // Worker-level flag so the very first test skips the redundant reset — the
  // freshly launched window is already a clean first-frame.
  firstTest: { value: boolean }
}

/**
 * Wipe the per-workspace session dir. A spec that opened a folder leaves its
 * editor groups under workspaces/<id>.json; without clearing it the next test's
 * reload restores those ghost editors. The retry loop (not rmSync's built-in
 * maxRetries) recovers from a debounced atomic write landing mid-delete: the
 * main-process storage backend survives a reload and can drop a fresh `.tmp`
 * that makes the parent rmdir hit ENOTEMPTY, which rmSync's own retry (its
 * readdir already passed) does not recover from.
 */
async function wipeWorkspacesDir(userDataDir: string): Promise<void> {
  const wsDir = join(userDataDir, 'workspaces')
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(wsDir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt >= 10) throw err
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

/**
 * Reset the shared instance to a clean first-frame: rewrite userData to the
 * initial content, then reload the window so the renderer rebuilds from that
 * clean on-disk state. The reload reads the disk we just rewrote — the old
 * session's beforeunload persist does NOT clobber it (verified empirically).
 */
async function resetWindow(page: Page, userDataDir: string): Promise<void> {
  // Detach the main-process workspace BEFORE the reload. A window reload does
  // not close the folder, and the WORKSPACE-scope storage backend lives in
  // main-process memory — wiping workspaces/ on disk does not invalidate it.
  // Reloading with the folder still attached lets the fresh renderer's views
  // reconcile (ViewsService.reconcileFromStorage) read the previous test's
  // persisted container selection (e.g. Search) out of that in-memory bucket
  // whenever the post-reload closeWorkspace below loses the 500ms settle race.
  // The spec's own activity-bar click then TOGGLES the already-active container
  // closed instead of opening it. Closing the folder first flushes and releases
  // the bucket, so the reload deterministically boots into the no-workspace
  // scope. The old page may be wedged (e.g. native watcher crash) — tolerate
  // failures, the reload below rebuilds the renderer either way.
  try {
    await page.evaluate(() => window.__E2E__!.closeWorkspace())
  } catch {
    // best-effort: reload rescues a wedged page
  }
  seedBaselineUserData(userDataDir)
  await wipeWorkspacesDir(userDataDir)
  // The GLOBAL-scope storage backend (state.json) is a main-process object with
  // an in-memory cache, and the window reload below does NOT rebuild it —
  // without dropping that cache the fresh renderer would keep reading the
  // previous test's state (e.g. the ACP session-history entries it persisted),
  // and any renderer write afterwards would resurrect the stale keys on disk.
  try {
    await page.evaluate(() => window.__E2E__!.reloadStorageFromDisk())
  } catch {
    // best-effort: a wedged page is rescued by the reload below
  }
  const loaded = page.waitForEvent('load')
  void page
    .evaluate(() => void window.__E2E__!.runCommand('workbench.action.reloadWindow'))
    .catch(() => {})
  await loaded
  await waitForProbe(page)
  // Tolerate a mid-evaluate context teardown on slow reloads (mirrors WorkbenchPO).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Re-assert the pristine storage state post-reload: a debounced renderer
      // write from the previous test may have slipped into the main-process
      // cache in the gap between the pre-reload reset and the reload itself.
      // Flush it out, drop the cache again, and put the pristine disk back.
      await page.evaluate(() => window.__E2E__!.reloadStorageFromDisk())
      seedBaselineUserData(userDataDir)
      await page.evaluate(() => window.__E2E__!.whenRestored())
      // Belt-and-braces: the folder was already closed before the reload above,
      // so this is normally a no-op (closeFolder early-returns with no current
      // workspace). It still covers the rare case where the pre-reload close
      // failed on a wedged page.
      await page.evaluate(() => window.__E2E__!.closeWorkspace())
      // Navigation back/forward stack lives in the main-process HistoryService,
      // which a reload does NOT clear. Wipe it so a prior test's navigation
      // entries can't leak into this test's GoBack behaviour.
      await page.evaluate(() => window.__E2E__!.runCommand('workbench.action.clearHistory'))
      return
    } catch (err) {
      if (attempt === 2 || !/Execution context was destroyed/.test(String(err))) throw err
      await page.waitForLoadState('domcontentloaded')
      await waitForProbe(page)
    }
  }
}

export interface SharedE2EFixtures extends E2EFixtures {
  // Auto fixture (runs for every test even when unused): resets the shared
  // window before the body and asserts no Disposable leaks after it. Hanging the
  // gate here — rather than on `workbench` — means a spec that only pulls `page`
  // or `electronApp` (e.g. smoke.startup) is still reset and still leak-checked.
  _leakGate: void
}

type SharedWorkerFixtures = {
  sharedApp: WorkerApp
}

export type SharedE2ETest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & SharedE2EFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & SharedWorkerFixtures
>

/**
 * Shared-instance fixture: ONE Electron per worker, reset between tests. See
 * module header for when to prefer this over the cold-launch fixture.
 */
export function createSharedAppTest(config: AppFixtureConfig): SharedE2ETest {
  return base.extend<SharedE2EFixtures, SharedWorkerFixtures>({
    sharedApp: [
      async ({}, use: (app: WorkerApp) => Promise<void>) => {
        const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-shared-'))
        seedBaselineUserData(userDataDir)
        await wipeWorkspacesDir(userDataDir)
        // Same launch-succeeded-but-no-window guard as the cold fixture — on
        // failure launchAppReady reaps the half-dead process itself (a worker
        // fixture throwing before use() skips teardown entirely).
        const { app, page } = await launchAppReady({
          appRoot: config.appRoot,
          mainEntry: config.mainEntry,
          userDataDir,
          ...(config.extensions !== undefined ? { extensions: config.extensions } : {}),
          ...(config.env !== undefined ? { env: config.env } : {}),
          ...(config.extraArgs !== undefined ? { extraArgs: config.extraArgs } : {}),
        })
        await use({ app, page, userDataDir, firstTest: { value: true } })
        // A still-running ACP session / node-pty child can wedge a graceful
        // app.close() past the worker-teardown budget (the SessionShutdownParticipant
        // veto needs a confirm dialog no one can answer headlessly). Bound it and
        // force-kill, exactly as the cold-launch fixture does.
        await closeApp(app)
      },
      // Own budget, decoupled from the 30s worker-teardown default: a worker can
      // host several shared apps (one per shared fixture type it touched), and
      // each closeApp may legitimately take ~20s on the force-kill path — two of
      // those in sequence already blow a shared 30s budget even though every
      // process dies. Seen live as "Worker teardown timeout of 30000ms exceeded"
      // with all tests passing. 120s also covers the launchAppReady worst case
      // (launch-layer retries ~40s + 2×30s firstWindow waits + a force-kill
      // closeApp on the failed attempt ~20s) before the first test even runs.
      { scope: 'worker', timeout: 120_000 },
    ],
    electronApp: async ({ sharedApp }, use) => {
      await use(sharedApp.app)
    },
    page: async ({ sharedApp }, use) => {
      await use(sharedApp.page)
    },
    workbench: async ({ sharedApp }, use) => {
      await use(new WorkbenchPO(sharedApp.page))
    },
    workspaceSeeder: [undefined, { option: true }],
    launchWorkspace: async ({ workspaceSeeder }, use) => {
      // A shared worker-scoped app launches once, before any test — a per-test
      // launch folder is structurally impossible here. Fail loud instead of
      // silently ignoring the seeder.
      if (workspaceSeeder) {
        throw new Error('workspaceSeeder requires a cold-launch fixture (createColdAppTest)')
      }
      await use(undefined)
    },
    _leakGate: [
      async ({ sharedApp }, use, testInfo) => {
        // Setup (before the test body): reset the shared window to a clean
        // first-frame. The very first test skips this — the freshly launched
        // window is already clean.
        if (sharedApp.firstTest.value) {
          sharedApp.firstTest.value = false
        } else {
          await resetWindow(sharedApp.page, sharedApp.userDataDir)
        }
        const finalizeForensics = installFailureForensics(sharedApp.page, sharedApp.userDataDir)
        await use()
        // The app keeps running (worker-scoped) — copy before the leak gate so a
        // body failure is captured even when the gate throws too. The log tail
        // may still be buffered; that beats losing everything.
        await finalizeForensics(testInfo)
        // Teardown gate: fail the test if the session leaked any Disposables. This
        // unmounts React on the shared page; the next test's resetWindow reloads
        // the window (rebuilding the UI), and the worker fixture closes the app
        // after the last test — so every test, including the last, is covered.
        await expectNoLeaks(sharedApp.page)
      },
      { auto: true },
    ],
  })
}
