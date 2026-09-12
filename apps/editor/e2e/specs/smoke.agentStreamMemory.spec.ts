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

async function startEchoSession(page: Page): Promise<void> {
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
  // Drop whatever opening a session counted, so the reading below covers the stream.
  await page.evaluate(() => window.__E2E__!.getHeapFlowCounters())
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

/** Wait until the streamed thought has arrived in full on the view model. */
async function waitForThought(page: Page, expected: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window
            .__E2E__!.getAcpMessages()
            .filter((m) => m.role === 'thought')
            .reduce((sum, m) => sum + m.text.length, 0),
        ),
      { timeout: 30000 },
    )
    .toBe(expected.length)
}

/**
 * Wait until the thought message is marked streaming. The counters read next describe
 * a live stream — they are drained on every read, so time spent after the stream only
 * thins them out. The agent ends the turn (sealing the message) 500ms after the last
 * chunk, and `waitForThought` polls with the default intervals, up to 1s apart, so it
 * can report the text complete only after that hold has already expired; the flag is
 * the only signal that says the read below is still inside the stream.
 */
async function waitForStreaming(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__E2E__!.getAcpMessages().some((m) => m.role === 'thought' && m.streaming),
        ),
      { timeout: 20000 },
    )
    .toBe(true)
}

test.describe.configure({ mode: 'default' })

test.describe('@p1 acp streaming render accounting', () => {
  test('a sealable thought storm re-parses only its tail', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    await startEchoSession(page)

    const COUNT = 300
    const expected = thoughtText(COUNT, CHUNK, false)
    const running = drivePrompt(page, `emit-thought:${COUNT}x1`)

    // The echo agent holds the turn open briefly after the last chunk, and the wait
    // below pins the reading inside that window — the flow counters are drained per
    // read, so time spent after the stream would only thin them out.
    await waitForThought(page, expected)
    await waitForStreaming(page)
    const streaming = await page.evaluate(() => window.__E2E__!.getHeapFlowCounters())
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
    // The sealed cache really did fill. Read while streaming, this is the live value;
    // it also guards the seal path, where the parse cache holds the readings the gauge
    // reports — a static render reporting 0 would say nothing ever sealed.
    expect(gaugeOf(streaming, 'sealednodes')).toBeGreaterThan(0)
    // Nothing in this message is a fence, so nothing should have been tokenized.
    expect(flowOf(streaming, 'colorize').chars).toBe(0)
  })

  test('a fence that never closes is not tokenized while it streams', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await startEchoSession(page)

    // The fence opens on the first chunk and is never closed, so no blank line is ever
    // outside it: nothing seals and the whole message stays one growing tail. That is
    // the shape that made every batch re-tokenize the entire fence.
    const COUNT = 100
    const expected = thoughtText(COUNT, CHUNK, true)
    const running = drivePrompt(page, `emit-thought:${COUNT}x1,fence`)

    await waitForThought(page, expected)
    await waitForStreaming(page)
    const streaming = await page.evaluate(() => window.__E2E__!.getHeapFlowCounters())

    expect(flowOf(streaming, 'colorize').chars).toBe(0)
    expect(flowOf(streaming, 'colorize.skip').chars).toBeGreaterThan(0)

    await running
    // Sealing ends the deferral: the fence is tokenized as usual once the message is
    // done, so this is a streaming-time gate and not a permanent loss of highlighting.
    await expect
      .poll(
        async () =>
          flowOf(await page.evaluate(() => window.__E2E__!.getHeapFlowCounters()), 'colorize')
            .calls,
        { timeout: 30000 },
      )
      .toBeGreaterThan(0)

    const finalText = await page.evaluate(
      () => window.__E2E__!.getAcpMessages().find((m) => m.role === 'thought')?.text ?? '',
    )
    expect(finalText).toBe(expected)
  })
})
