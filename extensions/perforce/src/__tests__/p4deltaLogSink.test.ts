/**
 * δ 的运行日志出口（频道 + 落盘）。这里钉住的是「一次运行在盘上和频道里都自证身份」所需的几件
 * 事：运行头带上下文的引擎来源、终态行**即使正文被截断也要在**、丢行要有痕迹、会话收尾后
 * `.writing` 翻成 `.log`，以及没有存储目录时只剩频道而不是静默丢诊断。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutputChannel } from '@universe-editor/extension-api'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { createP4deltaLogSink, describeP4deltaRunEnd } from '../p4deltaLog.js'
import {
  P4DELTA_RUN_LOG_LIMITS,
  P4deltaRunLog,
  type P4deltaRunLogLimits,
} from '../p4delta/p4deltaRunLog.js'
import type { P4deltaRunEnd, P4deltaRunStart } from '../p4delta/p4deltaService.js'

const roots: string[] = []
function makeRoot(): string {
  const root = mkTempDir('ue-p4dlog-sink-')
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) removeDirWithRetry(root)
})

/** 一个只记账的频道：`append` 收到的就是用户会看到的（append 与 appendLine 同源）。 */
function makeChannel(): { channel: OutputChannel; text: () => string } {
  const parts: string[] = []
  return {
    channel: {
      name: 'P4delta',
      append: (value: string) => void parts.push(value),
      appendLine: (value: string) => void parts.push(`${value}\n`),
      replace: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    } as unknown as OutputChannel,
    text: () => parts.join(''),
  }
}

function smallLimits(over: Partial<P4deltaRunLogLimits> = {}): P4deltaRunLogLimits {
  return { ...P4DELTA_RUN_LOG_LIMITS, flushIntervalMs: 5, cleanupThrottleMs: 0, ...over }
}

function makeStore(limits = smallLimits()): P4deltaRunLog {
  const store = P4deltaRunLog.open(makeRoot(), undefined, limits)
  if (store === undefined) throw new Error('expected the store to open')
  return store
}

const ID = 'p4d-1-42-1-abcd1234'

function startInfo(over: Partial<P4deltaRunStart> = {}): P4deltaRunStart {
  return {
    runId: ID,
    args: ['--json', '--client-root', 'X:/p4ws/main', 'sync', '--head'],
    cwd: 'X:/p4ws/main',
    exe: 'X:/tools/p4delta.exe',
    clientRoot: 'X:/p4ws/main',
    startedAt: 1_700_000_000_000,
    ...over,
  }
}

function endInfo(over: Partial<P4deltaRunEnd> = {}): P4deltaRunEnd {
  return {
    runId: ID,
    args: ['--json', 'sync'],
    startedAt: 1_700_000_000_000,
    status: 'ok',
    code: 0,
    signal: null,
    elapsedMs: 1234,
    records: 12,
    progress: 5,
    ...over,
  }
}

async function readRunFile(store: P4deltaRunLog): Promise<string> {
  // The close path is asynchronous; the file is only renamed once it lands.
  for (let i = 0; i < 100; i++) {
    if (readdirSync(store.root).includes(`${ID}.log`)) break
    await new Promise((r) => setTimeout(r, 10))
  }
  return readFileSync(join(store.root, `${ID}.log`), 'utf8')
}

