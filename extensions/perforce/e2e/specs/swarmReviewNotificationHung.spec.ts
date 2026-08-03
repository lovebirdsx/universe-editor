/*---------------------------------------------------------------------------------------------
 *  Swarm poll wedge regression — end-to-end over the fake Swarm server.
 *  Reproduces the user report that NO new-review notification ever fires (foreground
 *  included) even with `perforce.swarm.backgroundPoll.enabled: true`, after the
 *  401-modal fix (19e46f6a) landed: SwarmApi issues fetch() with NO timeout, so a
 *  gateway that accepts the connection but stalls (the deployment fronts Swarm with
 *  a gateway that already 504s slow endpoints) wedges one poll's dashboard fetch —
 *  undici's ~300s headersTimeout means the renderer's serialized refresh() latch
 *  (`_running`) stays true for minutes per poll, and every later tick is dropped at
 *  `if (this._running) return`. The sidebar keeps working (its dashboard call uses a
 *  different in-flight key), so the poll alone goes silently dead.
 *
 *  The fake server hangs GET /reviews while `setHang(true)`, then answers again.
 *  The poll that started during the hang must time out and settle (not wedge the
 *  latch), so a review added after the hang still notifies. Pre-fix this times out:
 *  the wedged latch drops every tick.
 *--------------------------------------------------------------------------------------------*/

import { evaluateWhenRestored } from '@universe-editor/e2e-harness'
import { expect, test } from '../fixtures/swarmApp.js'

// The extension under test reads UNIVERSE_SWARM_REQUEST_TIMEOUT_MS (added with the
// fix); 3s keeps a hung request recoverable within a poll cycle. The poll-interval
// env override runs the host poller below the product 10s floor (still 60x faster
// than the renderer's 60s backstop) so the wedged cycles take seconds, not 22s.
test.describe('@p1 swarm poll survives a hung request', () => {
  test.use({
    swarmExtraSettings: {
      'perforce.swarm.pollInterval': 10,
      'perforce.swarm.backgroundPoll.enabled': true,
    },
    swarmExtraEnv: {
      UNIVERSE_SWARM_REQUEST_TIMEOUT_MS: '3000',
      UNIVERSE_SWARM_POLL_INTERVAL_MS: '1000',
    },
  })

  test('a poll wedged by a hung gateway recovers and notifies about the next new review', async ({
    page,
    swarm,
  }) => {
    // Prime (≤40s) + wedged poll cycles (5s) + recovery window (60s) far
    // exceed the harness's 30s default test timeout.
    test.setTimeout(150_000)
    await evaluateWhenRestored(page)

    // Baseline prime off the host poller (no probe-driven polls).
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSwarmNotifyDiag().lastActionable.length), {
        timeout: 40_000,
      })
      .toBeGreaterThan(0)
    expect(await page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds())).toEqual([])

    // The gateway wedges: the next poll's dashboard fetch hangs mid-flight. At 1s
    // ticks + a 3s request timeout, 5s spans a full wedge cycle (fetch hung →
    // timed out → latch released) and starts the next — a poll is definitely stuck.
    await swarm.setHang(true)
    await page.waitForTimeout(5_000)

    // The gateway answers again and a brand-new review lands. Pre-fix the wedged
    // poll holds the renderer's refresh latch for ~300s (undici headersTimeout),
    // so every tick in this window is dropped and #2001 never notifies.
    await swarm.setHang(false)
    await swarm.addReview({ id: '2001', author: 'dave', description: 'Urgent hotfix' })

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getSwarmNotifiedReviewIds()), {
        timeout: 60_000,
      })
      .toContainEqual(expect.arrayContaining(['2001']))
  })
})
