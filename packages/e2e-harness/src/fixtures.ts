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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { WorkbenchPO, expectNoLeaks } from './pages/WorkbenchPO.js'
import { closeApp, launchApp, seedBaselineUserData } from './launch.js'

export interface AppFixtureConfig {
  readonly appRoot: string
  readonly mainEntry: string
  /** Extension allowlist (P2). Omit to activate all scanned extensions. */
  readonly extensions?: readonly string[]
}

export interface E2EFixtures {
  electronApp: ElectronApplication
  page: Page
  workbench: WorkbenchPO
}

export type E2ETest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & E2EFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>

export async function waitForProbe(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
}

/**
 * Cold-launch fixture: a fresh Electron process per test. See module header for
 * when to prefer this over the shared instance.
 */
export function createColdAppTest(config: AppFixtureConfig): E2ETest {
  return base.extend<E2EFixtures>({
    electronApp: async ({}, use) => {
      const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-'))
      seedBaselineUserData(userDataDir)
      const app = await launchApp({
        appRoot: config.appRoot,
        mainEntry: config.mainEntry,
        userDataDir,
        ...(config.extensions !== undefined ? { extensions: config.extensions } : {}),
      })
      await use(app)
      await closeApp(app)
    },
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
  seedBaselineUserData(userDataDir)
  await wipeWorkspacesDir(userDataDir)
  const loaded = page.waitForEvent('load')
  void page
    .evaluate(() => void window.__E2E__!.runCommand('workbench.action.reloadWindow'))
    .catch(() => {})
  await loaded
  await waitForProbe(page)
  // Tolerate a mid-evaluate context teardown on slow reloads (mirrors WorkbenchPO).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.evaluate(() => window.__E2E__!.whenRestored())
      // A window reload does NOT tear down main-process workspace state, so a
      // prior test that opened a folder leaves it open — the reload then restores
      // that workspace's editor groups (a ghost pinned tab from e.g.
      // smoke.editorTabDnD leaks into this test's active group). seedUserData's
      // disk wipe of workspaces/ races the main-process debounced session write
      // and cannot be relied on. Deterministically close the folder here: it
      // swaps to the no-workspace scope and tears down the restored groups.
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
        const app = await launchApp({
          appRoot: config.appRoot,
          mainEntry: config.mainEntry,
          userDataDir,
          ...(config.extensions !== undefined ? { extensions: config.extensions } : {}),
        })
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await waitForProbe(page)
        await use({ app, page, userDataDir, firstTest: { value: true } })
        // A still-running ACP session / node-pty child can wedge a graceful
        // app.close() past the worker-teardown budget (the SessionShutdownParticipant
        // veto needs a confirm dialog no one can answer headlessly). Bound it and
        // force-kill, exactly as the cold-launch fixture does.
        await closeApp(app)
      },
      { scope: 'worker' },
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
    _leakGate: [
      async ({ sharedApp }, use) => {
        // Setup (before the test body): reset the shared window to a clean
        // first-frame. The very first test skips this — the freshly launched
        // window is already clean.
        if (sharedApp.firstTest.value) {
          sharedApp.firstTest.value = false
        } else {
          await resetWindow(sharedApp.page, sharedApp.userDataDir)
        }
        await use()
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
