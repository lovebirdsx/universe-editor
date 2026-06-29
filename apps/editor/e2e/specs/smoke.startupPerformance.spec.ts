/*---------------------------------------------------------------------------------------------
 *  Startup performance observability (@perf).
 *
 *  Records the aggregated startup timeline (main + renderer perf marks) into a
 *  JSON artifact so CI can track startup-phase durations over time. This is
 *  OBSERVE-ONLY: it never asserts a budget (cold-start timing on shared CI
 *  runners is too noisy for a hard gate). The artifact is uploaded by the e2e
 *  job; a future change can diff it against a baseline once we have signal.
 *
 *  Tagged @perf so it runs in its own non-blocking CI pass, separate from the
 *  @p0/@p1 functional gate. See apps/editor/e2e/RUNBOOK.md.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACT = join(__dirname, '..', 'test-results', 'startup-metrics.json')

test.describe('@perf startup performance', () => {
  test('records startup metrics artifact', async ({ page }, testInfo) => {
    await page.evaluate(() => window.__E2E__!.whenRestored())

    const metrics = await page.evaluate(() => window.__E2E__!.getStartupMetrics())

    // Sanity: a real startup always produces a positive total and some phases.
    expect(metrics.totalTime).toBeGreaterThan(0)
    expect(metrics.phases.length).toBeGreaterThan(0)
    for (const phase of metrics.phases) {
      expect(phase.duration).toBeGreaterThanOrEqual(0)
    }

    const payload = {
      totalTime: Math.round(metrics.totalTime),
      phases: metrics.phases.map((p) => ({
        label: p.label,
        from: p.from,
        to: p.to,
        duration: Math.round(p.duration),
      })),
    }

    // Attach to the Playwright report and write a stable file for CI to upload.
    await testInfo.attach('startup-metrics', {
      body: JSON.stringify(payload, null, 2),
      contentType: 'application/json',
    })
    mkdirSync(dirname(ARTIFACT), { recursive: true })
    writeFileSync(ARTIFACT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

    const table = payload.phases
      .map((p) => `  ${String(p.duration).padStart(6)}ms  ${p.from} → ${p.to}`)
      .join('\n')
    console.log(`[perf] startup total=${payload.totalTime}ms\n${table}`)
  })
})
