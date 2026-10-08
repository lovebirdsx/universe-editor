/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  fixture 自身的回归测试：不启动真实 fork，只验安全与关闭行为。
 *
 *    - codex 连接各拿一个位于调用方临时 cwd 下的独立 CODEX_HOME（文件凭据存储），
 *      只覆盖 CODEX_HOME，其余环境照常继承；
 *    - dispose 等子进程真正 close 后才删 home，忽略 SIGTERM 时升级 SIGKILL，且有界、幂等；
 *    - withTimeout 在竞争 promise 结束后释放定时器。
 *
 *  整个套件把父进程 CODEX_HOME/HOME 指向播了诱饵 auth.json 的临时目录，即使隔离回归
 *  也碰不到真实 home。spawn 的入口是 stub 脚本而非 fork dist。
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import {
  type ChildCloseTracker,
  type RealForkConnection,
  shutdownChild,
  spawnForkConnection,
  withTimeout,
} from '../fixtures/realForkConnection.js'

// fork dist 的替身：记录启动环境后空转（像真 fork 一样占住 stdin/stdout），直到被 dispose。
const STUB_ENTRY_SOURCE = `
const fs = require('node:fs')
const path = require('node:path')
if (process.env.STUB_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {})
} else {
  const delay = Number(process.env.STUB_EXIT_DELAY_MS ?? '0')
  process.on('SIGTERM', () => setTimeout(() => {
    fs.writeFileSync(path.join(process.cwd(), 'child-exit.txt'), 'exited')
    process.exit(0)
  }, delay))
}
// 处理器装好后再落就绪文件：测试见到它才 dispose，避免信号早于处理器被默认动作杀掉。
fs.writeFileSync(
  path.join(process.cwd(), 'child-env.json'),
  JSON.stringify({ codexHome: process.env.CODEX_HOME ?? null, home: process.env.HOME ?? null }),
)
setInterval(() => {}, 1000)
`

interface ChildEnvRecord {
  readonly codexHome: string | null
  readonly home: string | null
}

function writeStubEntry(cwd: string): string {
  const entry = join(cwd, 'stub-fork.cjs')
  writeFileSync(entry, STUB_ENTRY_SOURCE, 'utf8')
  return entry
}

async function waitForFile(path: string, deadlineMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - start > deadlineMs) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function readChildEnv(cwd: string): ChildEnvRecord {
  return JSON.parse(readFileSync(join(cwd, 'child-env.json'), 'utf8')) as ChildEnvRecord
}

