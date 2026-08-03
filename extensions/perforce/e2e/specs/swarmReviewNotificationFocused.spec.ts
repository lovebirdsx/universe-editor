/*---------------------------------------------------------------------------------------------
 *  Swarm review notification with the window FOCUSED — end-to-end over the fake
 *  Swarm server. Reproduces the user report: with
 *  `perforce.swarm.backgroundPoll.enabled: true` and the editor sitting in the
 *  foreground, a newly-arriving review raises NO notification at all.
 *
 *  While the window is focused the OS toast is gated main-side
 *  (hostMainService.notify returns shown:false), so the contribution must fall
 *  back to the in-app sticky toast — this spec asserts that toast actually
 *  appears, not just that the probe recorded the notify decision.
 *--------------------------------------------------------------------------------------------*/

import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import { expect, test } from '../fixtures/swarmApp.js'

test.describe('@p1 swarm review notification with the window focused', () => {
  // The background poll itself is opt-in (default off), so enable it here. The
  // env override runs the host poller below the product 10s floor (still 60x
  // faster than the renderer's 60s backstop) — otherwise the detect phase alone
  // waits a full 10s interval.
  test.use({
    swarmExtraSettings: {
      'perforce.swarm.pollInterval': 10,
      'perforce.swarm.backgroundPoll.enabled': true,
    },
    swarmExtraEnv: { UNIVERSE_SWARM_POLL_INTERVAL_MS: '1000' },
  })

  test('a new review raises the in-app fallback toast while the window is focused', async ({
    page,
    swarm,
  }) => {
    await evaluateWhenRestored(page)

    // Baseline prime off the host poller (no probe-driven polls): the seeded
    // actionable reviews must appear without notifying.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSwarmNotifyDiag().lastActionable.length), {
        timeout: 40_000,
      })
      .toBeGreaterThan(0)
    expect(await page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds())).toEqual([])

    // The spec's premise is "window focused" — but every worker's win.show()
    // grabs the OS foreground at launch, and at 1s ticks the notify lands inside
    // the parallel launch churn. Re-assert focus right before the review lands
    // so the OS toast is reliably gated to the in-app fallback.
    await page.bringToFront()

    // A brand-new review lands, requiring the e2e user's action.
    await swarm.addReview({ id: '2001', author: 'dave', description: 'Urgent hotfix' })

    // The next host tick (≤1s out) must detect and notify.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds()), {
        timeout: 40_000,
      })
      .toEqual([['2001']])

    // The decision fired — but the user sees nothing unless the in-app fallback
    // toast actually renders (the OS toast is gated while focused). Generous
    // timeout: the probe fires before `_fire` awaits the gated host.notify RPC,
    // which can lag under parallel-worker load.
    await expect(
      page.locator('[data-testid="notification-toast-item"]').filter({ hasText: '#2001' }),
    ).toBeVisible({ timeout: 15_000 })
  })
})
