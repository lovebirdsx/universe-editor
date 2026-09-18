/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  堆快照轮次的编排：全应用一个实例、同时只有一次抓取、每窗口一轮，且只有在「用户点的那
 *  个窗口仍是应答的那个窗口」时才留下文件。
 *
 *  两处刻意不聪明：
 *  - `takeHeapSnapshot` 无法取消。停止只停住*后续*抓取；已经在跑的那次按「仍在跑」上报，
 *    永不写成「已取消」，它持有的锁在 promise 真正落定时释放——不是超时一到就释放。
 *  - 用户没在那个窗口点过就不抓；武装时盖下的身份（webContents / pid / navigation epoch）
 *    在每次 await 之后都要再核对一遍。抓取途中 reload，文件描述的就是一个已经不存在的
 *    renderer，只能丢弃，不能改名留下。
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { freemem } from 'node:os'
import type { ILogger } from '@universe-editor/platform'
import type {
  HeapSnapshotArtifactInfo,
  HeapSnapshotEvent,
  HeapSnapshotEventKind,
  HeapSnapshotNoticeCode,
  HeapSnapshotPhase,
  HeapSnapshotStatus,
  HeapSnapshotTrigger,
} from '../../../shared/ipc/services.js'
import {
  HEAP_SNAPSHOT_THRESHOLDS,
  HeapSnapshotPolicy,
  captureLimitFor,
  describeBytes,
  type HeapSnapshotThresholds,
} from './heapSnapshotPolicy.js'
import { getSharedSystemMemorySampler, type SystemMemoryStatus } from './systemMemorySampler.js'

const GIB = 1024 * 1024 * 1024
const SNAPSHOT_SUFFIX = '.heapsnapshot'
const PARTIAL_SUFFIX = '.heapsnapshot.partial'
const META_SUFFIX = '.json'

/** 每个产物（快照、partial、元数据 sidecar）都占预算。 */
export const HEAP_SNAPSHOT_DIR_BUDGET = {
  maxBytes: 4 * GIB,
  maxArtifacts: 8,
} as const

export interface HeapSnapshotDirectoryBudget {
  readonly maxBytes: number
  readonly maxArtifacts: number
}

/** 快照目录里的一个产物，只列清单不含内容。 */
export interface HeapSnapshotArtifactEntry {
  readonly name: string
  readonly bytes: number
  readonly mtimeMs: number
  readonly kind: 'snapshot' | 'partial' | 'metadata'
  /** 抓取没写完留下的 `.partial` 为真。 */
  readonly incomplete: boolean
}

/** 轮次针对的活 renderer。以 main 为准：没有一项来自 renderer。 */
export interface HeapSnapshotWindowRef {
  readonly windowId: number
  readonly webContentsId: number
  readonly pid: number
  readonly navigationEpoch: number
  /** Electron 的 `webContents.takeHeapSnapshot`，文件由它自己写。 */
  takeHeapSnapshot(path: string): Promise<void>
  /** 窗口还在（进程没被销毁）。 */
  isAlive(): boolean
  /**
   * 窗口里的 renderer 还在跑。崩溃过的 renderer 不是「窗口已关闭」——窗口还开着，只是里面
   * 没有可测量的堆，报成关了会指向一个用户看不见的事件。
   */
  isRendererAlive(): boolean
}

export interface HeapSnapshotTargetIdentity {
  readonly windowId: number
  readonly webContentsId: number
  readonly pid: number
  readonly navigationEpoch: number
}

/** 窗口服务就绪后由 main/index.ts 迟到绑定（同 bugRecorder）。 */
export interface HeapSnapshotWindowHost {
  resolve(windowId: number): HeapSnapshotWindowRef | undefined
}

export interface HeapSnapshotSampleInput {
  readonly windowId: number
  /** main 的接收时间——做判断不信 renderer 自己的钟。 */
  readonly at: number
  readonly used: number
  readonly limit: number
  readonly holdersBytes: number
  /**
   * renderer 每次启动自己生成的 id（给了才带）。导航代次*不*从这里传入：main 直接读活窗口，
   * 样本无法自封所属的 renderer 世代。
   */
  readonly incarnation?: string
}

export interface HeapSnapshotResourceReadings {
  readonly availablePhysicalBytes: number | undefined
  readonly commitStatus: SystemMemoryStatus
  readonly commitHeadroomBytes: number | undefined
  readonly commitAgeMs: number
}

export interface HeapSnapshotResourceThresholds {
  /** 无论堆多大，抓取都必须留下的空闲下限。 */
  readonly minFreeBytes: number
  /** 以及它还必须留出的、被快照堆大小的倍数。 */
  readonly usedMultiplier: number
}

export const HEAP_SNAPSHOT_RESOURCE_THRESHOLDS: HeapSnapshotResourceThresholds = {
  minFreeBytes: 2 * GIB,
  usedMultiplier: 2,
}

export type HeapSnapshotResourceVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: HeapSnapshotNoticeCode; readonly detail: string }

/**
 * 纯准入判断，读的是别人取好的读数。一次快照在两头都是大块临时分配（renderer 写的时候
 * 要托住对象图，文件还要落盘），所以三项资源都必须容得下被描述堆的两倍，再加一个下限，
 * 免得小堆在快满的机器上也能被抓。
 */
