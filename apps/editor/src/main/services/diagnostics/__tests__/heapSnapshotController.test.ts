/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/diagnostics/heapSnapshotController.ts
 *  真正被测的是围绕一个不可取消 API 的编排：谁可以抓、目标窗口在 promise 还在飞时被替换会
 *  怎样、一次尝试允许删哪个文件、停止后的轮次允许声称什么。冻结本身在这里是 main 侧的虚构
 *  （假 `takeHeapSnapshot` 只写几个字节），所以断言全都落在决策、文件和报告上。
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fs, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { HeapSnapshotEvent } from '../../../../shared/ipc/services.js'
import {
  HEAP_SNAPSHOT_DIR_BUDGET,
  HeapSnapshotController,
  diskFreeBytesFor,
  evaluateCaptureResources,
  type HeapSnapshotResourceReadings,
} from '../heapSnapshotController.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const LIMIT = 4 * GIB
const BASELINE = 200 * MIB
const CAPTURE_NAME = '.heapsnapshot'

const PLENTY: HeapSnapshotResourceReadings = {
  availablePhysicalBytes: 16 * GIB,
  commitStatus: 'ok',
  commitHeadroomBytes: 16 * GIB,
  commitAgeMs: 1_000,
}

class FakeClock {
  now = 1_700_000_000_000
  advance(ms: number): void {
    this.now += ms
  }
}

/**
 * 一个 renderer。`hold` 让抓取 promise 挂着，好让测试在 main 以为抓取还在跑的时候动手——
 * 这里的每条硬要求都发生在这种情形下。
 */
class FakeWindow {
  readonly calls: string[] = []
  alive = true
  /** 窗口还在，但渲染进程崩了：`alive` 不动，这个变 false。 */
  rendererAlive = true
  epoch = 1
  readonly pid: number
  behavior: 'write' | 'fail' | 'empty' = 'write'
  hold = false
  /** 抓取被调用且文件已写下之后为真。 */
  captureStarted = false
  private readonly _releases: Array<() => void> = []
  private readonly _startWaiters: Array<() => void> = []

  constructor(readonly windowId: number) {
    this.pid = 4000 + windowId
  }

  get ref() {
    return {
      windowId: this.windowId,
      webContentsId: this.windowId * 10,
      pid: this.pid,
      navigationEpoch: this.epoch,
      takeHeapSnapshot: (path: string) => this._take(path),
      isAlive: () => this.alive,
      isRendererAlive: () => this.alive && this.rendererAlive,
    }
  }

  private async _take(path: string): Promise<void> {
    this.calls.push(path)
    // 先写文件再挂起：这样「抓取在飞」就等于「文件已在盘上」，而丢弃规则管的正是这件事。
    await fs.writeFile(path, this.behavior === 'empty' ? '' : 'snapshot-bytes')
    this.captureStarted = true
    for (const waiter of this._startWaiters.splice(0)) waiter()
    if (this.hold) {
      await new Promise<void>((resolve) => this._releases.push(resolve))
    }
    if (this.behavior === 'fail') throw new Error('takeHeapSnapshot failed')
  }

  whenCapturing(): Promise<void> {
    if (this.captureStarted) return Promise.resolve()
    return new Promise<void>((resolve) => this._startWaiters.push(resolve))
  }

  release(): void {
    for (const release of this._releases.splice(0)) release()
  }
}

/** 一个停在 mkdir 上的目录创建：测试要在那一次 await 里动手。 */
class MkdirGate {
  /** 至少被到过一次；`pending` 才是「此刻有一次等待中的 mkdir」。 */
  reached = false
  pending = false
  private _open: ((during: () => void) => void) | undefined

  readonly mkdir = (): Promise<void> =>
    new Promise<void>((resolve) => {
      this.reached = true
      this.pending = true
      this._open = (during) => {
        this.pending = false
        this._open = undefined
        during()
        resolve()
      }
    })

  pass(during?: () => void): void {
    const open = this._open
    if (open === undefined) throw new Error('mkdir was never reached')
    open(during ?? (() => undefined))
  }
}

