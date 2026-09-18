/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  什么时候值得抓一次堆快照。纯数字 + 注入时钟：调用方喂样本，这里只回答
 *  「抓基线 / 抓增长 / 继续等 / 拒绝 / 收工」，不碰定时器、IO、文件系统、窗口。
 *
 *  规则之所以存在，是因为快照不免费：Electron 43 实测（见 docs/development/memory-pressure.md）
 *  renderer 主线程在抓取全程冻结，约 15–19ms/MB 活堆。入场券是「堆已稳定」（60s 内 3 个样本落
 *  在 10% 带内），出场券是「3 个样本跨 1 分钟一致指认、已知占用者又解释不了的增长」——否则产物
 *  记录的是某次 GC，不是泄漏。
 *--------------------------------------------------------------------------------------------*/

import type { HeapSnapshotNoticeCode, HeapSnapshotTrigger } from '../../../shared/ipc/services.js'

/** 字节单位。 */
const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

export interface HeapSnapshotThresholds {
  /** 一轮最长持续多久：授权是按轮的，不是常驻同意。 */
  readonly roundMaxMs: number
  /** 从武装到基线抓取的最短时间。 */
  readonly minArmMs: number
  /** 抓基线前至少要有几个样本。 */
  readonly minSamples: number
  /** 基线稳定带：(max − min) 不得超过均值的这个比例。 */
  readonly baselineBandRatio: number
  /** 基线开销硬上限，与堆上限无关。 */
  readonly baselineMaxBytes: number
  /** 任何一次抓取的开销硬上限，与堆上限无关。 */
  readonly captureMaxBytes: number
  /** 抓取上限占已上报 V8 堆上限的比例。 */
  readonly captureLimitRatio: number
  /** 堆够大时无条件达标的增长量。 */
  readonly growthMinBytes: number
  /** 相对基线达标的增长比例。 */
  readonly growthBaselineRatio: number
  /** 连续多少个样本超过阈值才考虑抓增长。 */
  readonly growthSamples: number
  /** 这些样本还必须跨这么久，一次突发不会触发抓取。 */
  readonly growthSpanMs: number
  /** 已知占用者能解释涨幅的这个比例时，算「已被解释」。 */
  readonly holderExplainRatio: number
  /** 比这更旧的样本不作数（窗口可能已经不再上报）。 */
  readonly sampleFreshMs: number
  /** 两次抓取的最小间隔，全应用级：冻结的是用户，不是某个窗口。 */
  readonly minCaptureSpacingMs: number
  /** 每窗口每轮的抓取调用次数，失败也算。 */
  readonly maxAttemptsPerRound: number
  /** 每次应用运行的抓取调用次数；停止后再武装不会重置。 */
  readonly maxAttemptsPerApp: number
  /** 每轮保留的样本数。有界，长轮次撑不爆这个结构。 */
  readonly sampleWindow: number
}

export const HEAP_SNAPSHOT_THRESHOLDS: HeapSnapshotThresholds = {
  roundMaxMs: 2 * 60 * 60_000,
  minArmMs: 60_000,
  minSamples: 3,
  baselineBandRatio: 0.1,
  baselineMaxBytes: 512 * MIB,
  captureMaxBytes: 1 * GIB,
  captureLimitRatio: 0.3,
  growthMinBytes: 256 * MIB,
  growthBaselineRatio: 0.5,
  growthSamples: 3,
  growthSpanMs: 60_000,
  holderExplainRatio: 0.5,
  sampleFreshMs: 45_000,
  minCaptureSpacingMs: 5 * 60_000,
  maxAttemptsPerRound: 2,
  maxAttemptsPerApp: 4,
  sampleWindow: 24,
}

export interface HeapSnapshotPolicySample {
  /** 这次读数的时刻（main 的接收时间，epoch ms）。 */
  readonly at: number
  readonly used: number
  readonly limit: number
  /** 本样本中 renderer 上报的占用者估算之和。 */
  readonly holdersBytes: number
}

export interface HeapSnapshotObserveInput {
  readonly now: number
  readonly sample: HeapSnapshotPolicySample
  readonly attemptsThisRound: number
  readonly appAttempts: number
  /** 上一次抓取开始的时间，全应用级——间隔规则读它。 */
  readonly lastCaptureAt: number | undefined
  /** 有别的抓取（任意窗口）正持有单航班锁时为真。 */
  readonly captureInFlight: boolean
}

