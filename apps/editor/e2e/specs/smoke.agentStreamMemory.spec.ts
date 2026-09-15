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

/** Mirrors `echoAgent.cjs`'s chunk body, shared by `emit-thought` and `subagentChunk`. */
function streamedText(count: number, chunkSize: number, fenced: boolean): string {
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

/**
 * Open a session and return the counter baseline the stream will be measured against.
 *
 * `collapseMode` is applied before the baseline is taken: switching modes re-renders the
 * timeline, and that render would otherwise land in the measured interval. A sub-agent
 * message only reaches a view when its parent card is open, so the sub-agent cases need
 * `'expanded'` — under the default mode a Task card starts folded and renders nothing.
 */
async function startEchoSession(
  page: Page,
  collapseMode?: 'default' | 'collapsed' | 'expanded',
): Promise<StreamCounters> {
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
  if (collapseMode !== undefined) {
    await page.evaluate((mode) => window.__E2E__!.setAcpCollapseMode(mode), collapseMode)
  }
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

/** Child messages folded under the active session's cards, as the timeline holds them. */
function subagentChildren(
  page: Page,
): Promise<ReadonlyArray<{ id: string; textLength: number; live?: boolean }>> {
  return page.evaluate(() =>
    window
      .__E2E__!.getAcpToolCalls()
      .flatMap((call) => call.children ?? [])
      .filter((child) => child.kind === 'message'),
  )
}

type AcpChildSnapshot = ReadonlyArray<{
  id: string
  kind: string
  textLength: number
  live?: boolean
}>

/**
 * The children view of an `emit-subagent-mixed` run, taken at the last moment the turn
 * is still running.
 *
 * Reading it after the turn would prove nothing: `_flushStream` seals every child
 * message there, so a seal that never happened and one that did look exactly alike.
 * The fixture holds the turn open 500ms after its trailing tool call, and that hold is
 * the window this reads.
 */
async function sampleMixedRun(page: Page): Promise<AcpChildSnapshot> {
  const deadline = Date.now() + 30000
  let last: AcpChildSnapshot | undefined
  for (;;) {
    const batch = await page.evaluate(() => {
      // One evaluate on purpose: the snapshot and the turn state have to describe the
      // same instant.
      return {
        status: window.__E2E__!.getAcpSessionStatus(),
        children: window.__E2E__!.getAcpToolCalls().flatMap((call) => call.children ?? []),
      }
    })
    if (batch.children.filter((child) => child.kind === 'toolCall').length === 2) {
      if (batch.status === 'idle') {
        if (last) return last
      } else {
        last = batch.children
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no mixed sub-agent run observed: ${JSON.stringify(last ?? batch.children)}`)
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS)
  }
}

/**
 * The sub-agent counterpart of {@link measureStream}: same shape, but the growing
 * message lives under a parent tool card rather than in `_messages`, so both the
 * liveness flag and the text length come from the children snapshot.
 */
async function measureSubagentStream(
  page: Page,
  baseline: StreamCounters,
  expectedLength: number,
): Promise<StreamCounters> {
  const deadline = Date.now() + 30000
  let lastLive: StreamCounters | undefined

  for (;;) {
    const batch = await page.evaluate(() => {
      // One evaluate on purpose — see measureStream.
      const counters = window.__E2E__!.getHeapFlowCounters()
      const children = window
        .__E2E__!.getAcpToolCalls()
        .flatMap((call) => call.children ?? [])
        .filter((child) => child.kind === 'message')
      return {
        flow: counters.flow,
        gauge: counters.gauge,
        live: children.some((child) => child.live === true),
        length: children.reduce((sum, child) => sum + child.textLength, 0),
      }
    })

    if (batch.live) lastLive = { flow: batch.flow, gauge: batch.gauge }
    else if (batch.length >= expectedLength && lastLive) return diff(baseline, lastLive)

    if (Date.now() > deadline) {
      throw new Error(
        `no sealed reading for a complete sub-agent message: ${batch.length}/${expectedLength} chars, ` +
          `live=${batch.live}, sawLive=${lastLive !== undefined}`,
      )
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS)
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
    const expected = streamedText(COUNT, CHUNK, false)
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
    const expected = streamedText(COUNT, CHUNK, true)
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

/**
 * The sub-agent counterpart of the block above.
 *
 * A sub-agent message lives on its parent card's children list, not in `_messages`, so
 * the top-level seal/flush machinery never saw it: it was built with `streaming: false`
 * (a full static re-parse per batch, with every code fence re-tokenized on every frame)
 * and `_appendChildChunk` opened its batch with no length, so the deadline stayed at
 * 16ms however long the message grew. These cases pin the three gaps shut.
 */
test.describe('@p1 acp sub-agent streaming render accounting', () => {
  test('a sub-agent storm re-parses only its tail and batches its publishes', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    // A Task card starts folded, and a folded card renders no message at all — which is
    // exactly why this path's cost only appears once the user opens one.
    const baseline = await startEchoSession(page, 'expanded')

    const COUNT = 300
    const expected = streamedText(COUNT, CHUNK, false)
    const running = drivePrompt(page, `emit-subagent:${COUNT}x1`)

    const streaming = await measureSubagentStream(page, baseline, expected.length)
    await running

    // Content first: deferring work must never drop text.
    const children = await subagentChildren(page)
    expect(children.reduce((sum, child) => sum + child.textLength, 0)).toBe(expected.length)

    const mdparse = flowOf(streaming, 'mdparse')
    expect(mdparse.calls).toBeGreaterThan(1)
    // Same bound as the top-level case: with a working split every character is parsed
    // about once, plus the open tail once per render. Without one, every render re-parses
    // everything seen so far and the total scales with (renders × length).
    expect(mdparse.chars, JSON.stringify(mdparse)).toBeLessThan(
      expected.length + 16 * CHUNK * mdparse.calls,
    )
    expect(gaugeOf(streaming, 'sealednodes')).toBeGreaterThan(0)
    // Nothing here is a fence, so nothing should have been tokenized.
    expect(flowOf(streaming, 'colorize').chars).toBe(0)

    // Publishes coalesce into batch windows — one per chunk would mean the child batch
    // deadline did nothing. `chars` sums the *cumulative* length at each publish, so it
    // can only ever exceed the stream's own length.
    const childchunks = flowOf(streaming, 'childchunks')
    expect(childchunks.calls).toBeGreaterThan(1)
    expect(childchunks.calls).toBeLessThan(COUNT)
    expect(childchunks.chars).toBeGreaterThanOrEqual(expected.length)
  })

  test('a sub-agent turn ends with its message sealed and its fences coloured', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    const baseline = await startEchoSession(page, 'expanded')

    // A fence that never closes: deferred while it streams, tokenized once it seals.
    const COUNT = 6
    const expected = streamedText(COUNT, CHUNK, true)
    const running = drivePrompt(page, `emit-subagent:${COUNT}x1,fence`)

    // Streaming-time deferral — the reading that has to be taken while the message is
    // still growing, since sealing is what ends it.
    const streaming = await measureSubagentStream(page, baseline, expected.length)
    expect(flowOf(streaming, 'colorize').chars).toBe(0)
    expect(flowOf(streaming, 'colorize.skip').chars).toBeGreaterThan(0)
    await running

    // Sealing is what clears `live`, and the turn's end is the only signal a child run
    // gets. One that kept the flag would re-parse its tail on every batch forever and
    // never highlight again — and, because `live` gates the fence deferral too, this
    // very fence would stay uncoloured for the life of the session.
    await expect
      .poll(async () => (await subagentChildren(page)).every((child) => child.live === false), {
        timeout: 30000,
      })
      .toBe(true)

    const children = await subagentChildren(page)
    expect(children.length).toBeGreaterThan(0)
    expect(children.reduce((sum, child) => sum + child.textLength, 0)).toBe(expected.length)

    // A streaming-time gate, not a permanent loss of highlighting. Counted from the same
    // baseline — streaming-time colorize was just asserted to be zero.
    await expect
      .poll(
        async () => {
          const now = await page.evaluate(() => window.__E2E__!.getHeapFlowCounters())
          return flowOf(diff(baseline, now), 'colorize').calls
        },
        { timeout: 30000 },
      )
      .toBeGreaterThan(0)
  })

  test('a child tool call closing a sub-agent run ends the message it interrupts', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await startEchoSession(page, 'expanded')

    const COUNT = 60
    const expected = streamedText(COUNT, CHUNK, false)
    const running = drivePrompt(page, `emit-subagent-mixed:${COUNT}x1`)

    const children = await sampleMixedRun(page)
    await running

    const messages = children.filter((child) => child.kind === 'message')
    expect(children.filter((child) => child.kind === 'toolCall')).toHaveLength(2)
    expect(messages).toHaveLength(2)
    // The trailing tool call is what isolates the seal: the run closes with a tool
    // call rather than more text, and a chunk merges only into a message that is still
    // last under its parent, so nothing else can end this message before the turn
    // does. Miss the seal and it stays "growing" for the life of the session — its
    // tail re-parsed every batch, its fences never coloured again, and no error.
    expect(messages[1]!.live, JSON.stringify(children)).toBe(false)
    // The first message ends on the same mechanism one interruption earlier; it is
    // listed only because it must not be the one carrying the assertion.
    expect(messages[0]!.live).toBe(false)

    // Read after the turn, not from the snapshot above: that one is taken mid-stream
    // and is therefore short. Sealing preserves the text, so the split — which must
    // have cost neither message any of it — can still be checked here.
    const settled = await subagentChildren(page)
    expect(settled.reduce((sum, message) => sum + message.textLength, 0)).toBe(expected.length)
  })

  test('a folded sub-agent card renders nothing at all', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const baseline = await startEchoSession(page, 'collapsed')

    const COUNT = 40
    await drivePrompt(page, `emit-subagent:${COUNT}x1`)

    // Folding is a render-time decision, not an ingest one: the chunks still reach the
    // model in full even though no view ever parsed them.
    await expect
      .poll(async () => (await subagentChildren(page)).reduce((sum, c) => sum + c.textLength, 0), {
        timeout: 30000,
      })
      .toBe(COUNT * CHUNK)

    const now = await page.evaluate(() => window.__E2E__!.getHeapFlowCounters())
    const mdparse = flowOf(diff(baseline, now), 'mdparse')
    expect(mdparse.chars, JSON.stringify(mdparse)).toBeLessThan(COUNT * CHUNK)
  })
})
