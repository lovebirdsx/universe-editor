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
import { WorkbenchPO } from '../pages/WorkbenchPO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = resolve(__dirname, '..', '..')
export const MAIN_ENTRY = resolve(APP_ROOT, 'out', 'main', 'index.js')

export type E2EFixtures = {
  electronApp: ElectronApplication
  page: Page
  workbench: WorkbenchPO
}

export const test = base.extend<E2EFixtures>({
  electronApp: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-'))
    // Pin UI language for deterministic assertions across CI/dev machines.
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ 'workbench.language': 'en-US' }, null, 2),
      'utf8',
    )
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      cwd: APP_ROOT,
      env: {
        ...process.env,
        UNIVERSE_E2E: '1',
        NODE_ENV: process.env['NODE_ENV'] ?? 'production',
      },
    })
    await use(app)
    await app.close()
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // 等待 renderer 装上探针(LifecyclePhase.Ready 之后).
    await page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )
    await use(page)
  },
  workbench: async ({ page }, use) => {
    await use(new WorkbenchPO(page))
  },
})

export { expect } from '@playwright/test'
