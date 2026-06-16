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
import { tmpdir } from 'node:os'
import { WorkbenchPO, expectNoLeaks } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = resolve(__dirname, '..', '..')
export const MAIN_ENTRY = resolve(APP_ROOT, 'out', 'main', 'index.js')

// `app.close()` waits for the Electron process to fully exit. node-pty children
// (integrated terminal) can keep the main process's event loop alive on CI long
// enough to blow past the test timeout during teardown — observed flaky only on
// the terminal spec. Fall back to force-killing the underlying process if the
// graceful close doesn't finish promptly.
const CLOSE_TIMEOUT_MS = 10_000

async function closeApp(app: ElectronApplication): Promise<void> {
  let proc: ReturnType<ElectronApplication['process']>
  try {
    // workbench.action.quit already tore the process down; the Playwright
    // handle is disposed and process() throws. Nothing left to close.
    proc = app.process()
  } catch {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    app
      .close()
      .then(() => false)
      .catch(() => false),
    new Promise<boolean>((res) => {
      timer = setTimeout(() => res(true), CLOSE_TIMEOUT_MS)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (timedOut && proc.pid !== undefined && proc.exitCode === null) proc.kill('SIGKILL')
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
