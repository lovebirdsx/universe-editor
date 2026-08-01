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

    // Block the main thread FIRST, then press: console output flushes over the
    // IO thread, so the token reaches Playwright while the renderer is already
    // spinning. The trusted key then queues behind the busy loop and its Event
    // Timing input delay clears the warn threshold deterministically. (The
    // previous shape — press, then setTimeout(busy, 50) — raced the CDP input
    // dispatch against the 50ms lead and flaked ~50% locally.)
    const blockToken = 'E2E_INTERACTION_PERF_BLOCKING'
    const evaluated = page.evaluate((token) => {
      console.log(token)
      const busyEnd = performance.now() + 800
      while (performance.now() < busyEnd) {
        /* busy */
      }
    }, blockToken)
    await page.waitForEvent('console', {
      predicate: (msg) => msg.text() === blockToken,
      timeout: 5000,
    })
    await page.keyboard.press('a')
    await evaluated

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getInteractionPerfSummary().slowCount), {
        timeout: 5000,
      })
      .toBeGreaterThanOrEqual(1)

    const summary = await page.evaluate(() => window.__E2E__!.getInteractionPerfSummary())
    expect(summary.interactionCount).toBeGreaterThan(0)
    // The slow interaction must carry its real event name — a mapping slip that
    // turns every type into "undefined" would still satisfy slowCount above.
    // Dedup keeps only the slowest sample per interaction id, so one key press
    // contributes exactly one of keydown/keyup to byType — assert keyboard,
    // not keydown specifically.
    expect(Object.keys(summary.byType).some((t) => t.startsWith('key'))).toBe(true)
  })
})
