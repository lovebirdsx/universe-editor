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

import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkTempDir } from '@universe-editor/e2e-harness'
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
 * 渲染侧证据：文本到模型不代表 React 已挂载，放行前必须看到渲染器处理过这段文本。
 * 读数都是进程累计量，一律按基线差值算。
 */
type RenderEvidence = 'mdparse' | 'colorize.skip'

/** 计数器自基线以来的增长量。 */
function grewBy(baseline: StreamCounters, batch: StreamCounters, name: string): number {
  return flowOf(batch, name).chars - flowOf(baseline, name).chars
}

// 累计解析量只作渲染就绪下限（可能重复解析尾部）；文本完整性由模型长度和最终断言另守。
// 围栏还必须有流式延迟着色的记录，不能把「尚未挂载」当作「没有着色」。
function hasRenderEvidence(
  baseline: StreamCounters,
  batch: StreamCounters,
  expectedLength: number,
  evidence: RenderEvidence,
): boolean {
  return evidence === 'mdparse'
    ? grewBy(baseline, batch, 'mdparse') >= expectedLength
    : grewBy(baseline, batch, 'colorize.skip') > 0
}

/**
 * Open a session and return the counter baseline the stream will be measured against.
 *
 * `collapseMode` is applied before the baseline is taken: switching modes re-renders the
 * timeline, and that render would otherwise land in the measured interval. A sub-agent
 * message only reaches a view when its parent card is open — and no collapse mode opens a
 * Task card any more (at most one sub-agent card may be open, and it is opened by hand),
 * so the sub-agent cases pair this with {@link openSubagentCard}.
 *
 * `echoAgentEnv` 透传给 fixture 进程，见 {@link makeTurnEndGate}。
 */
