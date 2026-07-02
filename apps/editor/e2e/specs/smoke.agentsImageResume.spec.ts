/*---------------------------------------------------------------------------------------------
 *  ACP image resume freeze regression (@p1).
 *
 *  Repro for "restoring / receiving a session with images freezes the editor".
 *  Root cause: the always-on protocol tracer (acpProtocolTracer) reassembled
 *  every stdout line by re-scanning the whole accumulated buffer from the head on
 *  each ~64KB chunk (O(m²) in the line length) and then JSON.parse'd the entire
 *  multi-MB base64 image line — all synchronously on the renderer main thread.
 *  A session/load replaying several stored images (each a full-base64 stdout
 *  line) piled these up and froze the UI.
 *
 *  We drive the same stdout path directly: the echo agent streams several
 *  multi-MB `image` chunks (directive "emit-image:<count>x<kb>"). On the old
 *  tracer the main thread stalls for seconds and this test's responsiveness
 *  probe (a timed round-trip through the renderer) blows past its budget; with
 *  the fix the images arrive and the renderer stays responsive.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

// 6 images × 2MB base64 = 12MB of stdout. On the O(m²) tracer this scanned
// hundreds of MB and parsed 12MB of base64 on the main thread — seconds of
// freeze. With the fix each oversized line is elided without parsing.
const IMAGE_COUNT = 24
const IMAGE_KB = 3072

test.describe('@p1 agents image resume', () => {
  test('receiving many multi-MB image chunks does not freeze the renderer', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)

    // Fire the image storm without awaiting the turn: we want to observe the
    // renderer *while* the large stdout lines are being ingested by the tracer.
    await page.evaluate(
      ([count, kb]) => {
        void window.__E2E__!.sendAcpPrompt(`emit-image:${count}x${kb}`)
      },
      [IMAGE_COUNT, IMAGE_KB] as const,
    )

    // Responsiveness probe: a trivial round-trip through the renderer must keep
    // returning quickly. If the main thread is frozen serializing base64 in the
    // tracer, this evaluate() queues behind it and the measured latency spikes.
    // Tight loop (no sleep) so a probe reliably lands inside the ingest window.
    let worstLatency = 0
    for (let i = 0; i < 120; i++) {
      const start = Date.now()
      await page.evaluate(() => window.__E2E__!.getAcpSessionCount())
      worstLatency = Math.max(worstLatency, Date.now() - start)
    }
    console.log(`[image-resume] worst evaluate latency = ${worstLatency}ms`)

    // All image messages must actually land (proves the payloads flowed through,
    // not that we simply dropped them somewhere upstream).
    await expect
      .poll(
        () =>
          page.evaluate(
            () => window.__E2E__!.getAcpMessages().filter((m) => m.role === 'agent').length,
          ),
        { timeout: 10000 },
      )
      .toBeGreaterThanOrEqual(1)

    // A frozen main thread parks page.evaluate for seconds; a responsive one
    // answers in well under a second even under the ingest load.
    expect(worstLatency).toBeLessThan(2000)
  })
})
