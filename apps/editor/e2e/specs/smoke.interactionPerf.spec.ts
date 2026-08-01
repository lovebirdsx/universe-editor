/*---------------------------------------------------------------------------------------------
 *  Interaction responsiveness floor smoke.
 *
 *  A trusted key press landing inside a busy main thread must be recorded as
 *  a slow interaction by the always-on Event Timing monitor. Asserts through
 *  the probe summary (not the log file) to stay independent of logger flush
 *  timing. Not @p0 — the floor is observability, not a functional gate.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '../fixtures/sharedApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

test.describe('interaction perf monitoring', () => {
  test('records a slow interaction when a trusted key lands in a busy main thread', async ({
    page,
  }) => {
    await evaluateWhenRestored(page)

    // Schedule the busy-wait so the trusted key press lands inside it: the
    // event's dispatch waits on the blocked main thread, pushing its Event
    // Timing input delay past the warn threshold. The busy-wait must start
    // AFTER the press is dispatched (setTimeout), otherwise the CDP call
    // itself would block before the input ever reaches the renderer.
    await page.evaluate(() => {
      setTimeout(() => {
        const busyEnd = performance.now() + 400
        while (performance.now() < busyEnd) {
          /* busy */
        }
      }, 50)
    })
    await page.keyboard.press('a')

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getInteractionPerfSummary().slowCount), {
        timeout: 5000,
      })
      .toBeGreaterThanOrEqual(1)

    const summary = await page.evaluate(() => window.__E2E__!.getInteractionPerfSummary())
    expect(summary.interactionCount).toBeGreaterThan(0)
    // The slow interaction must carry its real event name — a mapping slip that
    // turns every type into "undefined" would still satisfy slowCount above.
    expect(Object.keys(summary.byType)).toContain('keydown')
  })
})