async function startEchoSession(
  page: Page,
  collapseMode?: 'default' | 'collapsed' | 'expanded',
  echoAgentEnv?: Record<string, string>,
): Promise<StreamCounters> {
  await page.evaluate(([id, p, env]) => window.__E2E__!.installAcpEchoAgent(id, p, env), [
    'echo',
    ECHO_AGENT_PATH,
    echoAgentEnv,
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
 * turn-end gate：fixture 撑住 turn 直到放行文件出现，读数因此按 spec 的节奏取。
 */
interface TurnEndGate {
  /** 经 installAcpEchoAgent 透传给 fixture 进程。 */
  readonly env: Record<string, string>
  /** 幂等：释放末块门，fixture 结束真实 turn。 */
  release(): void
  /** 幂等：释放首块门，仅子代理用例有（卡片得在流还短时点开）。 */
  resume?(): void
}

/**
 * 放行文件此刻不存在——mkTempDir 只建目录，文件由 release/resume 创建，run 根统一清理。
 * `subagent` 再加一道首块门：首块之后 fixture 停住，等卡片挂载证据到手再继续。
 */
function makeTurnEndGate(subagent = false): TurnEndGate {
  const dir = mkTempDir('ue2-turn-gate-')
  const endPath = join(dir, 'release')
  const firstChunkPath = join(dir, 'first-chunk')
  const release = (path: string): void => {
    if (!existsSync(path)) writeFileSync(path, '')
  }
  return subagent
    ? {
        env: {
          ECHO_AGENT_TURN_END_GATE: endPath,
          ECHO_AGENT_STREAM_CONTINUE_GATE: firstChunkPath,
        },
        release: () => release(endPath),
        resume: () => release(firstChunkPath),
      }
    : { env: { ECHO_AGENT_TURN_END_GATE: endPath }, release: () => release(endPath) }
}

/**
 * Fire the prompt without awaiting it yet: the echo agent holds the turn open after the
 * last chunk — for the fixed hold, or until a gate releases it — and that window is where
 * the counters are read. The rejection is swallowed up front so that a failed assertion
 * inside the window surfaces as itself instead of as a teardown "page closed" error from
 * the abandoned promise.
 */
function drivePrompt(page: Page, text: string): Promise<void> {
  const running = page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), text)
  void running.catch(() => {})
  return running
}

/**
 * 跑一次 gated 提示：放提示 → 在 fixture 撑住 turn 的窗口里读数 → 释放两道门并等真实 turn
 * 结束。释放放 finally：读数抛错时也得放行，否则 fixture 要空等满安全超时。
 */
async function driveGatedPrompt<T>(
  page: Page,
  gate: TurnEndGate,
  promptText: string,
  read: () => Promise<T>,
): Promise<T> {
  const running = drivePrompt(page, promptText)
  try {
    const result = await read()
    gate.release()
    await running
    return result
  } finally {
    gate.resume?.()
    gate.release()
    await running.catch(() => {})
  }
}

/** Poll interval while the stream runs; the window it samples is the fixture's hold. */
const SAMPLE_INTERVAL_MS = 20

/**
 * 流式期间的读数（进程累计量相减，见 `E2EHeapFlowCounters.flow`）。收尾必须落在消息仍
 * streaming 的时刻：seal 会做这些用例断言「流式期间不该发生」的延迟工作。gate 把这段窗口
 * 变成条件而不是运气——整段已进模型且渲染器确实处理过（见 {@link hasRenderEvidence}）。
 */
async function measureStream(
  page: Page,
  baseline: StreamCounters,
  expectedLength: number,
  evidence: RenderEvidence,
): Promise<StreamCounters> {
  const deadline = Date.now() + 30000

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

    if (
      batch.streaming &&
      batch.length >= expectedLength &&
      hasRenderEvidence(baseline, batch, expectedLength, evidence)
    ) {
      return diff(baseline, batch)
    }

    if (Date.now() > deadline) {
      throw new Error(
        `no complete rendered streaming reading for a thought: ${batch.length}/${expectedLength} chars, ` +
          `streaming=${batch.streaming}, mdparse=${grewBy(baseline, batch, 'mdparse')}, ` +
          `colorizeSkip=${grewBy(baseline, batch, 'colorize.skip')}`,
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

/** Top-level Task cards of the active session, as the timeline holds them. */
function subagentCards(page: Page): Promise<ReadonlyArray<{ id: string }>> {
  return page.evaluate(() =>
    window
      .__E2E__!.getAcpToolCalls()
      .filter((call) => (call.children ?? []).length > 0)
      .map((call) => ({ id: call.id })),
  )
}

/**
 * Open a sub-agent card the way a user does: click the chevron in its header.
 *
 * Nothing else opens one — a folded card mounts no body, so its sub-agent message
 * never renders, which is exactly why that path's cost only shows up once a card is
 * open. Polling for a *live* child rather than for the card keeps the click inside
 * the measured window: the fence case needs the mount of a still-growing message to
 * be observed (that mount is what records the tokenize deferral), not excluded from
 * the measurement by an early baseline.
 */
async function openSubagentCard(page: Page): Promise<void> {
  const liveCard = () =>
    page.evaluate(() => {
      const call = window
        .__E2E__!.getAcpToolCalls()
        .find((c) => (c.children ?? []).some((child) => child.live === true))
      return call?.id ?? ''
    })
  await expect.poll(liveCard, { timeout: 20000, intervals: [10] }).not.toBe('')
  const id = await liveCard()
  const toggle = cardToggle(page, id)
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-expanded'), { timeout: 5000 }).toBe('true')
}

/** The header chevron of the card with this tool-call id (top-level cards carry the key). */
function cardToggle(page: Page, toolCallId: string) {
  // `.first()` is the card's *own* header: once a card is open its nested cards carry
  // toggles of their own, and those live under the same sticky-key subtree.
  return page
    .locator(`[data-sticky-key="t:${toolCallId}"] [data-testid="acp-collapsible-toggle"]`)
    .first()
}

/**
 * The children view of an `emit-subagent-mixed` run, taken at the last moment the turn is
 * still running.
 *
 * Reading it after the turn would prove nothing: `_flushStream` seals every child message
 * there, so a seal that never happened and one that did look exactly alike.
 * 取到两条子 toolCall（尾随那条闭合整个 run）且 turn 仍在跑就返回，放行由调用方在其后做，
 * 最终 seal 因此够不到这份快照。
 */
async function sampleMixedRun(page: Page): Promise<AcpChildSnapshot> {
  const deadline = Date.now() + 30000
  for (;;) {
    const batch = await page.evaluate(() => {
      // One evaluate on purpose: the snapshot and the turn state have to describe the
      // same instant.
      return {
        status: window.__E2E__!.getAcpSessionStatus(),
        children: window.__E2E__!.getAcpToolCalls().flatMap((call) => call.children ?? []),
      }
    })
    const toolCalls = batch.children.filter((child) => child.kind === 'toolCall').length
    if (toolCalls === 2 && batch.status !== 'idle') return batch.children
    if (Date.now() > deadline) {
      throw new Error(
        `no mixed sub-agent run observed (status=${batch.status}): ${JSON.stringify(batch.children)}`,
      )
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
  evidence: RenderEvidence,
): Promise<StreamCounters> {
  const deadline = Date.now() + 30000

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

    if (
      batch.live &&
      batch.length >= expectedLength &&
      hasRenderEvidence(baseline, batch, expectedLength, evidence)
    ) {
      return diff(baseline, batch)
    }

    if (Date.now() > deadline) {
      throw new Error(
        `no complete rendered streaming reading for a sub-agent message: ${batch.length}/${expectedLength} chars, ` +
          `live=${batch.live}, mdparse=${grewBy(baseline, batch, 'mdparse')}, ` +
          `colorizeSkip=${grewBy(baseline, batch, 'colorize.skip')}`,
      )
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS)
  }
}

/**
 * 首块门放行：先等到挂载证据（首块那段文本已被渲染器处理过），再让 fixture 继续发余下 chunk。
 * 卡片点开太晚时整段早已到齐，增量渲染只剩一次解析，这条用例就测不到要守的形状了。
 */
async function resumeAfterMount(
  page: Page,
  gate: TurnEndGate,
  baseline: StreamCounters,
  evidence: RenderEvidence,
): Promise<void> {
  await expect
    .poll(
      async () =>
        hasRenderEvidence(
          baseline,
          await page.evaluate(() => window.__E2E__!.getHeapFlowCounters()),
          CHUNK,
          evidence,
        ),
      { timeout: 20000 },
    )
    .toBe(true)
  gate.resume?.()
}

// Serial within the file (both tests drive the same shared echo agent), and each streams
// hundreds of chunks while polling — past the 30s suite default on a 2-core runner.
test.describe.configure({ mode: 'default', timeout: 90000 })

test.describe('@p1 acp streaming render accounting', () => {
  test('a sealable thought storm re-parses only its tail', async ({ page, workbench }) => {
    await workbench.waitForRestored()
    const gate = makeTurnEndGate()
    const baseline = await startEchoSession(page, undefined, gate.env)

    const COUNT = 300
    const expected = streamedText(COUNT, CHUNK, false)
    const streaming = await driveGatedPrompt(page, gate, `emit-thought:${COUNT}x1`, () =>
      measureStream(page, baseline, expected.length, 'mdparse'),
    )

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
    const gate = makeTurnEndGate()
    const baseline = await startEchoSession(page, undefined, gate.env)

    // The fence opens on the first chunk and is never closed, so no blank line is ever
    // outside it: nothing seals and the whole message stays one growing tail. That is
    // the shape that made every batch re-tokenize the entire fence.
    const COUNT = 100
    const expected = streamedText(COUNT, CHUNK, true)
    const streaming = await driveGatedPrompt(page, gate, `emit-thought:${COUNT}x1,fence`, () =>
      measureStream(page, baseline, expected.length, 'colorize.skip'),
    )

    expect(flowOf(streaming, 'colorize').chars).toBe(0)
    expect(flowOf(streaming, 'colorize.skip').chars).toBeGreaterThan(0)

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
    const gate = makeTurnEndGate(true)
    const baseline = await startEchoSession(page, 'expanded', gate.env)

    const COUNT = 300
    const expected = streamedText(COUNT, CHUNK, false)
    const streaming = await driveGatedPrompt(page, gate, `emit-subagent:${COUNT}x1`, async () => {
      await openSubagentCard(page)
      await resumeAfterMount(page, gate, baseline, 'mdparse')
      return measureSubagentStream(page, baseline, expected.length, 'mdparse')
    })

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
    const gate = makeTurnEndGate(true)
    const baseline = await startEchoSession(page, 'expanded', gate.env)

    // A fence that never closes: deferred while it streams, tokenized once it seals.
    const COUNT = 6
    const expected = streamedText(COUNT, CHUNK, true)
    const streaming = await driveGatedPrompt(
      page,
      gate,
      `emit-subagent:${COUNT}x1,fence`,
      async () => {
        await openSubagentCard(page)
        await resumeAfterMount(page, gate, baseline, 'colorize.skip')
        return measureSubagentStream(page, baseline, expected.length, 'colorize.skip')
      },
    )

    // Streaming-time deferral — the reading that has to be taken while the message is
    // still growing, since sealing is what ends it.
    expect(flowOf(streaming, 'colorize').chars).toBe(0)
    expect(flowOf(streaming, 'colorize.skip').chars).toBeGreaterThan(0)

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
    // No collapse mode and no card to open: this case reads the model through the
    // probe, and a folded card still holds every chunk it received.
    const gate = makeTurnEndGate()
    await startEchoSession(page, undefined, gate.env)

    const COUNT = 60
    const expected = streamedText(COUNT, CHUNK, false)
    const children = await driveGatedPrompt(page, gate, `emit-subagent-mixed:${COUNT}x1`, () =>
      sampleMixedRun(page),
    )

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

    // Read after the turn, not from the snapshot above: that one is taken while the turn
    // is still running, so it cannot show what the turn's own seal leaves behind. Sealing
    // preserves the text, so the split — which must have cost neither message any of it —
    // can still be checked here.
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

test.describe('@p1 acp sub-agent card exclusivity', () => {
  test('opening a second sub-agent card folds the one opened before it', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()
    await startEchoSession(page)

    // Two turns, two Task cards. Sub-agent timelines are long enough that a second
    // open card pushes the main conversation out of view, so only one may be open.
    const cardCount = async (): Promise<number> => (await subagentCards(page)).length
    const idle = () =>
      expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 30000 })
        .toBe('idle')
    await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), 'emit-subagent:2x1')
    await expect.poll(cardCount, { timeout: 30000 }).toBe(1)
    await idle()
    await page.evaluate((t) => window.__E2E__!.sendAcpPrompt(t), 'emit-subagent:2x1')
    await expect.poll(cardCount, { timeout: 30000 }).toBe(2)

    const cards = await subagentCards(page)
    const first = cardToggle(page, cards[0]!.id)
    const second = cardToggle(page, cards[1]!.id)

    await first.click()
    await expect(first).toHaveAttribute('aria-expanded', 'true')

    await second.click()
    // Still exactly one sub-agent timeline in the DOM — now the second card's.
    await expect(page.locator('[data-testid="acp-subagent-timeline"]')).toHaveCount(1)
    await expect(second).toHaveAttribute('aria-expanded', 'true')
    await expect(first).toHaveAttribute('aria-expanded', 'false')
  })
})
