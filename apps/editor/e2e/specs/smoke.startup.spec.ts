/*---------------------------------------------------------------------------------------------
 *  S1 — Startup smoke (P0).
 *
 *  验证应用启动后:
 *    - window.__E2E__ 被装配
 *    - probe.whenReady() 立即 resolve (Ready phase 之后才安装 probe)
 *    - getLifecyclePhase() 至少为 'Ready'
 *    - ContextKey `workbenchReady` 为 true
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p0 startup', () => {
  test('workbench reaches Ready and exposes E2E probe', async ({ page }) => {
    const phase = await page.evaluate(() => window.__E2E__!.getLifecyclePhase())
    expect(['Ready', 'Restored', 'Eventually']).toContain(phase)

    await page.evaluate(() => window.__E2E__!.whenReady())

    const workbenchReady = await page.evaluate(() =>
      window.__E2E__!.getContextKey('workbenchReady'),
    )
    expect(workbenchReady).toBe(true)
  })

  test('main window has a non-empty title', async ({ electronApp }) => {
    const title = await electronApp.firstWindow().then((w) => w.title())
    expect(title.length).toBeGreaterThan(0)
  })
})
