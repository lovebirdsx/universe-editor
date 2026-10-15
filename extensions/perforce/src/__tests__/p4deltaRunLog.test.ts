/**
 * `p4deltaRunLog` 的写入路径：有界队列 / 单文件截断 / 终态预留 / 保留策略 / 跨窗口活动文件保护 /
 * 读取路径校验。这些性质都是「越界即静默出错」的那一类（丢行没标记、截断看起来完整、把另一个
 * 窗口正在写的文件删掉），所以逐条钉住。
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import {
  P4DELTA_RUN_LOG_LIMITS,
  P4deltaRunLog,
  isSafeRunId,
  nextP4deltaRunId,
  type P4deltaRunLogLimits,
} from '../p4delta/p4deltaRunLog.js'

const roots: string[] = []
function makeRoot(): string {
  const root = mkTempDir('ue-p4dlog-')
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) removeDirWithRetry(root)
})

/** 小限额版本，让截断 / 淘汰 / 队列上限在几百字节的量级上就能验。 */
function smallLimits(over: Partial<P4deltaRunLogLimits> = {}): P4deltaRunLogLimits {
  return { ...P4DELTA_RUN_LOG_LIMITS, flushIntervalMs: 5, cleanupThrottleMs: 0, ...over }
}

function openLog(limits: P4deltaRunLogLimits = smallLimits()): P4deltaRunLog {
  const log = P4deltaRunLog.open(makeRoot(), undefined, limits)
  if (log === undefined) throw new Error('expected the store to open')
  return log
}

function openLogWithWarn(warn: (m: string) => void): P4deltaRunLog {
  const log = P4deltaRunLog.open(makeRoot(), warn, smallLimits())
  if (log === undefined) throw new Error('expected the store to open')
  return log
}

const ID = 'p4d-1-42-1-abcd1234'

describe('P4deltaRunLog: writing', () => {
  it('writes under a .writing name and only renames on close', async () => {
    const log = openLog()
    const session = log.beginRun(ID)
    expect(session).toBeDefined()
    session?.append('first line\n')
    await session?.flushNow()
    expect(existsSync(join(log.root, `${ID}.log.writing`))).toBe(true)
    expect(existsSync(join(log.root, `${ID}.log`))).toBe(false)
    await session?.close('end: ok\n')
    expect(existsSync(join(log.root, `${ID}.log.writing`))).toBe(false)
    const text = readFileSync(join(log.root, `${ID}.log`), 'utf8')
    expect(text).toContain('first line\n')
    expect(text).toContain('end: ok\n')
  })

  it('flushes what has not reached the disk yet before a snapshot read', async () => {
    const log = openLog(smallLimits({ flushIntervalMs: 10_000 }))
    const session = log.beginRun(ID)
    session?.append('a line nobody has flushed yet\n')
    const snapshot = await log.readSnapshot(ID)
    expect(snapshot?.text).toContain('a line nobody has flushed yet')
    // 活动快照：内容还会长，调用方必须能说清这一点。
    expect(snapshot?.active).toBe(true)
    await session?.close('end: ok\n')
  })

  it('stamps the footer even after the body was truncated, and marks the truncation', async () => {
    const log = openLog(smallLimits({ maxFileBytes: 400, footerReserveBytes: 100 }))
    const session = log.beginRun(ID)
    for (let i = 0; i < 50; i++) session?.append(`body line ${i} ${'x'.repeat(40)}\n`)
    await session?.close('end: ok, p4Calls 3 (sync 2, fstat 1)\n')
    const text = readFileSync(join(log.root, `${ID}.log`), 'utf8')
    expect(text).toContain('log truncation')
    // 尾部预留的作用：截断也挡住终态与调用分类，那这份日志等于没用。
    expect(text).toContain('end: ok, p4Calls 3 (sync 2, fstat 1)')
    expect(session?.dropped.truncated).toBe(true)
    expect(session?.dropped.lines).toBeGreaterThan(0)
  })

  it('drops lines past the queue cap instead of growing an unbounded buffer', async () => {
    const log = openLog(smallLimits({ maxQueuedBytes: 200, flushIntervalMs: 10_000 }))
    const session = log.beginRun(ID)
    for (let i = 0; i < 20; i++) session?.append(`line ${i} ${'y'.repeat(30)}\n`)
    expect(session?.dropped.lines).toBeGreaterThan(0)
    await session?.close('end: ok\n')
    // 丢行不等于崩掉：文件仍然存在，终态仍然写着。
    expect(readFileSync(join(log.root, `${ID}.log`), 'utf8')).toContain('end: ok')
  })

  it('counts bytes written rather than lines queued', async () => {
    const log = openLog()
    const session = log.beginRun(ID)
    session?.append('12345\n')
    await session?.close('')
    expect(session?.writtenBytes).toBe(6)
  })

  it('close is idempotent and never rejects when the file vanished', async () => {
    const log = openLog()
    const session = log.beginRun(ID)
    session?.append('x\n')
    rmSync(join(log.root, `${ID}.log.writing`), { force: true })
    await expect(session?.close('end\n')).resolves.toBeUndefined()
    await expect(session?.close('end\n')).resolves.toBeUndefined()
  })

  it('warns once instead of throwing when the directory cannot be written', async () => {
    const warnings: string[] = []
    const log = openLogWithWarn((m) => warnings.push(m))
    const session = log.beginRun(ID)
    rmSync(log.root, { recursive: true, force: true })
    session?.append('x\n')
    await expect(session?.close('end\n')).resolves.toBeUndefined()
    expect(warnings.length).toBeLessThanOrEqual(1)
  })
})

