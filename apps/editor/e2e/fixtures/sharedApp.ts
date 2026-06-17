/*---------------------------------------------------------------------------------------------
 *  Worker-scoped Electron fixture (shared instance + per-test reset).
 *
 *  Unlike `electronApp.ts` — which cold-launches a fresh Electron process for
 *  every test — this fixture launches ONE Electron per Playwright worker and
 *  resets it between tests by rewriting the userData files back to their initial
 *  content and reloading the window. Cold start (~2.5s) is the dominant cost of
 *  the smoke suite; amortizing it across a worker's tests is the single biggest
 *  speedup.
 *
 *  Use this fixture ONLY for specs whose state lives entirely in the renderer
 *  (editor models, layout, quick input, history…). A window reload does NOT
 *  tear down main-process state — extra BrowserWindows, terminal PTYs, ACP
 *  sessions — so specs that touch those must keep using `electronApp.ts`
 *  (cold-launch per test) or self-launch via `_electron`.
 *--------------------------------------------------------------------------------------------*/

import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { WorkbenchPO, expectNoLeaks } from '../pages/WorkbenchPO.js'
import { APP_ROOT, MAIN_ENTRY, closeApp } from './electronApp.js'

// Initial userData content every test starts from. Mirrors electronApp.ts:
// pin language + disable auto-update, and mark Agent onboarding as seen so the
// default layout is deterministic.
const INITIAL_SETTINGS = JSON.stringify(
  { 'workbench.language': 'en-US', 'update.mode': 'manual' },
  null,
  2,
)
const INITIAL_STATE = JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2)

function seedUserData(userDataDir: string): void {
  writeFileSync(join(userDataDir, 'settings.json'), INITIAL_SETTINGS, 'utf8')
  writeFileSync(join(userDataDir, 'state.json'), INITIAL_STATE, 'utf8')
  // Per-workspace session (open editor groups, layout) lives under
  // workspaces/<id>.json. A spec that opened a folder leaves its editor groups
  // there; without clearing it the next test's reload restores those ghost
  // editors (e.g. getEditorGroupCount returns 2 instead of 1). Wipe the whole
  // directory so every test reloads to a pristine, workspace-less first frame.
  rmSync(join(userDataDir, 'workspaces'), { recursive: true, force: true })
}

async function waitForProbe(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
}

/**
 * Reset the shared instance to a clean first-frame: rewrite userData to the
 * initial content, then reload the window so the renderer rebuilds from that
 * clean on-disk state. The reload reads the disk we just rewrote — the old
 * session's beforeunload persist does NOT clobber it (verified empirically).
 */
async function resetWindow(page: Page, userDataDir: string): Promise<void> {
  seedUserData(userDataDir)
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

type WorkerApp = {
  app: ElectronApplication
  page: Page
  userDataDir: string
  // Worker-level flag so the very first test skips the redundant reset — the
  // freshly launched window is already a clean first-frame.
  firstTest: { value: boolean }
}

export type SharedE2EFixtures = {
  electronApp: ElectronApplication
  page: Page
  workbench: WorkbenchPO
  // Auto fixture (runs for every test even when unused): resets the shared
  // window before the body and asserts no Disposable leaks after it. Hanging the
  // gate here — rather than on `workbench` — means a spec that only pulls `page`
  // or `electronApp` (e.g. smoke.startup) is still reset and still leak-checked.
  _leakGate: void
}

type SharedWorkerFixtures = {
  sharedApp: WorkerApp
}

export const test = base.extend<SharedE2EFixtures, SharedWorkerFixtures>({
  sharedApp: [
    async ({}, use: (app: WorkerApp) => Promise<void>) => {
      const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-shared-'))
      seedUserData(userDataDir)
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

export { expect } from '@playwright/test'
