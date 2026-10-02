/*---------------------------------------------------------------------------------------------
 *  Attributable large-inbound-frame log smoke.
 *
 *  `recordInboundDecode` (renderer/ipc/bootstrap.ts) exists because the incident that
 *  motivated the frame work sat at ~18.5MiB — under the frame guard's 32MiB warn line —
 *  so nothing in the logs could name the payload whose decode cost the stall. It warns
 *  for every inbound frame at or above LARGE_FRAME_LOG_BYTES (4MiB), naming the frame
 *  target, and rate-limits repeats per target.
 *
 *  Only a real main→renderer frame can pin this end to end, so the test reads a
 *  synthetic 5MiB file through the renderer's IFileService proxy (the same guarded
 *  channel every file read rides) and asserts the warn line shows up in the aggregated
 *  log channel with its target — the log the crash report is read for.
 *
 *  @p1 — the frame's size is the subject, so this test intentionally moves ~5MiB
 *  across the bridge; the assertion is on the attribution, not on timing.
 *--------------------------------------------------------------------------------------------*/

import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { test, expect } from '../fixtures/sharedApp.js'

const FRAME_BYTES = 5 * 1024 * 1024
/** The channel name the frame target carries (ServiceChannels.FileSystem). */
const FRAME_TARGET = '(response fileSystem.readFileText #'

/** The line, or '' while it has not been written yet. */
function largeFrameLine(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window.__E2E__!.getOutputChannelContent('All').split('\n').find((l) =>
      l.includes('large inbound ipc frame'),
    ) ?? ''),
  )
}

test.describe('@p1 ipc frame attribution', () => {
  test('a ≥4MiB inbound frame is logged with its target', async ({ page, workbench }) => {
    await workbench.waitForRestored()

    // Negative control: the aggregated channel is built per window and only carries
    // what this renderer logged, so an empty search here means any line found below
    // was produced by this test's frame.
    expect(await largeFrameLine(page)).toBe('')

    const dir = mkTempDir('universe-editor-frame-log-')
    const file = join(dir, 'large.txt')
    writeFileSync(file, 'a'.repeat(FRAME_BYTES))
    try {
      const length = await page.evaluate(
        (uri) => window.__E2E__!.readFileText(uri).then((text) => text.length),
        pathToFileURL(file).href,
      )
      expect(length).toBe(FRAME_BYTES)

      // The write is renderer → main (log file) → onDidAppendEntry → the "All"
      // channel, so this is a poll, not an immediate read.
      await expect
        .poll(() => largeFrameLine(page), { timeout: 20_000, intervals: [250, 500] })
        .toContain(FRAME_TARGET)

      const line = await largeFrameLine(page)
      // The size proves the 4MiB floor was crossed by the payload itself (5MiB of
      // ASCII ≈ 5.0MB on the wire), not by an unrelated envelope.
      expect(line).toContain('5.0MB')
      // The decode cost rides the same line: this is the number that attributes the
      // stall after the fact.
      expect(line).toMatch(/decode \d+\.\dms/)
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        /* best-effort */
      }
    }
  })
})