/** 静默等待：轮次正在按预期推进，没什么要告诉用户的。 */
export type HeapSnapshotWaitCode =
  | 'not-armed'
  | 'settling'
  | 'need-samples'
  | 'below-threshold'
  | 'cooldown'
  | 'busy'

export type HeapSnapshotDecision =
  | { readonly kind: 'wait'; readonly code: HeapSnapshotWaitCode }
  | { readonly kind: 'blocked'; readonly code: HeapSnapshotNoticeCode; readonly detail: string }
  | {
      readonly kind: 'capture'
      readonly trigger: HeapSnapshotTrigger
      readonly captureLimitBytes: number
      readonly detail: string
    }
  | { readonly kind: 'stop'; readonly code: HeapSnapshotNoticeCode; readonly detail: string }

export interface HeapSnapshotReference {
  readonly at: number
  readonly used: number
  readonly holdersBytes: number
}

export interface HeapSnapshotPolicyState {
  readonly armedAt: number | undefined
  readonly samples: number
  readonly baseline: { readonly at: number; readonly used: number } | undefined
  readonly reference: HeapSnapshotReference | undefined
  readonly captureLimitBytes: number | undefined
  readonly growthThresholdBytes: number | undefined
}

export function describeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0MB'
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)}GB`
  return `${Math.round(bytes / MIB)}MB`
}

function mean(values: readonly number[]): number {
  let sum = 0
  for (const value of values) sum += value
  return values.length === 0 ? 0 : sum / values.length
}

/**
 * 某个堆上限对应的抓取上限：`min(1GiB, 30% × limit)`。limit 为 0 表示 renderer 从没上报过，
 * 而「按猜出来的尺寸抓」正是这个上限要防的事——所以答案是「未知」，不是给个默认值。
 */
export function captureLimitFor(
  limit: number,
  thresholds: HeapSnapshotThresholds = HEAP_SNAPSHOT_THRESHOLDS,
): number | undefined {
  if (!Number.isFinite(limit) || limit <= 0) return undefined
  return Math.min(thresholds.captureMaxBytes, thresholds.captureLimitRatio * limit)
}

/** 策略当前判断与理由的实时视图——给测试和日志行用。 */
export class HeapSnapshotPolicy {
  private readonly _thresholds: HeapSnapshotThresholds
  private _armedAt: number | undefined
  private _samples: HeapSnapshotPolicySample[] = []
  /** 从这个时刻起的样本组成当前基线带。 */
  private _bandStartAt = 0
  private _baseline: { at: number; used: number } | undefined
  private _baselineAt: number | undefined
  /**
   * 增长参照点：基线之后见过的最低读数，连同那一刻的占用者读数。**独立于采样窗口**存活，
   * 只在新低点下移、永不上移——慢涨（每样本几 MB、涨到阈值要 20 分钟以上）会被 24 条滑窗
   * 淘汰掉自己的谷底，若每次从窗口里现取最低值，参照会跟着一起涨，涨幅永远追不上参照。
   */
  private _reference: HeapSnapshotReference | undefined
  private _captureLimitBytes: number | undefined
  private _growthThresholdBytes: number | undefined

  constructor(thresholds?: Partial<HeapSnapshotThresholds>) {
    this._thresholds = { ...HEAP_SNAPSHOT_THRESHOLDS, ...thresholds }
  }

  get thresholds(): HeapSnapshotThresholds {
    return this._thresholds
  }

  get armed(): boolean {
    return this._armedAt !== undefined
  }

  /** 开一轮。上一轮的样本全部丢弃：新一轮从头测量。 */
  arm(at: number): void {
    this._armedAt = at
    this._bandStartAt = at
    this._samples = []
    this._baseline = undefined
    this._baselineAt = undefined
    this._reference = undefined
    this._captureLimitBytes = undefined
    this._growthThresholdBytes = undefined
  }

  disarm(): void {
    this._armedAt = undefined
  }

  get state(): HeapSnapshotPolicyState {
    return {
      armedAt: this._armedAt,
      samples: this._samples.length,
      baseline: this._baseline,
      reference: this._reference,
      captureLimitBytes: this._captureLimitBytes,
      growthThresholdBytes: this._growthThresholdBytes,
    }
  }

  observe(input: HeapSnapshotObserveInput): HeapSnapshotDecision {
    const armedAt = this._armedAt
    if (armedAt === undefined) return { kind: 'wait', code: 'not-armed' }

    this._record(input.sample)
    this._trackReference(input.sample)
    const t = this._thresholds

    if (input.now - armedAt > t.roundMaxMs) {
      return {
        kind: 'stop',
        code: 'round-expired',
        detail: `armed=${Math.round((input.now - armedAt) / 60_000)}min limit=${Math.round(t.roundMaxMs / 60_000)}min`,
      }
    }
    if (input.attemptsThisRound >= t.maxAttemptsPerRound) {
      return {
        kind: 'stop',
        code: 'round-quota-exhausted',
        detail: `attempts=${input.attemptsThisRound}/${t.maxAttemptsPerRound}`,
      }
    }
    if (input.appAttempts >= t.maxAttemptsPerApp) {
      return {
        kind: 'stop',
        code: 'app-quota-exhausted',
        detail: `appAttempts=${input.appAttempts}/${t.maxAttemptsPerApp}`,
      }
    }
    // 已有抓取在跑不必提示（下个样本会重新判断），但绝不能起第二次。
    if (input.captureInFlight) return { kind: 'wait', code: 'busy' }

    const limit = captureLimitFor(input.sample.limit, t)
    if (limit === undefined) {
      return {
        kind: 'blocked',
        code: 'heap-limit-unknown',
        detail: `limit=${describeBytes(input.sample.limit)}`,
      }
    }
    this._captureLimitBytes = limit

    const stale = input.now - input.sample.at > t.sampleFreshMs
    if (stale) {
      return {
        kind: 'blocked',
        code: 'sample-stale',
        detail: `age=${Math.round((input.now - input.sample.at) / 1000)}s fresh=${Math.round(t.sampleFreshMs / 1000)}s`,
      }
    }

    return this._baseline === undefined
      ? this._decideBaseline(input, limit)
      : this._decideGrowth(input, limit)
  }

  private _record(sample: HeapSnapshotPolicySample): void {
    this._samples.push(sample)
    const excess = this._samples.length - this._thresholds.sampleWindow
    if (excess > 0) this._samples.splice(0, excess)
  }

  /** 只降不升：每次样本都看，但只有新低点才改写参照。 */
  private _trackReference(sample: HeapSnapshotPolicySample): void {
    const baselineAt = this._baselineAt
    if (this._baseline === undefined || baselineAt === undefined) return
    if (sample.at < baselineAt) return
    const reference = this._reference
    if (reference !== undefined && sample.used >= reference.used) return
    this._reference = { at: sample.at, used: sample.used, holdersBytes: sample.holdersBytes }
  }

  private _decideBaseline(input: HeapSnapshotObserveInput, limit: number): HeapSnapshotDecision {
    const t = this._thresholds
    const cap = Math.min(t.baselineMaxBytes, limit / 2)
    if (input.sample.used > cap) {
      return {
        kind: 'blocked',
        code: 'baseline-too-large',
        detail: `used=${describeBytes(input.sample.used)} baselineCap=${describeBytes(cap)}`,
      }
    }

    const band = this._band()
    const values = band.map((sample) => sample.used)
    if (values.length >= t.minSamples) {
      let min = Number.POSITIVE_INFINITY
      let max = 0
      for (const value of values) {
        if (value < min) min = value
        if (value > max) max = value
      }
      const average = mean(values)
      if (average > 0 && max - min > t.baselineBandRatio * average) {
        // 堆还在快速移动，基线没有意义。把稳定带从最新样本重新开始，而不是永远背着这个
        // 离群点：之后稳定下来仍能拿到基线，一直涨的则一直报同一理由，而不是抓一份噪声。
        this._bandStartAt = input.sample.at
        return {
          kind: 'blocked',
          code: 'baseline-unstable',
          detail: `spread=${describeBytes(max - min)} mean=${describeBytes(average)} band=${Math.round(t.baselineBandRatio * 100)}% samples=${values.length}`,
        }
      }
    }

    const armedAt = this._armedAt ?? input.now
    if (input.now - armedAt < t.minArmMs) {
      return { kind: 'wait', code: 'settling' }
    }
    if (band.length < t.minSamples) return { kind: 'wait', code: 'need-samples' }

    return {
      kind: 'capture',
      trigger: 'baseline',
      captureLimitBytes: cap,
      detail: `used=${describeBytes(input.sample.used)} cap=${describeBytes(cap)} samples=${band.length}`,
    }
  }

  private _decideGrowth(input: HeapSnapshotObserveInput, limit: number): HeapSnapshotDecision {
    const t = this._thresholds
    const baseline = this._baseline
    if (baseline === undefined) return { kind: 'wait', code: 'need-samples' }
    const baselineAt = this._baselineAt ?? baseline.at
    const reference = this._reference
    // 参照点是基线之后的最低读数（含那一刻的占用者读数），由 `_trackReference` 维护。
    if (reference === undefined) return { kind: 'wait', code: 'need-samples' }

    const headroom = limit - reference.used
    if (headroom <= 0) {
      return {
        kind: 'blocked',
        code: 'capture-limit-reached',
        detail: `used=${describeBytes(reference.used)} captureLimit=${describeBytes(limit)}`,
      }
    }

    // 取 max(256MiB, 基线 50%)，再收窄到剩余空间的一半，让触发点及其以上都落在抓取上限
    // 之下。收窄只会降低阈值，小堆上才够得着，而不是要求一个塞不进去的涨幅。
    const base = Math.max(t.growthMinBytes, t.growthBaselineRatio * baseline.used)
    const threshold = Math.min(base, headroom / 2)
    this._growthThresholdBytes = threshold

    // 只看窗口内的样本（有界），但比的是独立存活的参照点。
    const post = this._samples.filter((sample) => sample.at >= baselineAt)
    const above: HeapSnapshotPolicySample[] = []
    for (let i = post.length - 1; i >= 0; i--) {
      const sample = post[i] as HeapSnapshotPolicySample
      if (sample.used - reference.used < threshold) break
      above.unshift(sample)
    }
    const oldest = above[0]
    const newest = above[above.length - 1]
    if (
      above.length < t.growthSamples ||
      oldest === undefined ||
      newest === undefined ||
      newest.at - oldest.at < t.growthSpanMs
    ) {
      return { kind: 'wait', code: 'below-threshold' }
    }

    if (input.sample.used > limit) {
      return {
        kind: 'blocked',
        code: 'heap-too-large',
        detail: `used=${describeBytes(input.sample.used)} captureLimit=${describeBytes(limit)}`,
      }
    }

    const heapGrowth = input.sample.used - reference.used
    const holderGrowth = input.sample.holdersBytes - reference.holdersBytes
    if (heapGrowth > 0 && holderGrowth >= t.holderExplainRatio * heapGrowth) {
      return {
        kind: 'blocked',
        code: 'holders-explain',
        detail: `heapGrowth=${describeBytes(heapGrowth)} holdersGrowth=${describeBytes(Math.max(0, holderGrowth))}`,
      }
    }

    if (
      input.lastCaptureAt !== undefined &&
      input.now - input.lastCaptureAt < t.minCaptureSpacingMs
    ) {
      return { kind: 'wait', code: 'cooldown' }
    }

    return {
      kind: 'capture',
      trigger: 'growth',
      captureLimitBytes: limit,
      detail: `reference=${describeBytes(reference.used)} used=${describeBytes(input.sample.used)} threshold=${describeBytes(threshold)} samples=${above.length}`,
    }
  }

  /** 组成当前基线带的样本，由旧到新。 */
  private _band(): HeapSnapshotPolicySample[] {
    return this._samples.filter((sample) => sample.at >= this._bandStartAt)
  }

  /** 基线抓取落盘后由 controller 调用。 */
  markBaselineCaptured(at: number, used: number): void {
    this._baseline = { at, used }
    this._baselineAt = at
    this._reference = undefined
    this._growthThresholdBytes = undefined
  }
}