export function evaluateCaptureResources(input: {
  readonly resources: HeapSnapshotResourceReadings
  readonly diskFreeBytes: number | undefined
  readonly usedBytes: number
  readonly thresholds?: Partial<HeapSnapshotResourceThresholds>
}): HeapSnapshotResourceVerdict {
  const thresholds = { ...HEAP_SNAPSHOT_RESOURCE_THRESHOLDS, ...input.thresholds }
  const need = Math.max(thresholds.minFreeBytes, thresholds.usedMultiplier * input.usedBytes)
  const detail = (label: string, free: number | undefined): string =>
    `${label}=${free === undefined ? 'unknown' : describeBytes(free)} need=${describeBytes(need)} used=${describeBytes(input.usedBytes)}`

  const physical = input.resources.availablePhysicalBytes
  if (physical === undefined || physical < need) {
    return { ok: false, code: 'physical-memory-low', detail: detail('physical', physical) }
  }

  // `unsupported` 不是失败：没有 commit 记账的平台本来就没这个数，把「没有」当成压力会
  // 让 macOS / Linux 永远抓不了。有的平台（Windows）则必须给出新鲜读数——两分钟前的
  // 「还空 12GB」说明不了现在。
  if (input.resources.commitStatus === 'stale' || input.resources.commitStatus === 'unknown') {
    return {
      ok: false,
      code: 'commit-unknown',
      detail: `commit=${input.resources.commitStatus} age=${Math.round(input.resources.commitAgeMs / 1000)}s`,
    }
  }
  if (input.resources.commitStatus === 'ok') {
    const headroom = input.resources.commitHeadroomBytes
    if (headroom === undefined || headroom < need) {
      return { ok: false, code: 'commit-headroom-low', detail: detail('commit', headroom) }
    }
  }

  const diskNeed =
    Math.max(thresholds.minFreeBytes, 0) + thresholds.usedMultiplier * input.usedBytes
  if (input.diskFreeBytes === undefined) {
    return {
      ok: false,
      code: 'disk-unknown',
      detail: `disk=unknown need=${describeBytes(diskNeed)}`,
    }
  }
  if (input.diskFreeBytes < diskNeed) {
    return {
      ok: false,
      code: 'disk-space-low',
      detail: `disk=${describeBytes(input.diskFreeBytes)} need=${describeBytes(diskNeed)}`,
    }
  }
  return { ok: true }
}

export interface HeapSnapshotControllerOptions {
  /** <userData>/diagnostics/heap-snapshots——绝不放进 logs。 */
  readonly dir: string
  readonly logger?: ILogger
  readonly now?: () => number
  readonly thresholds?: Partial<HeapSnapshotThresholds>
  readonly budget?: Partial<HeapSnapshotDirectoryBudget>
  /** 准入判断用的资源读数；默认取共享采样器加 `os` 的物理内存。 */
  readonly readResources?: () => HeapSnapshotResourceReadings
  /** 快照所在卷的空闲字节；`undefined` 表示读数失败。 */
  readonly diskFreeBytes?: (dir: string) => Promise<number | undefined>
  /** 建目录的注入点：测试要能在这一次 await 里停住轮次、换掉 renderer。 */
  readonly mkdir?: (dir: string) => Promise<void>
  /** 抓取跑多久后才发提示。它永远不会被取消。 */
  readonly captureStallNoticeMs?: number
  readonly onEvent?: (event: HeapSnapshotEvent) => void
}

/** 冻结 90 秒值得告诉用户；这只是提示，不是取消。 */
export const HEAP_SNAPSHOT_STALL_NOTICE_MS = 90_000

/** 时钟被冻住时的重试下限：按固定频率重试，而不是贴着 0 间隔空转。 */
const EXPIRY_REARM_FLOOR_MS = 1_000

/** 有界的目录扫描：够预算和清单用即可，绝不无界。 */
const DIRECTORY_SCAN_LIMIT = 64
const MANIFEST_LIMIT = 32

interface RoundState {
  readonly windowId: number
  readonly identity: HeapSnapshotTargetIdentity
  readonly armedAt: number
  readonly expiresAt: number
  readonly policy: HeapSnapshotPolicy
  attempts: number
  artifacts: number
  bytes: number
  incarnation: string | undefined
  stopped: boolean
  code: HeapSnapshotNoticeCode | undefined
  detail: string | undefined
  lastNoticeCode: HeapSnapshotNoticeCode | undefined
  revision: number
  sampleUsed: number
  sampleLimit: number
  /** 最近一个有效样本的 **main 接收时间**：判新鲜度只认它，renderer 自己的钟不作数。 */
  sampleAt: number | undefined
  /** TTL 计时器：没有任何样本也要到期。 */
  expiryTimer: ReturnType<typeof setTimeout> | undefined
  capture:
    | {
        readonly partial: string
        readonly identity: HeapSnapshotTargetIdentity
        readonly startedAt: number
        readonly used: number
        readonly limit: number
        readonly captureLimitBytes: number
      }
    | undefined
}

function identityOf(ref: HeapSnapshotWindowRef): HeapSnapshotTargetIdentity {
  return {
    windowId: ref.windowId,
    webContentsId: ref.webContentsId,
    pid: ref.pid,
    navigationEpoch: ref.navigationEpoch,
  }
}

function sameIdentity(a: HeapSnapshotTargetIdentity, b: HeapSnapshotTargetIdentity): boolean {
  return (
    a.windowId === b.windowId &&
    a.webContentsId === b.webContentsId &&
    a.pid === b.pid &&
    a.navigationEpoch === b.navigationEpoch
  )
}

function formatIdentity(identity: HeapSnapshotTargetIdentity): string {
  return `window=${identity.windowId} webContents=${identity.webContentsId} pid=${identity.pid} epoch=${identity.navigationEpoch}`
}

