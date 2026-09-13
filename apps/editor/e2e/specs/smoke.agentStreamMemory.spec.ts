/*---------------------------------------------------------------------------------------------
 *  ACP streaming render accounting (@p1).
 *
 *  Guard for the 2026-09-12 renderer blow-up. A thought storm — thousands of
 *  `agent_thought_chunk` updates landing on one message — took a renderer window from
 *  1195MB to 2300MB working set in 35 seconds, roughly 800MB of it outside the V8 heap.
 *  The mechanism was per-batch full re-rendering of the whole message, and the largest
 *  single cost in it was Monaco re-tokenizing every code fence on every frame (the
 *  tokenized HTML runs 5-10x the source).
 *
 *  Deliberately no wall-clock or megabyte assertions: those are properties of the
 *  machine. What is asserted here is algorithm-shaped — how much of the message a
 *  stream re-parses, and whether a fence that is still growing gets tokenized at all.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const CHUNK = 1024

/** Mirrors `echoAgent.cjs`'s `emit-thought` body — the text the agent will stream. */
function thoughtText(count: number, chunkSize: number, fenced: boolean): string {
  let out = ''
  for (let i = 0; i < count; i++) {
    const marker = `L${i} `
    if (fenced) {
      const head = i === 0 ? '```ts\n' : ''
      out += head + marker + 'x'.repeat(chunkSize - head.length - marker.length - 1) + '\n'
    } else {
      const tail = i % 5 === 4 ? '\n\n' : '\n'
      out += marker + 'a'.repeat(chunkSize - marker.length - tail.length) + tail
    }
  }
  return out
}

interface StreamCounters {
  flow: ReadonlyArray<{ name: string; calls: number; chars: number }>
  gauge: ReadonlyArray<{ name: string; value: number }>
}

const flowOf = (counters: StreamCounters, name: string): { calls: number; chars: number } =>
  counters.flow.find((f) => f.name === name) ?? { calls: 0, chars: 0 }

const gaugeOf = (counters: StreamCounters, name: string): number =>
  counters.gauge.find((g) => g.name === name)?.value ?? 0

/** Open a session and return the counter baseline the stream will be measured against. */
async function startEchoSession(page: Page): Promise<StreamCounters> {
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 20000 })
    .toBe('idle')
  // Baseline, not a reset: the counters are process totals, so opening a session is
  // excluded by differencing rather than by clearing shared state.
  return await page.evaluate(() => window.__E2E__!.getHeapFlowCounters())
}

/**
 * Fire the prompt without awaiting it yet: the echo agent keeps the turn open briefly
 * after the last chunk, and that window is where the counters are read. The rejection
 * is swallowed up front so that a failed assertion inside the window surfaces as itself
 * instead of as a teardown "page closed" error from the abandoned promise.
 */
function drivePrompt(page: Page, text: string): Promise<void> {
  const running = page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), text)
  void running.catch(() => {})
  return running
}

/** Poll interval while the stream runs; the agent's post-chunk hold is 500ms. */
const SAMPLE_INTERVAL_MS = 20

/**
 * Work the stream did, as the difference between two process totals.
 *
 * The counters are process totals (see `E2EHeapFlowCounters.flow`), so this is immune to
 * the heap sampler draining its own view of them every 5 seconds. What still matters is
 * *when* the closing reading is taken: the agent ends the turn 500ms after the last
 * chunk, and sealing the message triggers the deferred work these tests assert is absent
 * during streaming. So the closing reading is the last one observed while the message was
 * still marked streaming — polled, rather than taken once after the text arrives, because
 * the 500ms hold can expire before a single post-hoc read lands (that is what timed out on
 * CI). Gauges are absolute, so their streaming-time peak is what the assertions describe.
 */
async function measureStream(
  page: Page,
  baseline: StreamCounters,
  expectedLength: number,
): Promise<StreamCounters> {
  const deadline = Date.now() + 30000
  let lastStreaming: StreamCounters | undefined

  for (;;) {
    const batch = await page.evaluate(() => {
      // One evaluate on purpose: the reading and the flag it gets attributed to have to
      // describe the same instant.
      const counters = window.__E2E__!.getHeapFlowCounters()
      const thoughts = window.__E2E__!.getAcpMessages().filter((m) => m.role === 'thought')
      return {
        flow: counters.flow,
        gauge: counters.gauge,
        streaming: thoughts.some((m) => m.streaming),
        length: thoughts.reduce((sum, m) => sum + m.text.length, 0),
      }
    })

    if (batch.streaming) lastStreaming = { flow: batch.flow, gauge: batch.gauge }
    else if (batch.length >= expectedLength && lastStreaming) return diff(baseline, lastStreaming)

    if (Date.now() > deadline) {
      throw new Error(
        `no sealed reading for a complete thought: ${batch.length}/${expectedLength} chars, ` +
          `streaming=${batch.streaming}, sawStreaming=${lastStreaming !== undefined}`,
      )
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS)
  }
}

