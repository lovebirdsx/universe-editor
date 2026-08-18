/*---------------------------------------------------------------------------------------------
 *  Window-private log isolation (P1).
 *
 *  An unexpected error logged in one window must not leak into another window's
 *  Output. The auto-reveal contribution subscribes to the per-window logFiles
 *  stream, so window B's error never reveals window A's panel. B holds the
 *  reveal pending until it becomes the top window — focused (or the last
 *  focused fallback in silent E2E), at which point it reveals and A stays
 *  untouched.
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

async function panelVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__E2E__!.getContextKey('panelVisible') as boolean)
}

test.describe('@p1 log isolation', () => {
  test('an error in a background window reveals only after it becomes the top window', async ({
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

    // Window B is not the top window (window A is), so its error stays pending
    // and the panel must remain hidden — no immediate cross-window reveal.
    expect(await panelVisible(pageB)).toBe(false)
    await pageB.waitForTimeout(1000)
    expect(await panelVisible(pageB)).toBe(false)

    // Once B becomes the top window (programmatic focus — silent E2E windows
    // never take real OS focus), the pending error reveals B's panel...
    const bId = await page.evaluate(async (targetFolder) => {
      const windows = await window.__E2E__!.getOpenWindows()
      const match = windows.find((w) => w.folder === targetFolder)
      if (!match) {
        throw new Error(`no window for folder ${targetFolder}: ${JSON.stringify(windows)}`)
      }
      return match.id
    }, folder)
    await pageB.evaluate((id) => window.__E2E__!.focusWindow(id), bId)

    await expect.poll(() => panelVisible(pageB), { timeout: 10_000 }).toBe(true)

    // ...while window A stays hidden — no cross-window leak.
    await expect
      .poll(() => workbench.getContextKey<boolean>('panelVisible'), { timeout: 2_000 })
      .toBe(false)
  })
})
