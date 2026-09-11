/*---------------------------------------------------------------------------------------------
 *  Renderer memory watermark smoke (P0).
 *
 *  The watermark exists because a shipped renderer built ~3.8GB of live heap with
 *  nothing in the process watching — the sampling that did exist lived in main and could
 *  not see the renderer's heap at all, so the last 20-40 seconds before the abort left
 *  no trace. Every part of that fix rests on assumptions only a real Electron renderer
 *  can confirm:
 *
 *    - `performance.memory` is actually readable there (if it is not, the sampler is
 *      blind and the service silently reports nothing — the exact failure it was built
 *      to prevent, one layer up)
 *    - the caches registered themselves as releasers, and releasing returns a real byte
 *      count rather than a plausible-looking zero
 *    - the thresholds derived from the real heap limit sit under it
 *
 *  `describe()` and the byte readings are what the spec asserts on, not internals.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

test.describe('@p0 renderer memory pressure', () => {
  test('reads the renderer heap — performance.memory is available', async ({ page }) => {
    const snapshot = await page.evaluate(() => window.__E2E__!.getMemoryPressure())

    // Null here would mean the watermark can never fire, which is strictly worse than
    // no watermark: it would look installed in every log and do nothing.
    expect(snapshot.usedBytes).not.toBeNull()
    expect(snapshot.limitBytes).not.toBeNull()
    expect(snapshot.usedBytes!).toBeGreaterThan(0)
    expect(snapshot.limitBytes!).toBeGreaterThan(snapshot.usedBytes!)
  })

  test('a fresh workbench is not under pressure', async ({ page }) => {
    const snapshot = await page.evaluate(() => window.__E2E__!.getMemoryPressure())
    expect(snapshot.level).toBe('normal')
    expect(snapshot.describe).toContain('memory normal')
  })

  test('the memory-holding caches registered themselves as releasers', async ({ page }) => {
    const snapshot = await page.evaluate(() => window.__E2E__!.getMemoryPressure())
    // Each of these holds whole-file text or base64 images. A cache missing from this
    // list is a cache that cannot be given back when the heap is running out.
    expect(snapshot.releaserIds).toEqual(
      expect.arrayContaining([
        'acp.promptDrafts',
        'acp.cancelledDrafts',
        'acp.mentionFileListing',
        'acp.residentBudget',
      ]),
    )
  })

  test('a forced critical release is safe and accounts for what it freed', async ({ page }) => {
    const snapshot = await page.evaluate(() => window.__E2E__!.getMemoryPressure('critical'))

    // A releaser that throws under memory pressure is a bug the report has to name —
    // silently returning zero would look identical to "nothing to give back".
    expect(snapshot.release.filter((entry) => entry.error !== undefined)).toEqual([])
    expect(snapshot.releasedBytes).toBe(
      snapshot.release.reduce((sum, entry) => sum + entry.freed, 0),
    )
    for (const entry of snapshot.release) {
      // A releaser that ran and freed nothing is omitted from the report entirely, so
      // anything present has to be carrying real bytes.
      expect(entry.freed).toBeGreaterThan(0)
    }
  })

  test('releasing is safe to repeat and leaves the workbench serving requests', async ({
    page,
  }) => {
    await page.evaluate(() => window.__E2E__!.getMemoryPressure('critical'))
    const after = await page.evaluate(() => window.__E2E__!.getMemoryPressure('critical'))
    expect(after.releasedBytes).toBeGreaterThanOrEqual(0)

    // The probe still answers, i.e. the release did not wedge the renderer.
    const phase = await page.evaluate(() => window.__E2E__!.getLifecyclePhase())
    expect(['Ready', 'Restored', 'Eventually']).toContain(phase)
  })
})