describe('P4deltaRunLog: retention', () => {
  const writeRun = async (log: P4deltaRunLog, runId: string, body = 'x\n'): Promise<void> => {
    const session = log.beginRun(runId)
    session?.append(body)
    await session?.close('end\n')
  }

  it('keeps only the newest files past the cap and drops the oldest', async () => {
    const log = openLog(smallLimits({ maxFiles: 2 }))
    await writeRun(log, 'p4d-1-1-1-aaaa')
    await new Promise((r) => setTimeout(r, 5))
    await writeRun(log, 'p4d-2-1-2-bbbb')
    await new Promise((r) => setTimeout(r, 5))
    await writeRun(log, 'p4d-3-1-3-cccc')
    log.cleanup()
    const names = readdirSync(log.root).sort()
    expect(names).toEqual(['p4d-2-1-2-bbbb.log', 'p4d-3-1-3-cccc.log'])
  })

  it('drops files past the age cap', async () => {
    const log = openLog(smallLimits({ maxAgeMs: 1000 }))
    await writeRun(log, 'p4d-old-1-1-aaaa')
    const stale = new Date(Date.now() - 60_000)
    utimesSync(join(log.root, 'p4d-old-1-1-aaaa.log'), stale, stale)
    await writeRun(log, 'p4d-new-1-2-bbbb')
    log.cleanup()
    expect(readdirSync(log.root).sort()).toEqual(['p4d-new-1-2-bbbb.log'])
  })

  // 跨窗口保护：另一个窗口正往它的 `.writing` 里写，清理绝不能把它当垃圾。
  it('never deletes another window’s live .writing file, but reaps a stale one', async () => {
    const log = openLog(smallLimits({ activeGraceMs: 60_000 }))
    const live = join(log.root, 'p4d-live-9-9-ffff.log.writing')
    writeFileSync(live, 'still being written\n')
    const staleFile = join(log.root, 'p4d-gone-9-9-eeee.log.writing')
    writeFileSync(staleFile, 'crashed mid-run\n')
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(staleFile, old, old)
    log.cleanup()
    expect(existsSync(live)).toBe(true)
    expect(existsSync(staleFile)).toBe(false)
  })

  it('ignores files that do not follow the naming convention', async () => {
    const log = openLog(smallLimits({ maxFiles: 0 }))
    writeFileSync(join(log.root, 'notes.txt'), 'not ours\n')
    writeFileSync(join(log.root, 'p4d-1-1-1-aaaa.log.tmp'), 'not ours either\n')
    await writeRun(log, 'p4d-1-1-1-aaaa')
    log.cleanup()
    const names = readdirSync(log.root).sort()
    expect(names).toEqual(['notes.txt', 'p4d-1-1-1-aaaa.log.tmp'])
  })
})

