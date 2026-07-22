/*---------------------------------------------------------------------------------------------
 *  Swarm review desktop-notification regression — end-to-end over the fake Swarm
 *  server. Reproduces the bug where a review that newly enters "Needs My Action"
 *  during the session never raises a notification: the background poll re-read a
 *  TTL-cached dashboard, so a review that appeared after the cache warmed was
 *  never surfaced.
 *
 *  The desktop toast itself is main-side, gated on window blur + OS notification
 *  support (neither holds in a headless run), so the spec observes the decision
 *  the contribution actually makes — the ids it chose to notify about — via the
 *  E2E probe. It never opens the Swarm view: the notification poll runs on the
 *  contribution's own timer, so a new review must surface even with the view shut.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/swarmApp.js'

test.describe('@p1 swarm review notification', () => {
  test('notifies when a new review enters Needs My Action mid-session', async ({ page, swarm }) => {
    await page.evaluate(() => window.__E2E__!.whenRestored())

    // Let the baseline prime: the perforce extension host activates lazily, so the
    // first polls can race it (dashboard command not registered → poll no-ops).
    // Drive polls until one succeeds and sees the seeded actionable reviews — that
    // poll establishes the baseline. A new review after this must be detected.
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.__E2E__!.driveSwarmNotificationPoll())
          return page.evaluate(() => window.__E2E__!.getSwarmNotifyDiag().lastActionable.length)
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0)

    // Baseline primed off the seeded reviews → nothing notified yet.
    expect(await page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds())).toEqual([])

    // A brand-new review lands, requiring the e2e user's action.
    await swarm.addReview({ id: '2001', author: 'dave', description: 'Urgent hotfix' })

    // Poll again — exactly what the 60s timer does. The contribution must re-fetch
    // (not re-read the stale cache) and surface #2001 as newly actionable.
    await page.evaluate(() => window.__E2E__!.driveSwarmNotificationPoll())

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds()), {
        timeout: 10_000,
      })
      .toEqual([['2001']])
  })

  // The badge is driven by the same background poll as the notification, so it
  // must reflect the Needs My Action count even with the Swarm view never opened.
  test('activity bar badge mirrors the Needs My Action count', async ({ page, swarm }) => {
    await page.evaluate(() => window.__E2E__!.whenRestored())
    const badge = page.getByTestId('activitybar-badge-workbench.view.swarm')

    // Prime the baseline exactly like the notification test: drive fast probes
    // until one poll lands past the extension-host activation race. (Asserting
    // the not-yet-rendered badge locator here would auto-wait and deadlock the
    // poll loop against its own timeout.)
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.__E2E__!.driveSwarmNotificationPoll())
          return page.evaluate(() => window.__E2E__!.getSwarmNotifyDiag().lastActionable.length)
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0)

    // The five seeded reviews are all actionable → badge shows on the Swarm icon.
    await expect(badge).toHaveText('5')

    await swarm.addReview({ id: '2001', author: 'dave', description: 'Urgent hotfix' })
    await page.evaluate(() => window.__E2E__!.driveSwarmNotificationPoll())
    await expect(badge).toHaveText('6')
  })
})