describe('createP4deltaLogSink', () => {
  it('writes a self-describing header to the channel and the file', async () => {
    const channel = makeChannel()
    const store = makeStore()
    const sink = createP4deltaLogSink({
      channel: channel.channel,
      store,
      warn: vi.fn(),
      engineSource: () => 'managed',
    })

    const lines = sink.open(startInfo())
    lines?.line('2026-10-15T12:00:00.000+08:00 +0.100s p4d-1-42-1-abcd1234 staging 12 files\n')
    sink.close(endInfo())

    const text = await readRunFile(store)
    for (const expected of [
      `=== p4delta run ${ID} ===`,
      '# engine  X:/tools/p4delta.exe (managed)',
      '# client  X:/p4ws/main',
      '# cwd     X:/p4ws/main',
      '# argv    --json --client-root X:/p4ws/main sync --head',
      'staging 12 files',
      '# ok: exit 0, 1.234s, 12 record(s), 5 progress',
    ]) {
      expect(text).toContain(expected)
      expect(channel.text()).toContain(expected)
    }
  })

  it('keeps the terminal line even when the body budget is exhausted', async () => {
    const channel = makeChannel()
    const store = makeStore(smallLimits({ maxFileBytes: 4096, footerReserveBytes: 512 }))
    const sink = createP4deltaLogSink({ channel: channel.channel, store, warn: vi.fn() })

    const lines = sink.open(startInfo())
    for (let i = 0; i < 500; i++) lines?.line(`line ${i} ${'x'.repeat(100)}\n`)
    // A cancelled run whose log filled up: the truncation marker AND the status
    // must both be in the file, or the log reads as a complete run with no end.
    sink.close(endInfo({ status: 'cancelled', code: 1, note: 'the user cancelled the get' }))

    const text = await readRunFile(store)
    expect(text).toContain('log truncation')
    expect(text).toContain('# cancelled: exit 1, 1.234s, 12 record(s), 5 progress')
    expect(text).toContain('the user cancelled the get')
    expect(text).toContain('# dropped')
  })

  it('keeps the command statistics footer even when the body is truncated', async () => {
    const channel = makeChannel()
    const store = makeStore(smallLimits({ maxFileBytes: 4096, footerReserveBytes: 512 }))
    const sink = createP4deltaLogSink({ channel: channel.channel, store, warn: vi.fn() })

    const lines = sink.open(startInfo())
    for (let i = 0; i < 500; i++) lines?.line(`line ${i} ${'x'.repeat(100)}\n`)
    // 正文被截断后，「这 N 次调用花在哪」仍在文件末尾——它是 footer，不是正文。
    sink.close(
      endInfo({
        summary: '# summary: mode=sync p4Calls=37 p4CallsByCommand=fstat 30 · sync 7',
      }),
    )

    const text = await readRunFile(store)
    expect(text).toContain('log truncation')
    expect(text).toContain('p4CallsByCommand=fstat 30 · sync 7')
    expect(channel.text()).toContain('p4CallsByCommand=fstat 30 · sync 7')
  })

  it('renames .writing to .log and leaves the run listable when it ends', async () => {
    const store = makeStore()
    const sink = createP4deltaLogSink({ channel: makeChannel().channel, store, warn: vi.fn() })

    sink.open(startInfo())
    expect(store.latest()?.runId).toBe(ID)
    expect(store.latest()?.active).toBe(true)

    sink.close(endInfo())
    await readRunFile(store)

    expect(store.list(5).map((f) => f.runId)).toEqual([ID])
    expect(store.list(5)[0]?.active).toBe(false)
  })

  it('emits only to the channel when there is no storage directory, warning once', () => {
    const channel = makeChannel()
    const warn = vi.fn()
    const sink = createP4deltaLogSink({ channel: channel.channel, store: undefined, warn })

    const lines = sink.open(startInfo({ runId: 'p4d-1-1-1-aaaaaaaa' }))
    lines?.line('a diagnostic line\n')
    sink.open(startInfo({ runId: 'p4d-1-1-2-bbbbbbbb' }))
    sink.close(endInfo({ runId: 'p4d-1-1-1-aaaaaaaa' }))

    // 诊断一条没丢——只是没有落盘。
    expect(channel.text()).toContain('a diagnostic line')
    expect(channel.text()).toContain('# ok: exit 0')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('survives a channel that throws', () => {
    const broken = {
      append: () => {
        throw new Error('channel disposed')
      },
    } as unknown as OutputChannel
    const store = makeStore()
    const sink = createP4deltaLogSink({ channel: broken, store, warn: vi.fn() })

    const lines = sink.open(startInfo())
    expect(() => lines?.line('still recorded\n')).not.toThrow()
    expect(() => sink.close(endInfo())).not.toThrow()
  })

  it('keeps two concurrent runs in their own files', async () => {
    const store = makeStore()
    const sink = createP4deltaLogSink({ channel: makeChannel().channel, store, warn: vi.fn() })
    const first = 'p4d-1-1-1-aaaaaaaa'
    const second = 'p4d-1-1-2-bbbbbbbb'

    const a = sink.open(startInfo({ runId: first }))
    const b = sink.open(startInfo({ runId: second }))
    a?.line('only in a\n')
    b?.line('only in b\n')
    sink.close(endInfo({ runId: first }))
    sink.close(endInfo({ runId: second }))

    const readOf = async (runId: string): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        if (readdirSync(store.root).includes(`${runId}.log`)) break
        await new Promise((r) => setTimeout(r, 10))
      }
      return readFileSync(join(store.root, `${runId}.log`), 'utf8')
    }
    expect(await readOf(first)).toContain('only in a')
    expect(await readOf(first)).not.toContain('only in b')
    expect(await readOf(second)).toContain('only in b')
  })

  it('spells the terminal line from the run’s own numbers', () => {
    expect(describeP4deltaRunEnd(endInfo())).toBe('# ok: exit 0, 1.234s, 12 record(s), 5 progress')
    expect(describeP4deltaRunEnd(endInfo({ status: 'timeout', code: 1, signal: 'SIGKILL' }))).toBe(
      '# timeout: exit 1, signal SIGKILL, 1.234s, 12 record(s), 5 progress',
    )
    expect(describeP4deltaRunEnd(endInfo({ status: 'no-summary', note: 'no conclusion' }))).toBe(
      '# no-summary: exit 0, 1.234s, 12 record(s), 5 progress — no conclusion',
    )
  })
})
