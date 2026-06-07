/*---------------------------------------------------------------------------------------------
 *  Smoke spec: NotificationService — toast + center + clearAll (P0).
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p0 notification service', () => {
  test('toast appears, auto-hides after 3 s, center shows history, clearAll empties it', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()

    // 0. Clear any startup notifications (e.g. extension-host crash noise) so
    //    subsequent count assertions are only affected by our test notification.
    await workbench.runCommand('workbench.action.notifications.clearAll')

    // 1. Trigger a test notification.
    await workbench.runCommand('workbench.action.notifications.test')

    // 2. Toast item should appear in the DOM.
    await expect(
      workbench.page.locator('[data-testid="notification-toast-item"]').first(),
    ).toBeVisible()

    // 3. Toast auto-reads after 3 s and disappears. Poll instead of a fixed
    //    sleep so a slightly delayed renderer timer can't race the assertion.
    await expect(workbench.page.locator('[data-testid="notification-toast-item"]')).toHaveCount(0, {
      timeout: 8_000,
    })

    // 4. Bell badge should not show a count (unreadCount = 0). Poll to avoid a
    //    transient read at the exact moment the auto-read timer settles.
    await expect
      .poll(async () => {
        const entries = await workbench.statusBar.entriesFromProbe()
        const bell = entries.find((e) => e.alignment === 'right' && e.icon === 'bell')
        return bell?.text ?? '<none>'
      })
      .not.toMatch(/\d/)

    // 5. Open notification center → still holds the read (but not dismissed) notification.
    //    Use text-based filtering instead of exact count to tolerate any transient
    //    background notifications (e.g. extension host restarts) that may co-exist.
    await workbench.runCommand('workbench.action.notifications.toggleList')
    await expect(workbench.page.locator('[data-testid="notifications-center"]')).toBeVisible()
    await expect(
      workbench.page
        .locator('[data-testid="notification-center-item"]')
        .filter({ hasText: 'This is a test notification.' }),
    ).toBeVisible()

    // 6. Clear all → center becomes empty.
    await workbench.runCommand('workbench.action.notifications.clearAll')
    await expect(workbench.page.locator('[data-testid="notification-center-item"]')).toHaveCount(0)
  })

  test('sticky notification stays in toast until dismissed', async ({ workbench }) => {
    await workbench.waitForRestored()

    // Trigger a sticky Error notification via the unexpected error handler.
    await workbench.page.evaluate(() => {
      window.__E2E__!.triggerUnexpectedError('E2E sticky test')
    })

    // Toast should stay visible after 3 s because it's sticky.
    await workbench.page.waitForTimeout(3500)
    await expect(
      workbench.page.locator('[data-testid="notification-toast-item"]').first(),
    ).toBeVisible()

    // Dismiss via clearAll.
    await workbench.runCommand('workbench.action.notifications.clearAll')
    await expect(workbench.page.locator('[data-testid="notification-toast-item"]')).toHaveCount(0)
  })
})
