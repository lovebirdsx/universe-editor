/*---------------------------------------------------------------------------------------------
 *  Background notification under REAL Chromium throttling — the e2e blind spot of
 *  the 2026-08 incident (2.5h of silently dropped polls while the window sat
 *  occluded). Production windows now run with `backgroundThrottling: false`
 *  (VSCode parity); this spec opts back INTO throttling via UNIVERSE_E2E_THROTTLE=1
 *  and minimizes the window, so the Phase-1 hardening is exercised against a
 *  genuinely throttled renderer:
 *
 *    1. The host poller must keep ticking without any renderer round-trip on its
 *       own path (synchronous configured cache + fire-and-forget poke).
 *    2. If the throttled renderer is too frozen to answer mid-test, restoring the
 *       window must surface the review immediately via the visibilitychange
 *       catch-up tick — "reviews appear the moment the user comes back" is an
 *       explicit guarantee, not a throttling side effect.
 *
 *  Timing-sensitive: tagged @serial + @regression with generous timeouts. If a CI
 *  environment turns out to make Chromium throttling unobservable (perma-green),
 *  treat this as the scripted version of the manual checklist: minimize the editor
 *  with background poll on, land a review, restore — the badge must appear.
 *--------------------------------------------------------------------------------------------*/

import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import { expect, test } from '../fixtures/swarmApp.js'

test.describe('@regression @serial swarm notification under real background throttling', () => {
  test.use({
    swarmExtraSettings: {
      'perforce.swarm.pollInterval': 10,
      'perforce.swarm.backgroundPoll.enabled': true,
    },
    swarmExtraEnv: {
      UNIVERSE_SWARM_POLL_INTERVAL_MS: '1000',
      // Re-enable Chromium background throttling (production now disables it).
      UNIVERSE_E2E_THROTTLE: '1',
    },
  })

  test('a new review surfaces for a minimized, genuinely throttled window', async ({
    page,
    electronApp,
    swarm,
  }) => {
    await evaluateWhenRestored(page)

    // Baseline prime from the host poller alone (never probe-driven), same
    // premise as swarmReviewNotificationPoller.spec.ts.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSwarmNotifyDiag().lastActionable.length), {
        timeout: 40_000,
      })
      .toBeGreaterThan(0)
    expect(await page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds())).toEqual([])

    // Minimize: real Chromium throttling engages (1Hz timer alignment now,
    // intensive throttling later). The host poller is a Node process and never
    // throttled — its poke chain is what Phase 1 hardened.
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.minimize()
    })
    await swarm.addReview({ id: '2002', author: 'dave', description: 'Throttled window review' })

    // Give the throttled renderer a generous chance (15x the host interval) to
    // answer pokes on its own. Observation only — whether it manages depends on
    // how deep this environment throttles, and either outcome is legitimate.
    await page.waitForTimeout(15_000)

    // Restore the window. If the renderer was too frozen to answer mid-test,
    // the visibilitychange catch-up tick must detect the review immediately;
    // the notification MUST be observable now either way.
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.restore()
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds()), {
        timeout: 40_000,
      })
      .toEqual([['2002']])
  })
})
