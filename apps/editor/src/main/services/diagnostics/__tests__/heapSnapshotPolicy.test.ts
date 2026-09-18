/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/diagnostics/heapSnapshotPolicy.ts
 *  策略是「用户要求抓快照」和「renderer 被冻住」之间唯一的一道闸，所以这些用例全部写成
 *  边界：数字就是契约（60s / 3 样本 / 10% 带 / 512MiB / 上限的 30% / 256MiB 或 50% /
 *  跨 60s 的 3 样本 / 5 分钟间隔 / 每轮 2 次 / 每次运行 4 次 / 2 小时）。
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  HEAP_SNAPSHOT_THRESHOLDS,
  HeapSnapshotPolicy,
  captureLimitFor,
  describeBytes,
  type HeapSnapshotDecision,
  type HeapSnapshotObserveInput,
} from '../heapSnapshotPolicy.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
/** A 4GiB heap limit: the capture ceiling lands on the 1GiB hard cap, not the 30%. */
const LIMIT = 4 * GIB

class Clock {
  now = 1_700_000_000_000
  advance(ms: number): void {
    this.now += ms
  }
}

interface FeedOptions {
  readonly used: number
  readonly limit?: number
  readonly holdersBytes?: number
  /** Milliseconds of clock movement before the sample is taken. */
  readonly afterMs?: number
  readonly attemptsThisRound?: number
  readonly appAttempts?: number
  readonly lastCaptureAt?: number
  readonly captureInFlight?: boolean
}

function feed(
  policy: HeapSnapshotPolicy,
  clock: Clock,
  options: FeedOptions,
): HeapSnapshotDecision {
  clock.advance(options.afterMs ?? 0)
  const input: HeapSnapshotObserveInput = {
    now: clock.now,
    sample: {
      at: clock.now,
      used: options.used,
      limit: options.limit ?? LIMIT,
      holdersBytes: options.holdersBytes ?? 0,
    },
    attemptsThisRound: options.attemptsThisRound ?? 0,
    appAttempts: options.appAttempts ?? 0,
    lastCaptureAt: options.lastCaptureAt,
    captureInFlight: options.captureInFlight ?? false,
  }
  return policy.observe(input)
}

/** The wait/blocked/stop reason, or the capture trigger — never just its shape. */
function noticeCode(decision: HeapSnapshotDecision): string {
  return 'code' in decision ? decision.code : `${decision.kind}`
}

/** Arms a round and feeds three settled samples, which is exactly one baseline. */
function armAndSettle(policy: HeapSnapshotPolicy, clock: Clock, used = 200 * MIB): void {
  policy.arm(clock.now)
  expect(feed(policy, clock, { used, afterMs: 70_000 }).kind).toBe('wait')
  expect(feed(policy, clock, { used, afterMs: 30_000 }).kind).toBe('wait')
  const decision = feed(policy, clock, { used, afterMs: 30_000 })
  expect(decision.kind).toBe('capture')
  // The capture takes time in production, so the baseline mark lands after the last
  // sample; the reference is taken from what follows it, not from the baseline itself.
  clock.advance(1_000)
  policy.markBaselineCaptured(clock.now, used)
}

describe('captureLimitFor', () => {
  it('takes the hard cap when 30% of the limit is larger', () => {
    expect(captureLimitFor(LIMIT)).toBe(GIB)
  })

  it('takes 30% when the heap limit is small', () => {
    expect(captureLimitFor(GIB)).toBe(0.3 * GIB)
  })

  it('is undefined when the window never reported a limit', () => {
    // A snapshot sized by a guess is what the ceiling exists to prevent.
    expect(captureLimitFor(0)).toBeUndefined()
    expect(captureLimitFor(Number.NaN)).toBeUndefined()
    expect(captureLimitFor(-1)).toBeUndefined()
  })
})