function artifactKind(name: string): HeapSnapshotArtifactEntry['kind'] | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith(PARTIAL_SUFFIX)) return 'partial'
  if (lower.endsWith(SNAPSHOT_SUFFIX)) return 'snapshot'
  if (lower.endsWith(META_SUFFIX)) return 'metadata'
  return undefined
}

export class HeapSnapshotController {
  private readonly _dir: string
  private readonly _logger: ILogger | undefined
  private readonly _now: () => number
  private readonly _thresholds: HeapSnapshotThresholds
  private readonly _budget: HeapSnapshotDirectoryBudget
  private readonly _readResources: () => HeapSnapshotResourceReadings
  private readonly _diskFreeBytes: (dir: string) => Promise<number | undefined>
  private readonly _mkdir: (dir: string) => Promise<void>
  private readonly _stallNoticeMs: number
  private readonly _onEvent: ((event: HeapSnapshotEvent) => void) | undefined

  private readonly _rounds = new Map<number, RoundState>()
  /** 全应用唯一真正在飞的抓取/检查。没有队列：忙就等下一轮。 */
  private _inflight: { readonly windowId: number } | undefined
  private _appAttempts = 0
  private _lastCaptureAt: number | undefined
  private _host: HeapSnapshotWindowHost | undefined
  private _disposed = false

  constructor(options: HeapSnapshotControllerOptions) {
    this._dir = options.dir
    this._logger = options.logger
    this._now = options.now ?? (() => Date.now())
    this._thresholds = { ...HEAP_SNAPSHOT_THRESHOLDS, ...options.thresholds }
    this._budget = { ...HEAP_SNAPSHOT_DIR_BUDGET, ...options.budget }
    this._readResources = options.readResources ?? defaultResourceReadings
    this._diskFreeBytes = options.diskFreeBytes ?? defaultDiskFreeBytes
    this._mkdir =
      options.mkdir ?? ((dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined))
    this._stallNoticeMs = options.captureStallNoticeMs ?? HEAP_SNAPSHOT_STALL_NOTICE_MS
    this._onEvent = options.onEvent
  }

  /** 由 main/index.ts 迟到绑定；在那之前解析不到窗口，什么都不会跑。 */
  setWindowHost(host: HeapSnapshotWindowHost | undefined): void {
    this._host = host
  }

  get directory(): string {
    return this._dir
  }

  /**
   * 为一个窗口武装一轮。幂等：已武装的轮次原样返回——重新武装会顺手给用户一份新的尝试
   * 额度，而全应用额度明确规定不因停止再开始而重置。
   */
  start(windowId: number): HeapSnapshotStatus {
    const existing = this._rounds.get(windowId)
    if (existing !== undefined && !existing.stopped) return this.status(windowId)

    // 全应用额度已用完就先拒绝：武装了却在下一个样本上才停，等于先发一份「开始了」的
    // 通知再收回，而用户点的是「开始」。
    if (this._appAttempts >= this._thresholds.maxAttemptsPerApp) {
      return this._refuse(
        windowId,
        'app-quota-exhausted',
        `appAttempts=${this._appAttempts}/${this._thresholds.maxAttemptsPerApp}`,
        existing,
      )
    }

    const ref = this._resolve(windowId)
    if (ref === undefined) {
      return this._refuse(windowId, 'no-target', 'window has no live renderer', existing)
    }
    if (!ref.isRendererAlive()) {
      return this._refuse(
        windowId,
        'renderer-unavailable',
        'the window is open but its renderer is not running',
        existing,
      )
    }

    const now = this._now()
    const identity = identityOf(ref)
    const policy = new HeapSnapshotPolicy(this._thresholds)
    policy.arm(now)
    const round: RoundState = {
      windowId,
      identity,
      armedAt: now,
      expiresAt: now + this._thresholds.roundMaxMs,
      policy,
      attempts: 0,
      artifacts: 0,
      bytes: 0,
      incarnation: undefined,
      stopped: false,
      code: undefined,
      detail: undefined,
      lastNoticeCode: undefined,
      revision: (existing?.revision ?? 0) + 1,
      sampleUsed: 0,
      sampleLimit: 0,
      sampleAt: undefined,
      expiryTimer: undefined,
      capture: undefined,
    }
    this._rounds.set(windowId, round)
    this._armExpiry(round)
    this._logger?.info(`heap-snapshot round armed ${formatIdentity(identity)}`)
    this._emit(round, 'started')
    return this.status(windowId)
  }

  /**
   * 停住后续抓取。已经在跑的那次继续跑，并如实上报。用户主动停止时 `code` 由调用方
   * （命令）回报，所以这里不重复发事件——同一次停止只能有一条通知。
   */
  stop(
    windowId: number,
    code: HeapSnapshotNoticeCode = 'stopped-by-user',
    quiet = true,
  ): HeapSnapshotStatus {
    const round = this._rounds.get(windowId)
    if (round !== undefined && !round.stopped) {
      const inFlight = this._inflight?.windowId === windowId
      this._stop(
        round,
        code,
        inFlight ? 'a capture is in flight' : 'stopped by the user',
        'stopped',
        quiet,
      )
    }
    return this.status(windowId)
  }

