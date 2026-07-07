/*---------------------------------------------------------------------------------------------
 *  Window-private log isolation (P1).
 *
 *  An unexpected error logged in one window must not leak into another window's
 *  Output. The auto-reveal contribution subscribes to the per-window logFiles
 *  stream, so window B's error reveals B's panel but leaves A's panel untouched.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'
import type { Page } from '@playwright/test'

async function waitForProbe(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
  )
  await evaluateWhenRestored(page)
}

async function hidePanel(page: Page): Promise<void> {
  const visible = await page.evaluate(
    () => window.__E2E__!.getContextKey('panelVisible') as boolean,
  )
  if (visible) {
    await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.togglePanel'))
  }
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('panelVisible') as boolean))
    .toBe(false)
}

test.describe('@p1 log isolation', () => {
  test('an error in one window does not reveal another window output', async ({
    electronApp,
    workbench,
    page,
  }) => {
    await workbench.waitForRestored()

    const folder = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-logiso-'))
    const newWindow = electronApp.waitForEvent('window')
    await workbench.openFolderInNewWindow(folder)
    const pageB = await newWindow
    await waitForProbe(pageB)

    await hidePanel(page)
    await hidePanel(pageB)

    await pageB.evaluate(() => {
      window.__E2E__!.triggerUnexpectedError('E2E window-B private error')
    })

    // Window B reveals its own panel...
    await expect
      .poll(() => pageB.evaluate(() => window.__E2E__!.getContextKey('panelVisible') as boolean), {
        timeout: 10_000,
      })
      .toBe(true)

    // ...while window A stays hidden — no cross-window leak.
    await expect
      .poll(() => workbench.getContextKey<boolean>('panelVisible'), { timeout: 2_000 })
      .toBe(false)
  })
})