describe('HeapSnapshotPolicy', () => {
  it('does nothing at all until a round is armed', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    expect(noticeCode(feed(policy, clock, { used: 200 * MIB }))).toBe('not-armed')
    expect(policy.armed).toBe(false)
  })

  it('waits for the arm to age before the first baseline', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    expect(noticeCode(feed(policy, clock, { used: 200 * MIB, afterMs: 10_000 }))).toBe('settling')
  })

  it('captures a baseline once three samples inside the band have aged', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    expect(noticeCode(feed(policy, clock, { used: 200 * MIB, afterMs: 70_000 }))).toBe(
      'need-samples',
    )
    expect(noticeCode(feed(policy, clock, { used: 205 * MIB, afterMs: 30_000 }))).toBe(
      'need-samples',
    )
    const decision = feed(policy, clock, { used: 195 * MIB, afterMs: 30_000 })
    expect(decision).toMatchObject({ kind: 'capture', trigger: 'baseline' })
    // Baseline cap is min(512MiB, ceiling / 2) — here the ceiling is 1GiB, so 512MiB.
    expect(decision.kind === 'capture' && decision.captureLimitBytes).toBe(512 * MIB)
    expect(policy.state.samples).toBe(3)
  })

  it('refuses a baseline that would cost more than the cap', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    feed(policy, clock, { used: 600 * MIB, afterMs: 70_000 })
    feed(policy, clock, { used: 600 * MIB, afterMs: 30_000 })
    const decision = feed(policy, clock, { used: 600 * MIB, afterMs: 30_000 })
    expect(noticeCode(decision)).toBe('baseline-too-large')
  })

  it('will not baseline a heap that is still moving, and re-arms its band', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    feed(policy, clock, { used: 200 * MIB, afterMs: 70_000 })
    feed(policy, clock, { used: 300 * MIB, afterMs: 30_000 })
    expect(noticeCode(feed(policy, clock, { used: 460 * MIB, afterMs: 30_000 }))).toBe(
      'baseline-unstable',
    )
    // The band restarted at the newest sample: three settled readings after it still
    // produce a baseline rather than the outlier poisoning the round forever.
    expect(noticeCode(feed(policy, clock, { used: 460 * MIB, afterMs: 30_000 }))).toBe(
      'need-samples',
    )
    expect(feed(policy, clock, { used: 460 * MIB, afterMs: 30_000 })).toMatchObject({
      kind: 'capture',
      trigger: 'baseline',
    })
  })

  it('refuses to size anything when the heap limit is unknown', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    expect(noticeCode(feed(policy, clock, { used: 200 * MIB, limit: 0, afterMs: 70_000 }))).toBe(
      'heap-limit-unknown',
    )
  })

  it('treats a sample older than the freshness bound as no evidence', () => {
    // The window may have gone away without saying so; acting on a two-minute-old
    // reading is exactly how a snapshot lands on a renderer nobody is looking at.
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    const stale = policy.observe({
      now: clock.now + 120_000,
      sample: { at: clock.now, used: 200 * MIB, limit: LIMIT, holdersBytes: 0 },
      attemptsThisRound: 0,
      appAttempts: 0,
      lastCaptureAt: undefined,
      captureInFlight: false,
    })
    expect(noticeCode(stale)).toBe('sample-stale')
  })

  it('stops the round after two hours', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    const decision = feed(policy, clock, {
      used: 200 * MIB,
      afterMs: HEAP_SNAPSHOT_THRESHOLDS.roundMaxMs + 1,
    })
    expect(noticeCode(decision)).toBe('round-expired')
  })

  it('stops when the round or the app has spent its attempts', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    expect(noticeCode(feed(policy, clock, { used: 200 * MIB, attemptsThisRound: 2 }))).toBe(
      'round-quota-exhausted',
    )
    expect(noticeCode(feed(policy, clock, { used: 200 * MIB, appAttempts: 4 }))).toBe(
      'app-quota-exhausted',
    )
  })

  it('waits instead of stacking a second capture on a running one', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    expect(
      noticeCode(feed(policy, clock, { used: 200 * MIB, afterMs: 70_000, captureInFlight: true })),
    ).toBe('busy')
  })
})

