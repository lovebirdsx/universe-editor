/*---------------------------------------------------------------------------------------------
 *  Host-driven Swarm poll-tick regression — end-to-end over the fake Swarm server.
 *  Reproduces the bug where NO new-review notification ever fires while the window
 *  sits in the background: the renderer's own 60s poll timer is background-
 *  throttled there, so background detection depends entirely on the perforce
 *  extension host's SwarmNotificationPoller poking `_workbench.swarmPollTick`.
 *
 *  Unlike swarmReviewNotification.spec.ts — which drives polls synchronously via
 *  the E2E probe — this spec NEVER drives a poll. Detection must come from the
 *  host poller alone: its tick (1s via UNIVERSE_SWARM_POLL_INTERVAL_MS) is 60x
 *  faster than the renderer's 60s backstop timer, so any detection observed
 *  well before 60s could only have come from a host-driven tick.
 *--------------------------------------------------------------------------------------------*/

import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import { expect, test } from '../fixtures/swarmApp.js'

test.describe('@p1 swarm host-driven poll tick', () => {
  // The background poll itself is opt-in (default off), so enable it here. The
  // env override runs the host poller below the product 10s floor (still 60x
  // faster than the renderer's 60s backstop, so the "host tick did it" premise
  // holds) — otherwise the detect phase alone waits a full 10s interval.
  test.use({
    swarmExtraSettings: {
      'perforce.swarm.pollInterval': 10,
      'perforce.swarm.backgroundPoll.enabled': true,
    },
    swarmExtraEnv: { UNIVERSE_SWARM_POLL_INTERVAL_MS: '1000' },
  })

  test('host poll tick primes the baseline and notifies about a new review, with no probe-driven polls', async ({
    page,
    swarm,
  }) => {
    await evaluateWhenRestored(page)

    // Baseline prime WITHOUT driving a poll: the host poller ticks immediately
    // on start (then every 10s), so it must fill lastActionable long before the
    // renderer's 60s backstop could. If host ticks never reach the contribution,
    // this times out at 40s — well ahead of the 60s renderer timer — proving
    // the poke path is broken.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSwarmNotifyDiag().lastActionable.length), {
        timeout: 40_000,
      })
      .toBeGreaterThan(0)

    // Priming is silent: the six seeded actionable reviews must not notify.
    expect(await page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds())).toEqual([])

    // A brand-new review lands, requiring the e2e user's action.
    await swarm.addReview({ id: '2001', author: 'dave', description: 'Urgent hotfix' })

    // The next host tick (≤1s out) must detect and notify — again long before the
    // renderer backstop could.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds()), {
        timeout: 40_000,
      })
      .toEqual([['2001']])
  })
})