describe('realForkConnection fixture: isolated codex home', () => {
  let cwd: string
  let parentHome: string
  let stubEntry: string
  let restoreEnv: () => void
  const open: RealForkConnection[] = []

  beforeEach(() => {
    cwd = mkTempDir('acp-contract-fixture-')
    parentHome = join(cwd, 'parent-codex-home')
    mkdirSync(parentHome, { recursive: true })
    // 诱饵账号：若隔离回归，被读到的是它，永远不是开发者真实的 ~/.codex。
    writeFileSync(join(parentHome, 'auth.json'), '{"decoy":true}\n', 'utf8')
    stubEntry = writeStubEntry(cwd)

    const saved = new Map<string, string | undefined>()
    const setEnv = (key: string, value: string | undefined) => {
      saved.set(key, process.env[key])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    // 父 home 指向诱饵并清掉 stub 开关，让每个用例从确定的隔离环境起步。
    setEnv('CODEX_HOME', parentHome)
    setEnv('HOME', parentHome)
    setEnv('STUB_EXIT_DELAY_MS', undefined)
    setEnv('STUB_IGNORE_SIGTERM', undefined)
    restoreEnv = () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  afterEach(async () => {
    for (const connection of open.splice(0)) await connection.dispose()
    restoreEnv()
    removeDirWithRetry(cwd)
  })

  it('gives codex a fresh home under the temp cwd and copies nothing from the parent', async () => {
    const connection = spawnForkConnection('codex', cwd, { entry: stubEntry })
    open.push(connection)
    await waitForFile(join(cwd, 'child-env.json'))

    expect(connection.codexHome).toBeDefined()
    const home = connection.codexHome as string
    // 每连接独立目录，且在调用方临时 cwd 内，不是父目录。
    expect(home.startsWith(cwd)).toBe(true)
    expect(home).not.toBe(parentHome)

    // 子进程确实收到了它（不只是 fixture 自己的记账）。
    const childEnv = readChildEnv(cwd)
    expect(childEnv.codexHome).toBe(home)
    expect(childEnv.home).toBe(parentHome) // HOME 未动 —— 起隔离作用的是 CODEX_HOME。

    // 文件凭据存储，且没有账号数据被带过来。
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain(
      'cli_auth_credentials_store = "file"',
    )
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
  })

  it('gives each connection its own directory', async () => {
    const first = spawnForkConnection('codex', cwd, { entry: stubEntry })
    open.push(first)
    const second = spawnForkConnection('codex', cwd, { entry: stubEntry })
    open.push(second)

    expect(first.codexHome).toBeDefined()
    expect(second.codexHome).toBeDefined()
    expect(first.codexHome).not.toBe(second.codexHome)
  })

  it('dispose waits for the child to exit, then removes the home, and is idempotent', async () => {
    process.env['STUB_EXIT_DELAY_MS'] = '300'
    const connection = spawnForkConnection('codex', cwd, { entry: stubEntry })
    open.push(connection)
    await waitForFile(join(cwd, 'child-env.json'))
    const home = connection.codexHome as string
    expect(existsSync(home)).toBe(true)

    const disposeAgain = connection.dispose()
    await connection.dispose()
    await disposeAgain // 并发/重复调用共享同一次关闭

    // stub 在 SIGTERM 处理器里先写该文件再退出；Windows 上 Node 的 SIGTERM 是强杀、
    // 处理器不执行，故只有 POSIX 能拿它当「退出前已完成」的证据。
    if (process.platform !== 'win32') {
      expect(existsSync(join(cwd, 'child-exit.txt'))).toBe(true)
    }
    expect(connection.child.exitCode).not.toBeNull()
    expect(existsSync(home)).toBe(false)
  })

  it('dispose escalates to SIGKILL when the child ignores SIGTERM, within a bounded time', async () => {
    process.env['STUB_IGNORE_SIGTERM'] = '1'
    const connection = spawnForkConnection('codex', cwd, { entry: stubEntry })
    open.push(connection)
    await waitForFile(join(cwd, 'child-env.json'))

    const started = Date.now()
    await connection.dispose()
    const elapsed = Date.now() - started

    // stub 忽略 SIGTERM：POSIX 上升级 SIGKILL；Windows 上 Node 的 SIGTERM 本就是强杀，
    // 此路径退化为直接退出，下面的断言同样成立。
    expect(connection.child.exitCode !== null || connection.child.signalCode !== null).toBe(true)
    expect(existsSync(join(cwd, 'child-exit.txt'))).toBe(false) // 从未处理 SIGTERM
    expect(elapsed).toBeLessThan(8_000)
  })
})

/** kill 无效果、也永不 close 的假 child，用于免等宽限地覆盖超时失败路径。 */
class NeverClosingChild {
  readonly signals: string[] = []
  kill(signal: string): boolean {
    this.signals.push(signal)
    return true
  }
}

describe('shutdownChild failure path', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('throws and keeps the home when the child never closes', async () => {
    vi.useFakeTimers()
    const home = mkTempDir('acp-contract-fixture-')
    const child = new NeverClosingChild()
    const tracker: ChildCloseTracker = { closed: false, whenClosed: new Promise<void>(() => {}) }

    const shutdown = shutdownChild(
      child as unknown as ChildProcessWithoutNullStreams,
      tracker,
      home,
    )
    // 先挂断言再推进定时器，避免拒绝先于处理器就绪造成 unhandled rejection。
    const rejection = expect(shutdown).rejects.toThrow(/SIGKILL/)
    await vi.advanceTimersByTimeAsync(30_000)
    await rejection

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(existsSync(home)).toBe(true)
    removeDirWithRetry(home)
  })
})

describe('withTimeout timer hygiene', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases its timer once the raced promise settles', async () => {
    vi.useFakeTimers()
    await expect(withTimeout(Promise.resolve('ok'), 60_000, 'probe')).resolves.toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still rejects when the raced promise never settles', async () => {
    vi.useFakeTimers()
    const rejection = expect(
      withTimeout(new Promise<string>(() => {}), 1_000, 'probe'),
    ).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(1_000)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })
})