describe('HeapSnapshotController', () => {
  let dir: string
  let clock: FakeClock
  let events: HeapSnapshotEvent[]
  let windows: Map<number, FakeWindow>
  let controller: HeapSnapshotController
  let resources: HeapSnapshotResourceReadings
  let diskFree: () => Promise<number | undefined>

  beforeEach(() => {
    dir = mkTempDir('heap-snapshot-test-')
    clock = new FakeClock()
    events = []
    windows = new Map()
    resources = PLENTY
    diskFree = () => Promise.resolve(4 * GIB)
    controller = new HeapSnapshotController({
      dir,
      now: () => clock.now,
      // 策略自身的边界由 heapSnapshotPolicy.test.ts 覆盖；这里只要求从武装到抓取的路足够短。
      thresholds: { minArmMs: 0, minCaptureSpacingMs: 0, roundMaxMs: 2 * 60 * 60_000 },
      readResources: () => resources,
      diskFreeBytes: () => diskFree(),
      onEvent: (event) => events.push(event),
    })
    controller.setWindowHost({ resolve: (windowId) => windows.get(windowId)?.ref })
  })

  afterEach(async () => {
    controller.dispose()
    // 用例失败时也可能停在假计时器里；不让它漏给下一个用例。
    vi.useRealTimers()
    await fs.rm(dir, { recursive: true, force: true })
  })

  function addWindow(windowId: number): FakeWindow {
    const window = new FakeWindow(windowId)
    windows.set(windowId, window)
    return window
  }

  /** 换一个带注入缝的控制器（mkdir / 时限），沿用同一个假钟与事件表。 */
  function rebuildController(options: {
    mkdir?: (dir: string) => Promise<void>
    roundMaxMs?: number
  }): void {
    controller.dispose()
    controller = new HeapSnapshotController({
      dir,
      now: () => clock.now,
      thresholds: {
        minArmMs: 0,
        minCaptureSpacingMs: 0,
        ...(options.roundMaxMs === undefined ? {} : { roundMaxMs: options.roundMaxMs }),
      },
      readResources: () => resources,
      diskFreeBytes: () => diskFree(),
      onEvent: (event) => events.push(event),
      ...(options.mkdir === undefined ? {} : { mkdir: options.mkdir }),
    })
    controller.setWindowHost({ resolve: (windowId) => windows.get(windowId)?.ref })
  }

  function files(): string[] {
    return existsSync(dir) ? readdirSync(dir) : []
  }

  function snapshots(): string[] {
    return files().filter((name) => name.endsWith(CAPTURE_NAME))
  }

  function partials(): string[] {
    return files().filter((name) => name.endsWith('.partial'))
  }

  function feed(
    windowId: number,
    used: number,
    options: { afterMs?: number; holdersBytes?: number; incarnation?: string } = {},
  ): void {
    clock.advance(options.afterMs ?? 1_000)
    controller.reportSample({
      windowId,
      at: clock.now,
      used,
      limit: LIMIT,
      holdersBytes: options.holdersBytes ?? 0,
      ...(options.incarnation === undefined ? {} : { incarnation: options.incarnation }),
    })
  }

  /** 三个平稳样本——按这里的阈值正好构成一次基线。 */
  function feedBaseline(windowId: number, used = BASELINE, incarnation?: string): void {
    for (let i = 0; i < 3; i++) {
      feed(windowId, used, { ...(incarnation === undefined ? {} : { incarnation }) })
    }
  }

  function kinds(): string[] {
    return events.map((event) => `${event.kind}:${event.code ?? ''}`)
  }

  /**
   * 推进真正的宏任务轮次，让文件系统的 I/O 落定。用 `setImmediate` 而不是 `setTimeout`：
   * 有些用例装着假计时器（只假 `setTimeout`），微任务队列推不动 libuv。轮数之外再给一个
   * 墙上时间预算——轮次很快，慢机器上几百轮可能还不够一次磁盘 I/O。
   */
  async function until(condition: () => boolean, turns = 5_000, budgetMs = 2_000): Promise<void> {
    const deadline = Date.now() + budgetMs
    for (let i = 0; i < turns; i++) {
      if (condition()) return
      if (Date.now() >= deadline) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  /**
   * 等一次抓取的收尾真正跑完。判据是单航班锁，不是文件在不在：文件是内核删的，删完那一
   * 刻 promise 的续体还没跑（libuv 的回调在下一个轮次的 poll 阶段），锁和事件都在那之后。
   */
  async function untilLockReleased(windowId: number): Promise<void> {
    await until(() => controller.status(windowId).phase !== 'capturing')
  }

  function lastEvent(): HeapSnapshotEvent {
    const event = events[events.length - 1]
    if (event === undefined) throw new Error('no event was emitted')
    return event
  }

  it('writes a partial, renames it, and records what produced it', async () => {
    const window = addWindow(1)
    expect(controller.start(1)).toMatchObject({ active: true, phase: 'baseline' })

    feedBaseline(1)

    // 快照 rename 早于 sidecar 写入，等完成事件后再读取整套产物。
    await vi.waitFor(() => expect(kinds()).toEqual(['started:', 'captured:']))
    expect(snapshots()).toHaveLength(1)
    // partial 只是中间态，永远不能是产物：列目录的人不该在真名下看到一个写了一半的快照。
    expect(partials()).toEqual([])
    expect(window.calls).toHaveLength(1)
    expect(window.calls[0]?.endsWith('.heapsnapshot.partial')).toBe(true)

    const metaName = files().find((name) => name.endsWith('.json'))
    expect(metaName).toBeDefined()
    const meta = JSON.parse(await fs.readFile(join(dir, metaName as string), 'utf8')) as Record<
      string,
      unknown
    >
    expect(meta).toMatchObject({
      trigger: 'baseline',
      windowId: 1,
      pid: window.pid,
      navigationEpoch: 1,
      status: 'complete',
      heapLimitBytes: LIMIT,
    })
    expect(meta['snapshotBytes']).toBeGreaterThan(0)
    expect(kinds()).toEqual(['started:', 'captured:'])
    expect(controller.status(1)).toMatchObject({
      active: true,
      phase: 'watching',
      attempts: 1,
      artifacts: 1,
      appAttempts: 1,
    })
  })

  it('takes the growth snapshot when a sustained rise follows the baseline', async () => {
    addWindow(1)
    controller.start(1)
    feedBaseline(1)
    await vi.waitFor(() => expect(snapshots()).toHaveLength(1))

    // 抓取会把堆推进一次回收，所以参照点是之后的谷底——拿基线本身当参照，会把回升报成增长。
    feed(1, 150 * MIB)
    for (let i = 0; i < 3; i++) feed(1, 600 * MIB, { afterMs: 30_000 })

    await vi.waitFor(() => expect(snapshots()).toHaveLength(2))
    expect(controller.status(1)).toMatchObject({
      active: false,
      phase: 'stopped',
      attempts: 2,
      artifacts: 2,
      code: 'round-complete',
    })
  })

  it('spends the attempt before the call, so a failure still consumed it', async () => {
    const window = addWindow(1)
    window.behavior = 'fail'
    controller.start(1)
    feedBaseline(1)

    await vi.waitFor(() => expect(lastEvent().kind).toBe('failed'))
    expect(controller.status(1)).toMatchObject({
      active: false,
      phase: 'stopped',
      attempts: 1,
      appAttempts: 1,
      code: 'capture-failed',
    })
    // 没产出东西的冻结也是冻结。
    expect(window.calls).toHaveLength(1)
    expect(partials()).toEqual([])

    // 轮次随失败结束：下个样本不会再冻一次。
    feedBaseline(1)
    expect(window.calls).toHaveLength(1)
  })

  it('reports a stop during a capture as still running, and keeps the artifact', async () => {
    const window = addWindow(1)
    window.hold = true
    controller.start(1)
    feedBaseline(1)
    await window.whenCapturing()

    expect(controller.stop(1)).toMatchObject({ active: false, phase: 'capturing' })
    window.release()
    await vi.waitFor(() => expect(snapshots()).toHaveLength(1))

    // 没有取消 API：已经付过冻结代价的文件要留下，停止只能说「不再抓」，绝不能说
    // 「正在跑的那次已取消」。
    expect(controller.status(1).code).toBe('stopped-by-user')
    window.behavior = 'write'
    feedBaseline(1)
    expect(window.calls).toHaveLength(1)
  })

  it('never starts a capture when the round was stopped while resources were checked', async () => {
    const window = addWindow(1)
    let releaseDisk: (() => void) | undefined
    diskFree = () =>
      new Promise<number | undefined>((resolve) => {
        releaseDisk = () => resolve(4 * GIB)
      })
    controller.start(1)
    feedBaseline(1)

    controller.stop(1)
    releaseDisk?.()
    await new Promise((resolve) => setImmediate(resolve))

    expect(window.calls).toEqual([])
    expect(files()).toEqual([])
  })

  it('stops a round whose window is gone while the directory is being created', async () => {
    // mkdir 是调用之前的最后一次 await：停止、换 renderer、时限都可能落在这一段里，而
    // `takeHeapSnapshot` 一旦发出就收不回来。
    const window = addWindow(1)
    const gate = new MkdirGate()
    rebuildController({ mkdir: gate.mkdir })
    controller.start(1)
    feedBaseline(1)
    await vi.waitFor(() => expect(gate.pending).toBe(true))

    gate.pass(() => (window.alive = false))
    await new Promise((resolve) => setImmediate(resolve))

    expect(window.calls).toEqual([])
    expect(controller.status(1).code).toBe('window-closed')
  })

  it('drops a capture whose renderer was replaced while the directory was being created', async () => {
    const window = addWindow(1)
    const gate = new MkdirGate()
    rebuildController({ mkdir: gate.mkdir })
    controller.start(1)
    feedBaseline(1)
    await vi.waitFor(() => expect(gate.pending).toBe(true))

    gate.pass(() => {
      window.epoch += 1
      controller.invalidateWindow(1, 'window-reloaded')
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(window.calls).toEqual([])
    expect(controller.status(1).code).toBe('window-reloaded')
  })

  it('does not capture a round that hit its deadline while the directory was being created', async () => {
    const window = addWindow(1)
    const gate = new MkdirGate()
    rebuildController({ mkdir: gate.mkdir, roundMaxMs: 30_000 })
    controller.start(1)
    feedBaseline(1)
    await vi.waitFor(() => expect(gate.pending).toBe(true))

    gate.pass(() => clock.advance(30_001))
    await new Promise((resolve) => setImmediate(resolve))

    expect(window.calls).toEqual([])
    expect(controller.status(1).code).toBe('round-expired')
  })

  it('does not capture a sample that went stale while the directory was being created', async () => {
    const window = addWindow(1)
    const gate = new MkdirGate()
    rebuildController({ mkdir: gate.mkdir })
    controller.start(1)
    feedBaseline(1)
    await vi.waitFor(() => expect(gate.pending).toBe(true))

    // 磁盘/目录这一步拖了 46 秒：决策用的样本已经过了 45 秒新鲜线。
    gate.pass(() => clock.advance(46_000))
    await new Promise((resolve) => setImmediate(resolve))

    expect(window.calls).toEqual([])
    expect(kinds()).toContain('notice:sample-stale')
    // 窗口暂停上报不等于诊断出错：只是不抓这一次，轮次继续。
    expect(controller.status(1).active).toBe(true)

    // 下个新鲜样本照常能抓（目录创建那一步照旧会再走一次）。
    feed(1, BASELINE)
    await vi.waitFor(() => expect(gate.pending).toBe(true))
    gate.pass()
    await vi.waitFor(() => expect(snapshots()).toHaveLength(1))
  })

  it('re-reads the memory reading after the waits and refuses if it went bad', async () => {
    const window = addWindow(1)
    const gate = new MkdirGate()
    rebuildController({ mkdir: gate.mkdir })
    controller.start(1)
    feedBaseline(1)
    await vi.waitFor(() => expect(gate.pending).toBe(true))

    gate.pass(() => {
      resources = { ...PLENTY, commitStatus: 'unknown', commitHeadroomBytes: undefined }
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(window.calls).toEqual([])
    expect(kinds()).toContain('notice:commit-unknown')
    expect(controller.status(1).active).toBe(true)
  })

  it('refuses to capture when the snapshot directory cannot be read', async () => {
    const window = addWindow(1)
    const spy = vi
      .spyOn(fs, 'readdir')
      .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    try {
      controller.start(1)
      feedBaseline(1)
      await vi.waitFor(() => expect(kinds()).toContain('notice:disk-unknown'))

      // 读不到目录就不知道里面堆了多少——「装得下」是猜的，而猜错要占满用户的磁盘。
      expect(window.calls).toEqual([])
      expect(controller.status(1).active).toBe(true)
      expect(await controller.formatManifest()).toContain('could not be read')
    } finally {
      spy.mockRestore()
    }
  })

  it('starts a round with no samples and still expires it at the deadline', async () => {
    // 窗口从此不再上报时，没有任何样本会把轮次推到策略的时限上——时限必须自己到期，
    // 否则这一轮会永远显示「进行中」。计时器是真实时间，钟是假钟：先把钟推过线，
    // 再等计时器自己响。
    addWindow(1)
    rebuildController({ roundMaxMs: 500 })
    controller.start(1)
    clock.advance(501)
    await vi.waitFor(() => expect(kinds()).toContain('stopped:round-expired'), { timeout: 2_000 })
    expect(controller.status(1)).toMatchObject({ active: false, code: 'round-expired' })
  })

  it('reports an expired round from a status query even before its timer fires', () => {
    addWindow(1)
    rebuildController({ roundMaxMs: 30_000 })
    controller.start(1)
    clock.advance(30_001)
    // 状态查询也要保守核验：不能等计时器，更不能报一个早就不成立的「进行中」。
    expect(controller.status(1)).toMatchObject({ active: false, code: 'round-expired' })
  })

  it('expires at the deadline itself, with no samples and nobody asking', () => {
    // 假计时器与假钟是同一个时钟：墙钟正好落在时限上。那不是「还差一点」，就是期限本身——
    // 在那一刻返回等于这一轮不会再有第二次响声（没有样本，也没人来查状态），而它必须自己
    // 结束自己。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      addWindow(1)
      rebuildController({ roundMaxMs: 60_000 })
      controller.start(1)

      clock.advance(60_000)
      vi.advanceTimersByTime(60_000)

      expect(kinds()).toContain('stopped:round-expired')
      expect(controller.status(1)).toMatchObject({ active: false, phase: 'stopped' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms the deadline when the system clock was rolled back under the timer', () => {
    // 计时器按单调钟计时，时限按墙钟判定：系统时间被回拨时，计时器会早于 `expiresAt` 到期。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      addWindow(1)
      rebuildController({ roundMaxMs: 60_000 })
      controller.start(1)
      const armedAt = clock.now

      // 假计时器推满 60 秒（计时器到期），墙钟只走到第 50 秒。
      clock.now = armedAt + 50_000
      vi.advanceTimersByTime(60_000)

      // 墙钟还没到时限：这一轮不能被宣告结束，也不能就此了事——没人查状态时，那等于永不结束。
      expect(kinds()).toEqual(['started:'])
      expect(controller.status(1).active).toBe(true)
      // 重新武装了，而且只留一个计时器（响过的那个已经不在）。
      expect(vi.getTimerCount()).toBe(1)

      // 剩下的 10 秒墙钟里不许响：贴着 0 间隔的重试会在这两行之间一路空转。
      clock.now = armedAt + 59_999
      vi.advanceTimersByTime(9_999)
      expect(kinds()).toEqual(['started:'])

      // 墙钟走到时限那一刻就到期——重新武装的是「到期的时刻」，不是「再过一整轮」。
      clock.now = armedAt + 60_000
      vi.advanceTimersByTime(1)
      expect(kinds()).toContain('stopped:round-expired')
      expect(controller.status(1)).toMatchObject({ active: false, code: 'round-expired' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a deadline the wall clock never reaches at a bounded rate', () => {
    // 时钟被冻在时限前 1 毫秒：每次重试都算得出一个正间隔，若按 0 间隔重试，90 秒会变成
    // 几万次回调。数 `_now()` 的调用次数是这里唯一看得见重试密度的东西。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      addWindow(1)
      let reads = 0
      controller.dispose()
      controller = new HeapSnapshotController({
        dir,
        now: () => {
          reads++
          return clock.now
        },
        thresholds: { minArmMs: 0, minCaptureSpacingMs: 0, roundMaxMs: 60_000 },
        readResources: () => resources,
        diskFreeBytes: () => diskFree(),
        onEvent: (event) => events.push(event),
      })
      controller.setWindowHost({ resolve: (windowId) => windows.get(windowId)?.ref })
      controller.start(1)

      clock.now += 60_000 - 1
      reads = 0
      vi.advanceTimersByTime(90_000)

      expect(reads).toBeLessThan(500)
      expect(kinds()).toEqual(['started:'])
      expect(controller.status(1).active).toBe(true)

      // 时钟回到正轨后照常到期。
      clock.now += 1
      vi.advanceTimersByTime(1_000)
      expect(kinds()).toContain('stopped:round-expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards the file when the renderer was replaced mid-capture', async () => {
    const window = addWindow(1)
    window.hold = true
    controller.start(1)
    feedBaseline(1)
    await window.whenCapturing()
    expect(partials()).toHaveLength(1)

    // 一次 reload：窗口不变，renderer 换了。这份文件描述的堆已经没人有了。
    window.epoch += 1
    controller.invalidateWindow(1, 'window-reloaded')
    window.release()

    await vi.waitFor(() => expect(partials()).toEqual([]))
    expect(snapshots()).toEqual([])
    expect(controller.status(1).code).toBe('window-reloaded')
  })

  it('discards an empty capture rather than renaming it', async () => {
    const window = addWindow(1)
    window.behavior = 'empty'
    controller.start(1)
    feedBaseline(1)

    await vi.waitFor(() => expect(lastEvent().kind).toBe('failed'))
    expect(snapshots()).toEqual([])
    expect(partials()).toEqual([])
    expect(controller.status(1).code).toBe('capture-failed')
  })

  it('keeps a reloaded round’s stalled capture from reporting onto the next renderer', async () => {
    // reload 之后没有新的一轮被武装，旧轮次仍是这个窗口「当前」的那一轮：唯一拦得住它
    // 迟到报告的是「它自己已经结束了」。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const first = addWindow(1)
      const second = addWindow(2)
      first.hold = true
      controller.start(1)
      feedBaseline(1)
      await first.whenCapturing()
      expect(partials()).toHaveLength(1)

      first.epoch += 1
      controller.invalidateWindow(1, 'window-reloaded')
      // 结束的通知本身必须发出去：窗口还在，新 renderer 要能说出自己这一轮为什么结束了。
      expect(kinds()).toContain('stopped:window-reloaded')

      controller.start(2)
      feedBaseline(2)
      expect(second.calls).toEqual([])

      // 冻结过了 90 秒（提示的门槛）：旧轮次早已结束，旧 renderer 的抓取不该再说话。
      clock.advance(90_000)
      vi.advanceTimersByTime(90_000)
      expect(kinds()).toEqual(['started:', 'stopped:window-reloaded', 'started:'])

      // 单航班锁也还在旧 promise 手里：它没落定之前谁都不能再抓。
      feedBaseline(2)
      expect(second.calls).toEqual([])

      first.release()
      await untilLockReleased(1)

      // 那份文件描述的 renderer 已经不存在：丢弃，绝不改名留下；迟到的报告一条也不许落到
      // 接替它的 renderer 上。
      expect(partials()).toEqual([])
      expect(snapshots()).toEqual([])
      expect(kinds()).toEqual(['started:', 'stopped:window-reloaded', 'started:'])

      // 锁随 promise 一起落定，新 renderer 的轮次照常抓。
      feedBaseline(2)
      await until(() => snapshots().length === 1)
      expect(snapshots()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a capture failure that crossed a reload instead of blaming the new renderer', async () => {
    const window = addWindow(1)
    window.hold = true
    window.behavior = 'fail'
    controller.start(1)
    feedBaseline(1)
    await window.whenCapturing()

    window.epoch += 1
    controller.invalidateWindow(1, 'window-reloaded')
    window.release()
    await untilLockReleased(1)

    // 失败发生在一次属于旧 renderer 的抓取上：报告它等于让新 renderer 为一次它没做过的
    // 冻结背上失败。轮次结束的理由仍是 reload。
    expect(kinds()).toEqual(['started:', 'stopped:window-reloaded'])
    expect(controller.status(1)).toMatchObject({ active: false, code: 'window-reloaded' })
  })

  it('keeps a late capture from a superseded round out of the new one', async () => {
    const window = addWindow(1)
    window.hold = true
    controller.start(1)
    feedBaseline(1)
    await window.whenCapturing()

    // 旧 promise 还在飞的时候停止并重新武装。
    controller.stop(1)
    controller.start(1)

    feedBaseline(1)
    expect(window.calls).toHaveLength(1)
    window.release()
    await vi.waitFor(() => expect(snapshots()).toHaveLength(1))

    // 文件是上一轮付过冻结代价的产物，留下；但它的报告属于一个已经不存在的轮次，绝不能
    // 发到新轮次的通知流里（新窗口会把它读成自己这一轮的结果）。
    expect(kinds()).not.toContain('captured:')
    expect(events.every((event) => event.windowId === 1)).toBe(true)

    // 新轮次不受影响：仍在武装中，并会用自己的样本抓取。
    expect(controller.status(1)).toMatchObject({ active: true, attempts: 0 })
    // ……而且单航班锁确实随旧 promise 一起释放了。
    window.hold = false
    feedBaseline(1)
    await vi.waitFor(() => expect(snapshots()).toHaveLength(2))
  })

  it('does not reset the app-wide attempt budget when a round is restarted', async () => {
    const window = addWindow(1)
    window.behavior = 'fail'
    controller.start(1)
    feedBaseline(1)
    await vi.waitFor(() => expect(lastEvent().kind).toBe('failed'))
    expect(controller.status(1).appAttempts).toBe(1)

    window.behavior = 'write'
    controller.start(1)
    // 新一轮是对*这个窗口*的新授权，不是新的全应用额度。
    expect(controller.status(1)).toMatchObject({ attempts: 0, appAttempts: 1, active: true })
    feedBaseline(1)
    await vi.waitFor(() => expect(snapshots()).toHaveLength(1))
    expect(controller.status(1).appAttempts).toBe(2)
  })

  it('refuses a start outright once the app-wide budget is spent', async () => {
    const window = addWindow(1)
    window.behavior = 'fail'
    // 失败会结束它那一轮（重试等于重复冻结），所以用完四次尝试要跑四轮——第四次就是最后一次。
    for (let round = 0; round < 4; round++) {
      controller.start(1)
      feedBaseline(1)
      await vi.waitFor(() => expect(lastEvent().kind).toBe('failed'))
    }
    expect(controller.status(1).appAttempts).toBe(4)

    // 第五次开始当场被拒：先武装、再在下一个样本上收回，会先给出「开始了」再改成「没开始」，
    // 而用户点的就是「开始」。
    window.behavior = 'write'
    const refused = controller.start(1)
    expect(refused).toMatchObject({ active: false, code: 'app-quota-exhausted' })
    expect(kinds()).toContain('stopped:app-quota-exhausted')
    feedBaseline(1)
    expect(window.calls).toHaveLength(4)
    expect(snapshots()).toEqual([])
  })

  it('says the renderer is gone rather than the window when the window is still open', () => {
    const window = addWindow(1)
    window.rendererAlive = false
    const status = controller.start(1)
    expect(status).toMatchObject({ active: false, phase: 'stopped', code: 'renderer-unavailable' })
    expect(kinds()).toEqual(['stopped:renderer-unavailable'])
  })

  it('ends a round whose renderer died without claiming the window was closed', async () => {
    const window = addWindow(1)
    controller.start(1)
    feedBaseline(1)
    await vi.waitFor(() => expect(snapshots()).toHaveLength(1))

    window.rendererAlive = false
    feed(1, BASELINE)
    expect(controller.status(1).code).toBe('renderer-unavailable')
    expect(kinds()).not.toContain('stopped:window-closed')
  })

  it('stops the round when the directory is at its budget, before writing anything', async () => {
    const window = addWindow(1)
    for (let i = 0; i < HEAP_SNAPSHOT_DIR_BUDGET.maxArtifacts; i++) {
      await fs.writeFile(join(dir, `heap-baseline-w1-${i}.heapsnapshot`), 'x')
    }
    controller.start(1)
    feedBaseline(1)

    await vi.waitFor(() => expect(controller.status(1).code).toBe('directory-budget'))
    expect(window.calls).toEqual([])
    expect(kinds()).toContain('stopped:directory-budget')
  })

  it('removes only the partial this attempt wrote', async () => {
    const leftover = 'heap-baseline-w1-20260101T000000.heapsnapshot.partial'
    await fs.writeFile(join(dir, leftover), 'interrupted by a previous run')
    const window = addWindow(1)
    window.behavior = 'fail'
    controller.start(1)
    feedBaseline(1)

    await vi.waitFor(() => expect(lastEvent().kind).toBe('failed'))
    expect(partials()).toEqual([leftover])
    // 上一次运行留下的东西：只列出来，绝不删。
    expect(await controller.listArtifacts()).toEqual([
      expect.objectContaining({ name: leftover, incomplete: true, kind: 'partial' }),
    ])
    expect(await controller.formatManifest()).toContain('incomplete')
  })

  it('refuses to capture into a directory it cannot measure', async () => {
    const window = addWindow(1)
    diskFree = () => Promise.resolve(undefined)
    controller.start(1)
    feedBaseline(1)

    await vi.waitFor(() => expect(lastEvent().code).toBe('disk-unknown'))
    expect(window.calls).toEqual([])
    expect(controller.status(1).active).toBe(true)
  })

  it('keeps the single-flight lock while a stalled capture is still out', async () => {
    controller = new HeapSnapshotController({
      dir,
      now: () => clock.now,
      thresholds: { minArmMs: 0, minCaptureSpacingMs: 0 },
      readResources: () => resources,
      diskFreeBytes: () => diskFree(),
      captureStallNoticeMs: 5,
      onEvent: (event) => events.push(event),
    })
    controller.setWindowHost({ resolve: (windowId) => windows.get(windowId)?.ref })

    const first = addWindow(1)
    const second = addWindow(2)
    first.hold = true
    controller.start(1)
    controller.start(2)
    feedBaseline(1)
    await first.whenCapturing()

    // 超时只做一件事：发提示。不解锁，也不抓第二次。
    await vi.waitFor(() =>
      expect(events.some((event) => event.code === 'capture-stalled')).toBe(true),
    )
    expect(controller.status(1).phase).toBe('capturing')
    feedBaseline(2)
    expect(second.calls).toEqual([])

    first.release()
    await vi.waitFor(() => expect(snapshots()).toHaveLength(1))
    feedBaseline(2)
    await vi.waitFor(() => expect(second.calls).toHaveLength(1))
  })

  it('reports a window with no live renderer instead of arming a round', () => {
    const window = addWindow(1)
    window.alive = false
    const status = controller.start(1)
    expect(status).toMatchObject({ active: false, phase: 'stopped', code: 'no-target' })
    expect(kinds()).toEqual(['stopped:no-target'])
  })

  it('ends the round when a sample arrives with a different incarnation', async () => {
    const window = addWindow(1)
    controller.start(1)
    feed(1, BASELINE, { incarnation: 'r-aaa' })
    feed(1, BASELINE, { incarnation: 'r-aaa' })
    // 同一导航代次下的第二次启动不可能是新 renderer，所以这个样本来自已经消失的帧，
    // 不能计入任何东西。
    feed(1, BASELINE, { incarnation: 'r-bbb' })
    expect(window.calls).toEqual([])

    feed(1, BASELINE, { incarnation: 'r-aaa' })
    await vi.waitFor(() => expect(window.calls).toHaveLength(1))
  })

  it('lists artifacts newest first and keeps the manifest content-free', async () => {
    for (let i = 0; i < 40; i++) {
      await fs.writeFile(join(dir, `heap-baseline-w1-20260101T0000${i}.heapsnapshot`), 'x')
      await fs.utimes(
        join(dir, `heap-baseline-w1-20260101T0000${i}.heapsnapshot`),
        1e9 + i,
        1e9 + i,
      )
    }
    const listed = await controller.listArtifacts()
    expect(listed).toHaveLength(32)
    expect(listed[0]?.mtimeMs).toBeGreaterThan(listed[1]?.mtimeMs ?? 0)

    const manifest = await controller.formatManifest()
    expect(manifest).toContain('no content is included')
    expect(manifest.split('\n').length).toBeLessThan(40)
  })

  it('formats a manifest even when the directory does not exist yet', async () => {
    await fs.rm(dir, { recursive: true, force: true })
    expect(await controller.listArtifacts()).toEqual([])
    expect(await controller.formatManifest()).toBe('(no heap snapshots)\n')
  })

  it('is idempotent: re-arming an armed round keeps its budget', () => {
    addWindow(1)
    const first = controller.start(1)
    const second = controller.start(1)
    expect(second.startedAt).toBe(first.startedAt)
    expect(kinds()).toEqual(['started:'])
  })

  it('refuses to treat a stopped round as an armed one twice', () => {
    addWindow(1)
    controller.start(1)
    controller.stop(1)
    controller.stop(1)
    // 停止是调用方（命令）回报的，事件流里只有开局那一条：同一次停止只能有一条通知。
    expect(kinds()).toEqual(['started:'])
    expect(controller.status(1).code).toBe('stopped-by-user')
  })
})

describe('evaluateCaptureResources', () => {
  const used = 512 * MIB

  it('admits a capture when every resource has room for twice the heap', () => {
    expect(
      evaluateCaptureResources({ resources: PLENTY, diskFreeBytes: 4 * GIB, usedBytes: used }),
    ).toEqual({ ok: true })
  })

  it('refuses when free physical memory is missing or short', () => {
    expect(
      evaluateCaptureResources({
        resources: { ...PLENTY, availablePhysicalBytes: undefined },
        diskFreeBytes: 4 * GIB,
        usedBytes: used,
      }),
    ).toMatchObject({ ok: false, code: 'physical-memory-low' })
    expect(
      evaluateCaptureResources({
        resources: { ...PLENTY, availablePhysicalBytes: GIB },
        diskFreeBytes: 4 * GIB,
        usedBytes: used,
      }),
    ).toMatchObject({ ok: false, code: 'physical-memory-low' })
  })

  it('treats a platform without commit accounting as absent, not as pressure', () => {
    expect(
      evaluateCaptureResources({
        resources: { ...PLENTY, commitStatus: 'unsupported', commitHeadroomBytes: undefined },
        diskFreeBytes: 4 * GIB,
        usedBytes: used,
      }),
    ).toEqual({ ok: true })
  })

  it('refuses on a stale or unknown commit reading, and on low headroom', () => {
    expect(
      evaluateCaptureResources({
        resources: { ...PLENTY, commitStatus: 'stale' },
        diskFreeBytes: 4 * GIB,
        usedBytes: used,
      }),
    ).toMatchObject({ ok: false, code: 'commit-unknown' })
    expect(
      evaluateCaptureResources({
        resources: { ...PLENTY, commitStatus: 'unknown', commitHeadroomBytes: undefined },
        diskFreeBytes: 4 * GIB,
        usedBytes: used,
      }),
    ).toMatchObject({ ok: false, code: 'commit-unknown' })
    expect(
      evaluateCaptureResources({
        resources: { ...PLENTY, commitHeadroomBytes: GIB },
        diskFreeBytes: 4 * GIB,
        usedBytes: used,
      }),
    ).toMatchObject({ ok: false, code: 'commit-headroom-low' })
  })

  it('refuses when the disk reading failed or is short', () => {
    expect(
      evaluateCaptureResources({ resources: PLENTY, diskFreeBytes: undefined, usedBytes: used }),
    ).toMatchObject({ ok: false, code: 'disk-unknown' })
    expect(
      evaluateCaptureResources({ resources: PLENTY, diskFreeBytes: 2 * GIB, usedBytes: used }),
    ).toMatchObject({ ok: false, code: 'disk-space-low' })
  })

  it('scales the requirement with the heap when that is the larger term', () => {
    const huge = 4 * GIB
    expect(
      evaluateCaptureResources({
        resources: PLENTY,
        diskFreeBytes: 2 * GIB + 2 * huge - 1,
        usedBytes: huge,
      }),
    ).toMatchObject({ ok: false, code: 'disk-space-low' })
    expect(
      evaluateCaptureResources({
        resources: PLENTY,
        diskFreeBytes: 2 * GIB + 2 * huge,
        usedBytes: huge,
      }),
    ).toEqual({ ok: true })
  })
})

describe('diskFreeBytesFor', () => {
  let base: string

  beforeEach(() => {
    base = mkTempDir('ue-heap-disk-')
  })

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true })
  })

  // The snapshots directory is created by the first successful capture, so the gate
  // normally runs against a path that does not exist. `statfs` on it throws ENOENT,
  // which the gate reads as `disk-unknown` — and that refusal can never be lifted,
  // because only a capture creates the directory. This is a fresh install's state.
  it('answers for a directory that does not exist yet, via its nearest ancestor', async () => {
    const missing = join(base, 'diagnostics', 'heap-snapshots')
    expect(existsSync(missing)).toBe(false)

    // A live volume's free space changes between two readings, so comparing two real reads
    // would be flaky and still prove nothing. The claim here is the walk: every path that
    // cannot be read is retried one level up, and the first reading that lands is the answer.
    const probed: string[] = []
    const answer = 805_066_633_216
    const spy = vi.spyOn(fs, 'statfs').mockImplementation((async (path: string) => {
      probed.push(path)
      if (path !== base) throw new Error('ENOENT')
      return { bavail: answer / 4096, bsize: 4096 }
    }) as unknown as typeof fs.statfs)
    try {
      expect(await diskFreeBytesFor(missing)).toBe(answer)
      expect(probed).toEqual([missing, join(base, 'diagnostics'), base])
    } finally {
      spy.mockRestore()
    }
  })

  it('reports the volume rather than the directory’s own existence', async () => {
    await fs.mkdir(join(base, 'diagnostics'), { recursive: true })
    expect(await diskFreeBytesFor(join(base, 'diagnostics'))).toBeGreaterThan(0)
  })

  it('gives up with undefined when nothing on the path can be read', async () => {
    const spy = vi.spyOn(fs, 'statfs').mockRejectedValue(new Error('ENOENT'))
    try {
      expect(await diskFreeBytesFor(join(base, 'a', 'b'))).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
})
