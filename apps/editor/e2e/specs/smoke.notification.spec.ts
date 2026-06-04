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

    // 3. Wait for auto-read timer (3 s) + small buffer.
    await workbench.page.waitForTimeout(3500)

    // 4. Toast items gone (notification became read).
    await expect(workbench.page.locator('[data-testid="notification-toast-item"]')).toHaveCount(0)

    // 5. Bell badge should not show a count (unreadCount = 0).
    const entriesBefore = await workbench.statusBar.entriesFromProbe()
    const bellBefore = entriesBefore.find((e) => e.alignment === 'right' && e.icon === 'bell')
    expect(bellBefore).toBeDefined()
    expect(bellBefore?.text).not.toMatch(/\d/)

    // 6. Open notification center → still holds the read (but not dismissed) notification.
    //    Use text-based filtering instead of exact count to tolerate any transient
    //    background notifications (e.g. extension host restarts) that may co-exist.
    await workbench.runCommand('workbench.action.notifications.toggleList')
    await expect(workbench.page.locator('[data-testid="notifications-center"]')).toBeVisible()
    await expect(
      workbench.page
        .locator('[data-testid="notification-center-item"]')
        .filter({ hasText: 'This is a test notification.' }),
    ).toBeVisible()

    // 7. Clear all → center becomes empty.
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
