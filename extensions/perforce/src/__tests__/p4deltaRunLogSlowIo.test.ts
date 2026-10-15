/**
 * `P4deltaRunSession` 的关闭路径：**写在飞时关闭**必须仍然把整条队列串行写完，且只有真正
 * 落定后才 rename。旧实现在 `_finished` 落位后让 `_schedule` 直接 return，于是首个在飞写的
 * 回调无法把后续排队的行接着写下去——队列只能等 `closeTimeoutMs` 超时后由 `appendFileSync`
 * 同步补写，磁盘一卡就堵住 extension host。
 *
 * 这里不掷骰子等磁盘：注入一个可暂停的写盘口，由测试决定「在飞写」何时释放。断言要么是
 * 文件内容 / 存在性，要么是预算计数，没有 sleep 出来的时序假设。
 */
import { appendFile, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import {
  P4DELTA_RUN_LOG_LIMITS,
  P4deltaRunLog,
  type P4deltaRunLogIo,
  type P4deltaRunLogLimits,
} from '../p4delta/p4deltaRunLog.js'

const roots: string[] = []
function makeRoot(): string {
  const root = mkTempDir('ue-p4dlog-slow-')
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) removeDirWithRetry(root)
})

/** 可暂停的写盘口：`hold` 打开时把回调攒进 `held`，测试用 `release()` 决定何时真正落盘。 */
class HeldIo implements P4deltaRunLogIo {
  hold = true
  readonly held: Array<() => void> = []
  append(file: string, text: string, onDone: (err: NodeJS.ErrnoException | null) => void): void {
    const run = (): void => appendFile(file, text, 'utf8', onDone)
    if (this.hold) this.held.push(run)
    else run()
  }
  release(): void {
    this.held.shift()?.()
  }
}

function openLog(io: P4deltaRunLogIo, over: Partial<P4deltaRunLogLimits> = {}): P4deltaRunLog {
  const limits: P4deltaRunLogLimits = {
    ...P4DELTA_RUN_LOG_LIMITS,
    flushIntervalMs: 10_000,
    cleanupThrottleMs: 0,
    ...over,
  }
  const log = P4deltaRunLog.open(makeRoot(), undefined, limits, io)
  if (log === undefined) throw new Error('expected the store to open')
  return log
}

const ID = 'p4d-1-42-1-abcd1234'

describe('P4deltaRunSession: close with a write in flight', () => {
  // 第一个 add 触发的写还在飞时 close 追加 footer：释放它的回调后，队列必须自己接着写完，
  // 而不是等 2 秒超时走同步补写。
  it('drains the whole queue once the in-flight write is released, without waiting out the timeout', async () => {
    const io = new HeldIo()
    const log = openLog(io, { closeTimeoutMs: 60_000 })
    const session = log.beginRun(ID)
    session?.append('body one\n')
    await session?.flushNow(1) // 首写此刻在飞（被 hold 住）
    expect(io.held).toHaveLength(1)

    session?.append('body two\n') // 在飞写的回调释放前，后面又排了一行
    const closing = session?.close('footer line\n')

    // 还没落定：不 rename，也不冒充完成（写在飞，所以盘上连文件都还没有）。
    expect(existsSync(join(log.root, `${ID}.log`))).toBe(false)
    expect(io.held).toHaveLength(1)

    io.hold = false
    io.release() // 放行首写；后续排队项由它的回调串行接着写
    await closing // 远早于 closeTimeoutMs（60s）返回

    const text = readFileSync(join(log.root, `${ID}.log`), 'utf8')
    // 正文在前、footer 在后，顺序不因「谁先排队谁后在飞」而乱。
    expect(text).toBe('body one\nbody two\nfooter line\n')
    expect(existsSync(join(log.root, `${ID}.log.writing`))).toBe(false)
  })

  it('leaves .writing in place on timeout and renames only after the last write lands', async () => {
    const io = new HeldIo()
    const log = openLog(io, { closeTimeoutMs: 20 })
    const session = log.beginRun(ID)
    // 先让一批正文真正落盘，于是盘上有了活动文件。
    io.hold = false
    session?.append('body one\n')
    await session?.flushNow(60_000)
    expect(existsSync(join(log.root, `${ID}.log.writing`))).toBe(true)

    // 再把下一批写卡在飞的状态里。
    io.hold = true
    session?.append('body two\n')
    await session?.flushNow(1)
    expect(io.held).toHaveLength(1)

    const closing = session?.close('footer line\n')
    await closing // 超时返回：调用方不被磁盘拖住

    // 超时不 rename、不冒充完成——文件仍是 .writing，也没有 .log。
    expect(existsSync(join(log.root, `${ID}.log`))).toBe(false)
    expect(existsSync(join(log.root, `${ID}.log.writing`))).toBe(true)

    io.hold = false
    io.release()
    // 后台继续串行写完，最后一个回调落定后才 rename。
    await vi.waitFor(() => expect(existsSync(join(log.root, `${ID}.log`))).toBe(true))

    const text = readFileSync(join(log.root, `${ID}.log`), 'utf8')
    expect(text).toBe('body one\nbody two\nfooter line\n')
    expect(existsSync(join(log.root, `${ID}.log.writing`))).toBe(false)
  })

  it('is idempotent: a second close returns the same promise', async () => {
    const io = new HeldIo()
    const log = openLog(io, { closeTimeoutMs: 60_000 })
    const session = log.beginRun(ID)
    session?.append('body\n')
    const first = session?.close('footer\n')
    const second = session?.close('footer\n')
    expect(second).toBe(first)
    io.hold = false
    io.release()
    await first
    expect(readFileSync(join(log.root, `${ID}.log`), 'utf8')).toBe('body\nfooter\n')
  })

  // 单文件预算要算上「在飞的那一块」：旧实现只减已写 + 已排队，在飞块被当成空位，于是被多
  // 收一批、文件越过 maxFileBytes。
  it('counts an in-flight write against the file budget instead of free room', async () => {
    const io = new HeldIo()
    const log = openLog(io, { maxFileBytes: 400, footerReserveBytes: 40, closeTimeoutMs: 20 })
    const session = log.beginRun(ID)
    // 200 字节先在飞：本身在预算内（bodyBudget ≈ 400 - 40 - 截断标记）。
    session?.append(`${'a'.repeat(199)}\n`)
    await session?.flushNow(1)
    expect(io.held).toHaveLength(1)
    expect(session?.dropped.truncated).toBe(false)

    // 若在飞块被当成空位，这一行会被误收，文件就不再是有界的。
    session?.append(`${'b'.repeat(150)}\n`)
    expect(session?.dropped.truncated).toBe(true)

    io.hold = false
    io.release()
    await session?.close('')
  })

  // footer 有固定预留：一条放不下的大 footer 不能被无声地写进去把文件撑过头。
  it('bounds the footer reserve instead of letting one huge footer past the file cap', async () => {
    const io = new HeldIo()
    const log = openLog(io, { maxFileBytes: 400, footerReserveBytes: 64, closeTimeoutMs: 20 })
    const session = log.beginRun(ID)
    session?.append('body\n')
    io.hold = false
    await session?.close(`${'F'.repeat(500)}\n`)
    expect(session?.dropped.lines).toBeGreaterThan(0)
    const size = readFileSync(join(log.root, `${ID}.log`), 'utf8').length
    expect(size).toBeLessThanOrEqual(400)
  })
})