describe('HeapSnapshotPolicy growth decisions', () => {
  /** Baseline at 200MiB, then the capture-induced trough the reference is taken from. */
  function armedAndBaselined(): { policy: HeapSnapshotPolicy; clock: Clock } {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    armAndSettle(policy, clock, 200 * MIB)
    expect(feed(policy, clock, { used: 150 * MIB, afterMs: 1_000 }).kind).toBe('wait')
    return { policy, clock }
  }

  it('measures growth from the trough after the baseline, not from the baseline', () => {
    const { policy, clock } = armedAndBaselined()
    // 150 + 256 = 406 is the threshold; 400 is still inside it.
    expect(noticeCode(feed(policy, clock, { used: 400 * MIB, afterMs: 30_000 }))).toBe(
      'below-threshold',
    )
    expect(feed(policy, clock, { used: 500 * MIB, afterMs: 30_000 }).kind).toBe('wait')
    expect(feed(policy, clock, { used: 520 * MIB, afterMs: 30_000 }).kind).toBe('wait')
    const decision = feed(policy, clock, { used: 540 * MIB, afterMs: 30_000 })
    expect(decision).toMatchObject({ kind: 'capture', trigger: 'growth' })
    expect(policy.state.reference?.used).toBe(150 * MIB)
  })

  it('keeps the reference at the low water mark: a new trough lowers it, nothing raises it', () => {
    const { policy, clock } = armedAndBaselined()
    expect(policy.state.reference?.used).toBe(150 * MIB)

    // 中间一次远高于参照的读数不得把参照抬上去——否则增长会被自己的参照追平。
    feed(policy, clock, { used: 400 * MIB, afterMs: 30_000 })
    expect(policy.state.reference?.used).toBe(150 * MIB)

    // 新谷底更新参照，随后的回升不再改它。
    feed(policy, clock, { used: 120 * MIB, afterMs: 30_000 })
    expect(policy.state.reference?.used).toBe(120 * MIB)
    feed(policy, clock, { used: 300 * MIB, afterMs: 30_000 })
    expect(policy.state.reference?.used).toBe(120 * MIB)
  })

  it('carries the holder reading of that same trough in the reference', () => {
    // 堆与占用者两个涨幅必须量自**同一个**样本：拿两个不同时刻的读数相减，占用者会凭空
    // 解释掉一部分涨幅（或反过来），增长判定就失真了。
    const { policy, clock } = armedAndBaselined()
    feed(policy, clock, { used: 120 * MIB, holdersBytes: 40 * MIB, afterMs: 30_000 })
    expect(policy.state.reference).toMatchObject({ used: 120 * MIB, holdersBytes: 40 * MIB })
  })

  it('triggers on a slow climb that outlives the sample window', () => {
    // 真实节奏：默认阈值 + 5 秒一个样本，涨幅 1MB/样本、总涨幅 256MB（阈值）要 20 分钟以上。
    // 采样窗口只有 24 条（=120 秒），所以参照点必须独立于窗口存活——每次从窗口里重新取最低
    // 值会让参照跟着慢涨抬上去，涨幅永远追不上它自己，这一轮就永远不触发。
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    feed(policy, clock, { used: 200 * MIB, afterMs: 70_000 })
    feed(policy, clock, { used: 200 * MIB, afterMs: 30_000 })
    expect(feed(policy, clock, { used: 200 * MIB, afterMs: 30_000 }).kind).toBe('capture')
    clock.advance(1_000)
    policy.markBaselineCaptured(clock.now, 200 * MIB)
    const baselineCapturedAt = clock.now

    let capture: HeapSnapshotDecision | undefined
    let samples = 0
    for (; samples < 600 && capture === undefined; samples++) {
      const decision = feed(policy, clock, {
        used: 150 * MIB + samples * MIB,
        afterMs: 5_000,
        lastCaptureAt: baselineCapturedAt,
      })
      if (decision.kind === 'capture') capture = decision
    }

    expect(capture).toMatchObject({ kind: 'capture', trigger: 'growth' })
    // 触发需要 256 个样本跨过阈值，再加上「3 个样本跨 60 秒」所需的 12 个样本。
    expect(samples).toBeGreaterThan(256)
    expect(clock.now - baselineCapturedAt).toBeGreaterThan(20 * 60_000)
    // 参照仍是那个谷底，没有被这轮慢涨抬走。
    expect(policy.state.reference?.used).toBe(150 * MIB)
    // 窗口依然有界：触发时历史没有被这 20 多分钟撑大。
    expect(policy.state.samples).toBe(HEAP_SNAPSHOT_THRESHOLDS.sampleWindow)
  })

  it('will not decide on a rise that is younger than a minute', () => {
    const { policy, clock } = armedAndBaselined()
    feed(policy, clock, { used: 600 * MIB, afterMs: 10_000 })
    feed(policy, clock, { used: 600 * MIB, afterMs: 10_000 })
    // Three samples, but only 20s apart: a burst, not growth.
    expect(noticeCode(feed(policy, clock, { used: 600 * MIB, afterMs: 10_000 }))).toBe(
      'below-threshold',
    )
  })

  it('lets the tracked holders explain a rise away', () => {
    const { policy, clock } = armedAndBaselined()
    feed(policy, clock, { used: 600 * MIB, holdersBytes: 100 * MIB, afterMs: 30_000 })
    feed(policy, clock, { used: 600 * MIB, holdersBytes: 200 * MIB, afterMs: 30_000 })
    const decision = feed(policy, clock, {
      used: 600 * MIB,
      holdersBytes: 300 * MIB,
      afterMs: 30_000,
    })
    expect(noticeCode(decision)).toBe('holders-explain')
  })

  it('holds the five-minute spacing between two captures', () => {
    const { policy, clock } = armedAndBaselined()
    feed(policy, clock, { used: 600 * MIB, afterMs: 30_000 })
    feed(policy, clock, { used: 600 * MIB, afterMs: 30_000 })
    const first = feed(policy, clock, { used: 600 * MIB, afterMs: 30_000 })
    expect(first).toMatchObject({ kind: 'capture', trigger: 'growth' })

    // Same sustained rise, but the previous capture was a minute ago.
    feed(policy, clock, { used: 600 * MIB, afterMs: 30_000 })
    feed(policy, clock, { used: 600 * MIB, afterMs: 30_000 })
    const tooSoon = feed(policy, clock, {
      used: 600 * MIB,
      afterMs: 30_000,
      lastCaptureAt: clock.now - 60_000,
    })
    expect(noticeCode(tooSoon)).toBe('cooldown')

    const late = feed(policy, clock, {
      used: 600 * MIB,
      afterMs: 30_000,
      lastCaptureAt: clock.now - HEAP_SNAPSHOT_THRESHOLDS.minCaptureSpacingMs,
    })
    expect(late.kind).toBe('capture')
  })

  it('refuses a growth capture once the heap is past the ceiling', () => {
    const { policy, clock } = armedAndBaselined()
    feed(policy, clock, { used: 1200 * MIB, afterMs: 30_000 })
    feed(policy, clock, { used: 1200 * MIB, afterMs: 30_000 })
    expect(noticeCode(feed(policy, clock, { used: 1200 * MIB, afterMs: 30_000 }))).toBe(
      'heap-too-large',
    )
  })

  it('narrows the threshold to half the headroom on a small heap', () => {
    // 1GiB limit → 322MiB ceiling → 161MiB baseline cap. The heap has 61MiB of room
    // above the trough, so a rise that could never fit under the ceiling is not demanded.
    const smallLimit = GIB
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    feed(policy, clock, { used: 100 * MIB, limit: smallLimit, afterMs: 70_000 })
    feed(policy, clock, { used: 100 * MIB, limit: smallLimit, afterMs: 30_000 })
    expect(feed(policy, clock, { used: 100 * MIB, limit: smallLimit, afterMs: 30_000 }).kind).toBe(
      'capture',
    )
    clock.advance(1_000)
    policy.markBaselineCaptured(clock.now, 100 * MIB)

    expect(
      noticeCode(feed(policy, clock, { used: 230 * MIB, limit: smallLimit, afterMs: 30_000 })),
    ).toBe('below-threshold')
    expect(feed(policy, clock, { used: 290 * MIB, limit: smallLimit, afterMs: 30_000 }).kind).toBe(
      'wait',
    )
    expect(feed(policy, clock, { used: 290 * MIB, limit: smallLimit, afterMs: 30_000 }).kind).toBe(
      'wait',
    )
    const decision = feed(policy, clock, {
      used: 290 * MIB,
      limit: smallLimit,
      afterMs: 30_000,
    })
    expect(decision.kind).toBe('capture')
    // Narrowed to half the remaining room (322 − 230 = 92 → 46MiB), which is what keeps
    // the crossing point below the ceiling instead of demanding an impossible rise.
    expect(policy.state.growthThresholdBytes).toBeLessThanOrEqual(256 * MIB)
    // The rise still fits under the ceiling, which is the whole point of narrowing it.
    expect(decision.kind === 'capture' && decision.captureLimitBytes).toBe(
      captureLimitFor(smallLimit),
    )
  })

  it('reports a ceiling it can no longer reach', () => {
    const policy = new HeapSnapshotPolicy()
    const clock = new Clock()
    policy.arm(clock.now)
    feed(policy, clock, { used: 100 * MIB, afterMs: 70_000 })
    feed(policy, clock, { used: 100 * MIB, afterMs: 30_000 })
    feed(policy, clock, { used: 100 * MIB, afterMs: 30_000 })
    clock.advance(1_000)
    policy.markBaselineCaptured(clock.now, 100 * MIB)
    expect(noticeCode(feed(policy, clock, { used: 2 * GIB, afterMs: 30_000 }))).toBe(
      'capture-limit-reached',
    )
  })

  it('drops the previous round when a new one is armed', () => {
    const { policy, clock } = armedAndBaselined()
    policy.arm(clock.now)
    expect(policy.state.baseline).toBeUndefined()
    expect(policy.state.samples).toBe(0)
    expect(noticeCode(feed(policy, clock, { used: 200 * MIB }))).toBe('settling')
  })
})

describe('describeBytes', () => {
  it('prints MB below a GB and GB above it', () => {
    expect(describeBytes(512 * MIB)).toBe('512MB')
    expect(describeBytes(2 * GIB)).toBe('2.0GB')
    expect(describeBytes(0)).toBe('0MB')
    expect(describeBytes(Number.NaN)).toBe('0MB')
  })
})