  /** reload / close：本轮测量的 renderer 没了，轮次随之结束。 */
  invalidateWindow(windowId: number, reason: 'window-reloaded' | 'window-closed'): void {
    const round = this._rounds.get(windowId)
    if (round === undefined) return
    if (!round.stopped)
      this._stop(round, reason, `${reason} while the round was armed`, 'stopped', false)
    // 关掉的窗口没人再读状态；reload 的窗口还在，要能说出自己的轮次为什么结束了。
    if (reason === 'window-closed') this._rounds.delete(windowId)
  }

  status(windowId: number): HeapSnapshotStatus {
    const round = this._rounds.get(windowId)
    // 没有样本的轮次也必须到期：窗口不再上报时，没有任何东西会再调用策略。
    if (round !== undefined && !round.stopped) this._expire(round)
    const capturing = this._inflight?.windowId === windowId
    const base = {
      attempts: 0,
      attemptLimit: this._thresholds.maxAttemptsPerRound,
      appAttempts: this._appAttempts,
      appAttemptLimit: this._thresholds.maxAttemptsPerApp,
      artifacts: 0,
      bytes: 0,
    }
    if (round === undefined) return { ...base, active: false, phase: 'off' }
    const phase: HeapSnapshotPhase = capturing
      ? 'capturing'
      : round.stopped
        ? 'stopped'
        : round.policy.state.baseline === undefined
          ? 'baseline'
          : 'watching'
    return {
      active: !round.stopped,
      phase,
      startedAt: round.armedAt,
      expiresAt: round.expiresAt,
      attempts: round.attempts,
      attemptLimit: this._thresholds.maxAttemptsPerRound,
      appAttempts: this._appAttempts,
      appAttemptLimit: this._thresholds.maxAttemptsPerApp,
      artifacts: round.artifacts,
      bytes: round.bytes,
      ...(round.code === undefined ? {} : { code: round.code }),
      ...(round.detail === undefined ? {} : { detail: round.detail }),
    }
  }

  /** 喂一个 renderer 样本。只有武装了轮次的窗口才会干活。 */
  reportSample(input: HeapSnapshotSampleInput): void {
    if (this._disposed) return
    const round = this._rounds.get(input.windowId)
    if (round === undefined || round.stopped) return

    // 代次取自活窗口，绝不取自载荷：否则一个比它的 renderer 活得还久的样本（reload 期间
    // 的 IPC 延迟）会被算到接替它的那个 renderer 头上。
    const ref = this._resolve(input.windowId)
    if (ref === undefined) {
      this._stop(round, 'window-closed', 'the window is gone', 'stopped', false)
      return
    }
    if (!ref.isRendererAlive()) {
      this._stop(
        round,
        'renderer-unavailable',
        'the renderer is gone but the window is open',
        'stopped',
        false,
      )
      return
    }
    const epoch = ref.navigationEpoch
    if (epoch !== round.identity.navigationEpoch) {
      this._stop(
        round,
        'window-reloaded',
        `epoch=${epoch} armedEpoch=${round.identity.navigationEpoch}`,
        'stopped',
        false,
      )
      return
    }
    // 同一导航代次下出现第二个 incarnation 不可能是新 renderer（起一个新的必然伴随导航），
    // 只能是那个已经消失的帧发来的样本。
    if (
      round.incarnation !== undefined &&
      input.incarnation !== undefined &&
      round.incarnation !== input.incarnation
    ) {
      this._logger?.info(
        `heap-snapshot dropped a sample from a superseded renderer window=${input.windowId}`,
      )
      return
    }
    if (round.incarnation === undefined) round.incarnation = input.incarnation

    round.sampleUsed = input.used
    round.sampleLimit = input.limit
    // main 的接收时间，不是 renderer 自报的时间：新鲜度是「我们多久没听到它」。
    round.sampleAt = input.at
    const decision = round.policy.observe({
      now: this._now(),
      sample: {
        at: input.at,
        used: input.used,
        limit: input.limit,
        holdersBytes: input.holdersBytes,
      },
      attemptsThisRound: round.attempts,
      appAttempts: this._appAttempts,
      lastCaptureAt: this._lastCaptureAt,
      captureInFlight: this._inflight !== undefined,
    })

    switch (decision.kind) {
      case 'wait':
        return
      case 'blocked':
        this._notice(round, decision.code, decision.detail)
        return
      case 'stop':
        this._stop(round, decision.code, decision.detail, 'stopped', false)
        return
      case 'capture':
        void this._runCapture(round, decision.trigger, decision.detail)
    }
  }

  /** 有界的由新到旧列表；上一轮遗留的产物标为未完成。 */
  async listArtifacts(limit = MANIFEST_LIMIT): Promise<HeapSnapshotArtifactEntry[]> {
    return (await this._scanDirectory()).entries.slice(0, limit)
  }