/** Flow as `after - before`; gauges pass through (absolute, not accumulated). */
function diff(before: StreamCounters, after: StreamCounters): StreamCounters {
  return {
    flow: after.flow.map((entry) => {
      const start = flowOf(before, entry.name)
      return {
        name: entry.name,
        calls: entry.calls - start.calls,
        chars: entry.chars - start.chars,
      }
    }),
    gauge: after.gauge,
  }
}

// Serial within the file (both tests drive the same shared echo agent), and each streams
// hundreds of chunks while polling — past the 30s suite default on a 2-core runner.
test.describe.configure({ mode: 'default', timeout: 90000 })

test.describe('@p1 acp streaming render accounting', () => {
  test('a sealable thought storm re-parses only its tail', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const baseline = await startEchoSession(page)

    const COUNT = 300
    const expected = thoughtText(COUNT, CHUNK, false)
    const running = drivePrompt(page, `emit-thought:${COUNT}x1`)

    const streaming = await measureStream(page, baseline, expected.length)
    await running

    // Content first: deferring work must never drop text.
    const finalText = await page.evaluate(
      () => window.__E2E__!.getAcpMessages().find((m) => m.role === 'thought')?.text ?? '',
    )
    expect(finalText).toBe(expected)

    const mdparse = flowOf(streaming, 'mdparse')
    expect(mdparse.calls).toBeGreaterThan(1)
    // Sealing means every character is parsed about once over the whole stream, plus
    // the still-open tail once per render — and this message's tail is bounded by the
    // blank line the fixture emits every 5 chunks. Without a working split every render
    // re-parses everything seen so far, so the total scales with (renders × length)
    // instead of staying flat, and no plausible render count keeps it under this bound.
    expect(mdparse.chars, JSON.stringify(mdparse)).toBeLessThan(
      expected.length + 16 * CHUNK * mdparse.calls,
    )
    // The sealed cache really did fill: this is the peak the gauge reached while the
    // message streamed, so a message whose split never found a boundary — nothing ever
    // sealed — reports 0 here no matter what the final static render says.
    expect(gaugeOf(streaming, 'sealednodes')).toBeGreaterThan(0)
    // Nothing in this message is a fence, so nothing should have been tokenized.
    expect(flowOf(streaming, 'colorize').chars).toBe(0)
  })

  test('a fence that never closes is not tokenized while it streams', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    const baseline = await startEchoSession(page)

    // The fence opens on the first chunk and is never closed, so no blank line is ever
    // outside it: nothing seals and the whole message stays one growing tail. That is
    // the shape that made every batch re-tokenize the entire fence.
    const COUNT = 100
    const expected = thoughtText(COUNT, CHUNK, true)
    const running = drivePrompt(page, `emit-thought:${COUNT}x1,fence`)

    const streaming = await measureStream(page, baseline, expected.length)

    expect(flowOf(streaming, 'colorize').chars).toBe(0)
    expect(flowOf(streaming, 'colorize.skip').chars).toBeGreaterThan(0)

    await running
    // Sealing ends the deferral: the fence is tokenized as usual once the message is
    // done, so this is a streaming-time gate and not a permanent loss of highlighting.
    // Counted from the same baseline — streaming-time colorize was just asserted to be
    // zero, so anything that shows up here happened after the seal.
    await expect
      .poll(
        async () => {
          const now = await page.evaluate(() => window.__E2E__!.getHeapFlowCounters())
          return flowOf(diff(baseline, now), 'colorize').calls
        },
        { timeout: 30000 },
      )
      .toBeGreaterThan(0)

    const finalText = await page.evaluate(
      () => window.__E2E__!.getAcpMessages().find((m) => m.role === 'thought')?.text ?? '',
    )
    expect(finalText).toBe(expected)
  })
})