describe('P4deltaRunLog: reading', () => {
  it('lists the most recent run first, live or finished', async () => {
    const log = openLog()
    const done = log.beginRun('p4d-100-1-1-aaaa')
    done?.append('done\n')
    await done?.close('end\n')
    await new Promise((r) => setTimeout(r, 20))
    const live = log.beginRun('p4d-200-1-2-bbbb')
    live?.append('live\n')
    const list = log.list(10)
    // 「最近一次」按时间排，不按「是否已结束」排：一次还在写的运行就是最近的那一次，把已结束
    // 的排在它前面会让「打开最近一次日志」打开上一次的（内容还只是还在长，快照读先 flush）。
    expect(list.map((e) => e.runId)).toEqual(['p4d-200-1-2-bbbb', 'p4d-100-1-1-aaaa'])
    expect(list[0]?.active).toBe(true)
    expect(log.latest()?.runId).toBe('p4d-200-1-2-bbbb')
    await live?.close('end\n')
  })

  it('returns undefined for an id that is not a plain run file', async () => {
    const log = openLog()
    const done = log.beginRun(ID)
    done?.append('hello\n')
    await done?.close('end\n')
    expect(await log.readSnapshot('../outside')).toBeUndefined()
    expect(await log.readSnapshot('a/b')).toBeUndefined()
    expect(await log.readSnapshot('.hidden')).toBeUndefined()
    expect(await log.readSnapshot('p4d-404-1-1-zzzz')).toBeUndefined()
    expect(await log.readSnapshot(ID)).toBeDefined()
  })

  it('refuses to follow a symlink out of the log directory', async () => {
    const log = openLog()
    const outside = join(makeRoot(), 'secret.txt')
    writeFileSync(outside, 'do not read me\n')
    const link = join(log.root, 'p4d-link-1-1-aaaa.log')
    try {
      symlinkSync(outside, link, 'file')
    } catch {
      return // 没有建符号链接的权限（Windows 非开发者模式）——跳过
    }
    expect(await log.readSnapshot('p4d-link-1-1-aaaa')).toBeUndefined()
  })

  it('caps the snapshot and says so', async () => {
    const log = openLog(smallLimits({ maxSnapshotBytes: 64 }))
    const session = log.beginRun(ID)
    session?.append('z'.repeat(200) + '\n')
    await session?.close('end\n')
    const snapshot = await log.readSnapshot(ID)
    expect(snapshot?.truncated).toBe(true)
    expect(snapshot?.text).toContain('… (truncated)')
  })

  // 2MiB 预算下的 10MiB 日志：被截断丢掉的是中段，文件末尾的终态必须仍在快照里——
  // 否则「打开最近一次日志」正好看不到这一跑的结论。
  it('keeps the run’s conclusion in the tail of a truncated snapshot', async () => {
    const log = openLog(smallLimits({ maxSnapshotBytes: 256 }))
    const session = log.beginRun(ID)
    for (let i = 0; i < 200; i++) session?.append(`body line ${i} ${'x'.repeat(40)}\n`)
    await session?.close('end: ok, p4Calls 3 (sync 2, fstat 1)\n')
    const snapshot = await log.readSnapshot(ID)
    expect(snapshot?.truncated).toBe(true)
    expect(snapshot?.text).toContain('… (truncated)')
    expect(snapshot?.text).toContain('end: ok, p4Calls 3 (sync 2, fstat 1)')
  })

  // 预算是**字节**不是字符：中文 / emoji 每字多字节，截断既不能越预算，也不能把一个
  // 码点劈成替换字符。
  it('cuts the snapshot on a UTF-8 boundary and within the byte budget', async () => {
    const log = openLog(smallLimits({ maxSnapshotBytes: 63 }))
    const session = log.beginRun(ID)
    session?.append('😀'.repeat(100) + '\n')
    await session?.close('end\n')
    const snapshot = await log.readSnapshot(ID)
    expect(snapshot?.truncated).toBe(true)
    expect(snapshot?.text).not.toContain('�')
    expect(Buffer.byteLength(snapshot?.text ?? '', 'utf8')).toBeLessThanOrEqual(63)
    expect(snapshot?.text).toContain('end')
  })

  it('refuses a log directory reached through a symlink', () => {
    const real = makeRoot()
    const link = join(makeRoot(), 'link')
    try {
      symlinkSync(real, link, 'dir')
    } catch {
      return
    }
    expect(P4deltaRunLog.open(link)).toBeUndefined()
  })
})

describe('isSafeRunId / nextP4deltaRunId', () => {
  it('accepts the generated ids and rejects path-shaped ones', () => {
    expect(isSafeRunId(nextP4deltaRunId(1_700_000_000_000, () => 0.5))).toBe(true)
    expect(isSafeRunId('a')).toBe(true)
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a b', 'a'.repeat(200), '-lead']) {
      expect(isSafeRunId(bad), bad).toBe(false)
    }
  })

  it('separates two runs generated in the same millisecond', () => {
    const a = nextP4deltaRunId(1_700_000_000_000, () => 0.1)
    const b = nextP4deltaRunId(1_700_000_000_000, () => 0.1)
    expect(a).not.toBe(b)
    expect(a.startsWith('p4d-1700000000000-')).toBe(true)
  })
})