  /**
   * 目录读不出来的两种情况必须分开：`ENOENT` 是「还没有快照」（全新安装），其余错误是
   * 「读不到」——把它当成空目录会让预算闸门失效，一份读不出来的目录里可能正堆着几 GB。
   */
  private async _scanDirectory(): Promise<{
    readonly readable: boolean
    readonly entries: HeapSnapshotArtifactEntry[]
  }> {
    let names: string[]
    try {
      names = await fs.readdir(this._dir)
    } catch (err) {
      return { readable: (err as NodeJS.ErrnoException).code === 'ENOENT', entries: [] }
    }
    const entries: HeapSnapshotArtifactEntry[] = []
    for (const name of names.slice(0, DIRECTORY_SCAN_LIMIT)) {
      const kind = artifactKind(name)
      if (kind === undefined) continue
      const stat = await fs.stat(join(this._dir, name)).catch(() => null)
      if (!stat || !stat.isFile()) continue
      entries.push({
        name,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        kind,
        incomplete: kind === 'partial',
      })
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return { readable: true, entries }
  }

  /** 诊断 zip 随包发的清单，替代快照本身。 */
  async formatManifest(): Promise<string> {
    const scan = await this._scanDirectory()
    if (!scan.readable) return '(the snapshot directory could not be read)\n'
    const entries = scan.entries.slice(0, MANIFEST_LIMIT)
    if (entries.length === 0) return '(no heap snapshots)\n'
    const lines = [
      `heap snapshots in ${this._dir} (${entries.length} newest entries; bytes only, no content is included in this zip)`,
      `budget: ${describeBytes(this._budget.maxBytes)} / ${this._budget.maxArtifacts} artifacts`,
    ]
    for (const entry of entries) {
      const state = entry.incomplete ? ' incomplete' : ''
      lines.push(
        `  ${new Date(entry.mtimeMs).toISOString()}  ${describeBytes(entry.bytes).padStart(7)}  ${entry.kind}${state}  ${entry.name}`,
      )
    }
    return `${lines.join('\n')}\n`
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    for (const round of this._rounds.values()) {
      if (round.expiryTimer !== undefined) clearTimeout(round.expiryTimer)
      round.policy.disarm()
    }
    this._rounds.clear()
  }

  private _resolve(windowId: number): HeapSnapshotWindowRef | undefined {
    const ref = this._host?.resolve(windowId)
    return ref !== undefined && ref.isAlive() ? ref : undefined
  }

  private _stoppedRound(
    windowId: number,
    code: HeapSnapshotNoticeCode,
    detail: string,
  ): RoundState {
    return {
      windowId,
      identity: { windowId, webContentsId: 0, pid: 0, navigationEpoch: 0 },
      armedAt: this._now(),
      expiresAt: this._now(),
      policy: new HeapSnapshotPolicy(this._thresholds),
      attempts: 0,
      artifacts: 0,
      bytes: 0,
      incarnation: undefined,
      stopped: true,
      code,
      detail,
      lastNoticeCode: code,
      revision: (this._rounds.get(windowId)?.revision ?? 0) + 1,
      sampleUsed: 0,
      sampleLimit: 0,
      sampleAt: undefined,
      expiryTimer: undefined,
      capture: undefined,
    }
  }

  /** 立即拒绝一次开始：状态留下、事件发一条，用户看到的是「没开始，因为…」。 */
  private _refuse(
    windowId: number,
    code: HeapSnapshotNoticeCode,
    detail: string,
    previous: RoundState | undefined,
  ): HeapSnapshotStatus {
    const round = this._stoppedRound(windowId, code, detail)
    if (previous === undefined) this._rounds.set(windowId, round)
    else this._rounds.set(windowId, { ...round, revision: previous.revision + 1 })
    this._emit(this._rounds.get(windowId) as RoundState, 'stopped', { code, detail })
    return this.status(windowId)
  }

  /** 无样本也必须到期：窗口停止上报时，不会再有样本把轮次推到策略的时限上。 */
  private _armExpiry(round: RoundState, floorMs = 0): void {
    if (this._disposed) return
    const delay = Math.max(floorMs, round.expiresAt - this._now())
    round.expiryTimer = setTimeout(() => {
      round.expiryTimer = undefined
      this._deadlineReached(round)
    }, delay)
    round.expiryTimer.unref()
  }

  /**
   * 计时器走的是单调钟，时限判的是墙钟：系统时间被回拨时，计时器会在墙钟走到 `expiresAt`
   * 之前就已经到期。此时不能就这么算了——窗口不再上报、也没人查状态时，再不会有任何东西
   * 来结束这一轮。按剩下的墙钟时间重新武装；只有 `now < expiresAt` 才会走到这里，所以重算
   * 出的间隔恒为正（`floorMs` 再兜住时钟被冻住时的空转），不会是无限 0 间隔计时器。
   */
  private _deadlineReached(round: RoundState): void {
    if (this._disposed || round.stopped) return
    if (this._rounds.get(round.windowId) !== round) return
    if (this._now() < round.expiresAt) {
      this._armExpiry(round, EXPIRY_REARM_FLOOR_MS)
      return
    }
    this._expire(round)
  }

  private _expire(round: RoundState): void {
    if (this._disposed || round.stopped) return
    // 已被新一轮顶替的旧轮次不得宣告任何事：它的报告只会污染新轮次的通知。
    if (this._rounds.get(round.windowId) !== round) return
    if (this._now() < round.expiresAt) return
    this._stop(
      round,
      'round-expired',
      `armed=${Math.round((this._now() - round.armedAt) / 60_000)}min`,
      'stopped',
      false,
    )
  }

  private async _runCapture(
    round: RoundState,
    trigger: HeapSnapshotTrigger,
    decisionDetail: string,
  ): Promise<void> {
    if (this._inflight !== undefined) return
    this._inflight = { windowId: round.windowId }
    try {
      // 目录还装得下才写：预算是硬停止，由用户手动清理，绝不替用户删东西。
      const budget = await this._checkBudget(round)
      if (!budget.ok) return

      const admission = await this._checkResources(round)
      if (!admission.verdict.ok) {
        this._notice(round, admission.verdict.code, admission.verdict.detail)
        return
      }

      const pre = this._revalidate(round, trigger)
      if (pre === undefined) return

      await this._mkdir(this._dir)

      // mkdir 也是一次 await（慢盘上可能比整个准入检查还久）：调用之前复核一遍，调用之后再复核
      // 一遍，并重读一次内存余量。身份/窗口/时限出问题 → 结束轮次；样本过期或读数变差 → 只拦住
      // 这一次抓取，轮次仍会在下个样本上重新判断。
      const ref = this._revalidate(round, trigger)
      if (ref === undefined) return
      const final = evaluateCaptureResources({
        resources: this._readResources(),
        diskFreeBytes: admission.diskFreeBytes,
        usedBytes: round.sampleUsed,
      })
      if (!final.ok) {
        this._notice(round, final.code, final.detail)
        return
      }

      const captureLimitBytes = ref.captureLimitBytes
      const identity = identityOf(ref.ref)
      const startedAt = this._now()
      const partial = join(this._dir, this._partialName(round, trigger, startedAt))

      // 额度先扣再调用，失败的抓取同样算数：预算约束的是冻结次数，没产出东西的冻结也是冻结。
      this._appAttempts++
      round.attempts++
      round.capture = {
        partial,
        identity,
        startedAt,
        used: round.sampleUsed,
        limit: round.sampleLimit,
        captureLimitBytes,
      }

      const stall = setTimeout(() => {
        // 是提示，不是取消：没有取消 API，谎称取消会让用户以为冻结已经结束。旧轮次的提示
        // 不能落到新轮次上。
        if (round.stopped || !this._isCurrentRound(round)) return
        this._emit(round, 'notice', {
          code: 'capture-stalled',
          detail: `elapsed=${Math.round(this._stallNoticeMs / 1000)}s trigger=${trigger}`,
        })
      }, this._stallNoticeMs)

      // 间隔时钟从冻结开始算，不是从武装算：规则约束的是单位时间内被冻结的 renderer，
      // 而下面的收尾在几 GB 的产物上会花不少时间。
      this._lastCaptureAt = startedAt
      let failure: unknown
      try {
        await ref.ref.takeHeapSnapshot(partial)
      } catch (err) {
        failure = err
      } finally {
        clearTimeout(stall)
      }

      const durationMs = this._now() - startedAt
      if (failure !== undefined) {
        await this._discardOwnPartial(round, partial)
        this._fail(
          round,
          'capture-failed',
          `trigger=${trigger} duration=${Math.round(durationMs / 1000)}s`,
        )
        return
      }

      // await 之后再审一次身份：抓取期间 reload 或关闭，意味着这份文件描述的 renderer
      // 已经没人有了。
      const after = this._resolve(round.windowId)
      if (after === undefined || !sameIdentity(identityOf(after), identity)) {
        await this._discardOwnPartial(round, partial)
        const after = this._resolve(round.windowId)
        const gone = after === undefined
        this._stop(
          round,
          gone
            ? 'window-closed'
            : after.isRendererAlive()
              ? 'window-reloaded'
              : 'renderer-unavailable',
          'the target changed during the capture',
          'stopped',
          false,
        )
        return
      }

      const stat = await fs.stat(partial).catch(() => null)
      if (!stat || stat.size <= 0) {
        await this._discardOwnPartial(round, partial)
        this._fail(round, 'capture-failed', `trigger=${trigger} bytes=0`)
        return
      }

      const finalPath = partial.slice(0, -'.partial'.length)
      try {
        await fs.rename(partial, finalPath)
      } catch (err) {
        await this._discardOwnPartial(round, partial)
        this._fail(
          round,
          'capture-failed',
          `rename failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }

      const artifacts = round.artifacts + 1
      const bytes = round.bytes + stat.size
      const name = finalPath.slice(this._dir.length + 1)
      const attempt = round.capture
      await this._writeMetadata(name, {
        trigger,
        identity,
        startedAt,
        durationMs,
        used: attempt.used,
        limit: attempt.limit,
        captureLimitBytes,
        bytes: stat.size,
        status: 'complete',
      })
      round.capture = undefined
      round.artifacts = artifacts
      round.bytes = bytes
      if (trigger === 'baseline') {
        round.policy.markBaselineCaptured(this._now(), round.sampleUsed)
      }
      this._logger?.info(
        `heap-snapshot captured trigger=${trigger} ${formatIdentity(identity)} bytes=${stat.size} duration=${Math.round(durationMs / 1000)}s decision=${decisionDetail}`,
      )
      this._emit(round, 'captured', {
        artifact: { name, bytes: stat.size, trigger },
        detail: `duration=${Math.round(durationMs / 1000)}s`,
      })

      if (trigger === 'growth') {
        this._stop(
          round,
          'round-complete',
          'baseline and growth snapshots are on disk',
          'stopped',
          false,
        )
        return
      }
      // 一轮的第二次尝试就是抓增长；基线之后额度用尽，说明这轮结束了，而不是再等一次
      // 抓不出来的抓取。
      if (round.attempts >= this._thresholds.maxAttemptsPerRound) {
        this._stop(
          round,
          'round-quota-exhausted',
          `attempts=${round.attempts}/${this._thresholds.maxAttemptsPerRound}`,
          'stopped',
          false,
        )
      }
    } catch (err) {
      this._fail(
        round,
        'capture-failed',
        `unexpected: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      this._inflight = undefined
    }
  }

  /**
   * 每一次 await 之后、真正调用之前都要走一遍：轮次还在不在、时限到没到、目标还是不是
   * 那个 renderer、样本还新不新、堆上限允许抓多大。身份/时限问题终结轮次（那个堆已经
   * 没人有了），样本过期只拦住这一次抓取——窗口暂停上报不等于诊断出错。
   */
  private _revalidate(
    round: RoundState,
    trigger: HeapSnapshotTrigger,
  ): { readonly ref: HeapSnapshotWindowRef; readonly captureLimitBytes: number } | undefined {
    if (this._disposed || round.stopped) return undefined
    const now = this._now()
    if (now > round.expiresAt) {
      this._stop(
        round,
        'round-expired',
        `armed=${Math.round((now - round.armedAt) / 60_000)}min`,
        'stopped',
        false,
      )
      return undefined
    }
    const ref = this._resolve(round.windowId)
    if (ref === undefined) {
      this._stop(round, 'window-closed', 'the window is gone', 'stopped', false)
      return undefined
    }
    if (!ref.isRendererAlive()) {
      this._stop(
        round,
        'renderer-unavailable',
        'the renderer is gone but the window is open',
        'stopped',
        false,
      )
      return undefined
    }
    if (!sameIdentity(identityOf(ref), round.identity)) {
      this._stop(
        round,
        'window-reloaded',
        'the renderer was replaced while checking resources',
        'stopped',
        false,
      )
      return undefined
    }
    const sampleAt = round.sampleAt
    if (sampleAt === undefined || now - sampleAt > this._thresholds.sampleFreshMs) {
      this._notice(
        round,
        'sample-stale',
        `age=${sampleAt === undefined ? 'none' : `${Math.round((now - sampleAt) / 1000)}s`} fresh=${Math.round(this._thresholds.sampleFreshMs / 1000)}s`,
      )
      return undefined
    }
    // 上限按**此刻**的读数重算：决策是在上一个样本上做出的，等待期间样本可能又变了。
    const limit = captureLimitFor(round.sampleLimit, this._thresholds)
    if (limit === undefined) {
      this._notice(round, 'heap-limit-unknown', `limit=${describeBytes(round.sampleLimit)}`)
      return undefined
    }
    const captureLimitBytes =
      trigger === 'baseline' ? Math.min(this._thresholds.baselineMaxBytes, limit / 2) : limit
    if (round.sampleUsed > captureLimitBytes) {
      this._notice(
        round,
        trigger === 'baseline' ? 'baseline-too-large' : 'heap-too-large',
        `used=${describeBytes(round.sampleUsed)} captureLimit=${describeBytes(captureLimitBytes)}`,
      )
      return undefined
    }
    return { ref, captureLimitBytes }
  }

  private async _checkBudget(round: RoundState): Promise<{ readonly ok: boolean }> {
    const scan = await this._scanDirectory()
    if (!scan.readable) {
      // 读不到目录就不知道里面堆了多少，此时「装得下」是猜的，而猜错要占满用户的磁盘。
      this._notice(round, 'disk-unknown', 'the snapshot directory could not be read')
      return { ok: false }
    }
    const entries = scan.entries
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    // 估算故意用活堆大小：快照是它的很大一部分，早一点停下一个产物，好过占满用户机器
    // 上别的用途要用的磁盘。
    const estimate = round.sampleUsed
    if (
      entries.length >= this._budget.maxArtifacts ||
      bytes >= this._budget.maxBytes ||
      bytes + estimate > this._budget.maxBytes
    ) {
      this._stop(
        round,
        'directory-budget',
        `artifacts=${entries.length}/${this._budget.maxArtifacts} bytes=${describeBytes(bytes)} budget=${describeBytes(this._budget.maxBytes)} newEstimate=${describeBytes(estimate)}`,
        'stopped',
        false,
      )
      return { ok: false }
    }
    return { ok: true }
  }

  /** 磁盘读数要留给最后一次复核，所以连它一起返回。 */
  private async _checkResources(round: RoundState): Promise<{
    readonly verdict: HeapSnapshotResourceVerdict
    readonly diskFreeBytes: number | undefined
  }> {
    const diskFreeBytes = await this._diskFreeBytes(this._dir)
    return { verdict: this._evaluateResources(round, diskFreeBytes), diskFreeBytes }
  }

  private _evaluateResources(
    round: RoundState,
    diskFreeBytes: number | undefined,
  ): HeapSnapshotResourceVerdict {
    return evaluateCaptureResources({
      resources: this._readResources(),
      diskFreeBytes,
      usedBytes: round.sampleUsed,
    })
  }

  private _partialName(round: RoundState, trigger: HeapSnapshotTrigger, at: number): string {
    const stamp = new Date(at).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return `heap-${trigger}-w${round.windowId}-${stamp}${PARTIAL_SUFFIX}`
  }

  /** 只删本次尝试自己写的 partial，且只在它没能成为快照之后。 */
  private async _discardOwnPartial(round: RoundState, partial: string): Promise<void> {
    if (round.capture?.partial !== partial) return
    round.capture = undefined
    await fs.unlink(partial).catch(() => undefined)
  }

  private async _writeMetadata(
    snapshotName: string,
    meta: {
      readonly trigger: HeapSnapshotTrigger
      readonly identity: HeapSnapshotTargetIdentity
      readonly startedAt: number
      readonly durationMs: number
      readonly used: number
      readonly limit: number
      readonly captureLimitBytes: number
      readonly bytes: number
      readonly status: 'complete'
    },
  ): Promise<void> {
    const sidecar = join(
      this._dir,
      `${snapshotName.slice(0, -SNAPSHOT_SUFFIX.length)}${META_SUFFIX}`,
    )
    const payload = {
      trigger: meta.trigger,
      windowId: meta.identity.windowId,
      webContentsId: meta.identity.webContentsId,
      pid: meta.identity.pid,
      navigationEpoch: meta.identity.navigationEpoch,
      usedBytes: meta.used,
      heapLimitBytes: meta.limit,
      captureLimitBytes: meta.captureLimitBytes,
      snapshotBytes: meta.bytes,
      startedAt: new Date(meta.startedAt).toISOString(),
      durationMs: meta.durationMs,
      status: meta.status,
    }
    try {
      await fs.writeFile(sidecar, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch (err) {
      // 快照是重建不出来的产物；元数据只是背景。
      this._logger?.warn(
        `heap-snapshot metadata write failed for ${snapshotName}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private _notice(round: RoundState, code: HeapSnapshotNoticeCode, detail: string): void {
    if (round.stopped) return
    // 按 code 折叠：有压力的窗口每个样本都报同一理由，每个理由一行才分得清「持续状态」
    // 和「来回抖」。
    if (round.lastNoticeCode === code) return
    round.lastNoticeCode = code
    this._logger?.info(
      `heap-snapshot skipped code=${code} ${formatIdentity(round.identity)} ${detail}`,
    )
    this._emit(round, 'notice', { code, detail })
  }

  private _fail(round: RoundState, code: HeapSnapshotNoticeCode, detail: string): void {
    round.capture = undefined
    this._logger?.warn(
      `heap-snapshot attempt failed code=${code} ${formatIdentity(round.identity)} ${detail}`,
    )
    // 只发一个事件，不发两个：失败*就是*这轮的结束（再重复一次等于重复冻结），所以报成
    // 失败，而不是「失败 + 结束」让用户读两遍。
    this._stop(round, code, detail, 'failed', false)
  }

  private _stop(
    round: RoundState,
    code: HeapSnapshotNoticeCode,
    detail: string,
    kind: 'stopped' | 'failed' = 'stopped',
    quiet = false,
  ): void {
    if (round.stopped) return
    round.stopped = true
    round.code = code
    round.detail = detail
    round.policy.disarm()
    if (round.expiryTimer !== undefined) {
      clearTimeout(round.expiryTimer)
      round.expiryTimer = undefined
    }
    this._logger?.info(
      `heap-snapshot round stopped code=${code} ${formatIdentity(round.identity)} ${detail}`,
    )
    // quiet：调用方（停止命令）自己回报这次停止，同一次停止只能有一条通知。
    if (!quiet) this._emit(round, kind, { code, detail })
  }

  /** 还是不是这个窗口当前的那一轮。旧轮次的迟到报告一律不进事件流，只进日志。 */
  private _isCurrentRound(round: RoundState): boolean {
    return this._rounds.get(round.windowId) === round
  }

  private _emit(
    round: RoundState,
    kind: HeapSnapshotEventKind,
    extra?: {
      readonly code?: HeapSnapshotNoticeCode
      readonly detail?: string
      readonly artifact?: HeapSnapshotArtifactInfo
    },
  ): void {
    if (this._onEvent === undefined) return
    if (!this._isCurrentRound(round)) {
      // 被顶替的轮次（停止后重新武装、reload 后新一轮）的报告若发出去，会盖在新轮次上。
      this._logger?.info(
        `heap-snapshot dropped a report from a superseded round kind=${kind} window=${round.windowId}`,
      )
      return
    }
    round.revision += 1
    this._onEvent({
      windowId: round.windowId,
      revision: round.revision,
      at: this._now(),
      kind,
      ...(extra?.code === undefined ? {} : { code: extra.code }),
      ...(extra?.detail === undefined ? {} : { detail: extra.detail }),
      ...(extra?.artifact === undefined ? {} : { artifact: extra.artifact }),
    })
  }
}

/**
 * 物理内存**现读**，不取采样器缓存：采样器缓存的是 commit 那一刻的伴随读数，两次读数之间
 * 可能隔了一分钟，拿过期的空闲数当现在正好会在最不该猜的时候猜。commit 是另一回事——它是
 * 一个需要起进程去问的读数，共用同一份缓存，且状态里带着年龄，`stale` / `unknown` 一律拒绝。
 */
function defaultResourceReadings(): HeapSnapshotResourceReadings {
  let availablePhysicalBytes: number | undefined
  try {
    availablePhysicalBytes = freemem()
  } catch {
    availablePhysicalBytes = undefined
  }
  const sample = getSharedSystemMemorySampler().ensureFresh()
  return {
    availablePhysicalBytes,
    commitStatus: sample.status,
    commitHeadroomBytes: sample.commit?.commitHeadroomBytes,
    commitAgeMs: sample.ageMs,
  }
}

/**
 * 快照所在卷的空闲字节。目录本身是**第一次成功抓取时**才建的（`mkdir` 在抓取路径里），
 * 所以全新安装上它并不存在——而 `statfs` 对不存在的路径抛 ENOENT，`undefined` 会被闸门
 * 读成 `disk-unknown` 并拒绝掉**第一次**快照，此后永远拒绝：目录只能由一次成功的抓取创造。
 * 因此往上找到最近一个存在的祖先再 statfs：卷还是那个卷，装快照的目录在不在不改变答案。
 */
export async function diskFreeBytesFor(dir: string): Promise<number | undefined> {
  let current = dir
  for (;;) {
    try {
      const stats = await fs.statfs(current)
      return stats.bavail * stats.bsize
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

const defaultDiskFreeBytes = diskFreeBytesFor
