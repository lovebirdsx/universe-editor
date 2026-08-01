/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/extensionHost/extensionHostMainService.ts
 *
 *  Focus: stderr level routing. The host tags every console call with a level
 *  prefix (see stdoutProtection.ts in packages/extension-host); main maps tagged
 *  lines to the matching log level instead of warning on all of them.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { delimiter } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { markAsSingleton } from '@universe-editor/platform'
import {
  ExtensionHostMainService,
  type ExtHostDevPathsResolver,
  type ExtHostInspectResolver,
  type ExtHostSpawner,
} from '../extensionHostMainService.js'

// The service imports `app` from electron for its default resolvers; the tests
// inject their own, so these stubs are never exercised.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app', getPath: () => '/fake/userData' },
}))

class FakeStdStream extends EventEmitter {
  setEncoding = vi.fn()
}

class FakeStdinStream extends EventEmitter {
  destroyed = false
  writable = true
  write(_data: string, _enc: string, cb: (err?: Error | null) => void): boolean {
    cb(null)
    return true
  }
}

class FakeProc extends EventEmitter {
  readonly stdout = new FakeStdStream()
  readonly stderr = new FakeStdStream()
  readonly stdin = new FakeStdinStream()
  kill(): boolean {
    return true
  }
  emitStderr(data: string): void {
    this.stderr.emit('data', Buffer.from(data, 'utf8'))
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal)
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error'

function makeService(
  proc: FakeProc,
  opts?: {
    devPaths?: ExtHostDevPathsResolver
    inspect?: ExtHostInspectResolver
    onSpawn?: (args: readonly string[], env: NodeJS.ProcessEnv | undefined) => void
  },
): {
  svc: ExtensionHostMainService
  records: Array<{ level: Level; message: string }>
} {
  const records: Array<{ level: Level; message: string }> = []
  const logger = {
    debug: (m: string) => records.push({ level: 'debug', message: m }),
    info: (m: string) => records.push({ level: 'info', message: m }),
    warn: (m: string) => records.push({ level: 'warn', message: m }),
    error: (m: string) => records.push({ level: 'error', message: m }),
    dispose: () => {},
  }
  const loggerService = {
    createLogger: () => markAsSingleton(logger),
  } as unknown as ConstructorParameters<typeof ExtensionHostMainService>[7]
  const spawner: ExtHostSpawner = (_command, args, options) => {
    opts?.onSpawn?.(args, options.env)
    return proc as unknown as ChildProcessWithoutNullStreams
  }
  const svc = new ExtensionHostMainService(
    spawner,
    () => '/fake/entry.js',
    () => '/fake/builtin',
    () => '/fake/user',
    () => ({ kind: 'tsls', cli: '/fake/cli.mjs', tsserver: '/fake/tsserver.js', version: '0' }),
    opts?.devPaths ?? (() => []),
    opts?.inspect ?? (() => ({ port: undefined, brk: undefined })),
    loggerService,
  )
  return { svc, records }
}

describe('ExtensionHostMainService stderr level routing', () => {
  let svc: ExtensionHostMainService | undefined

  afterEach(() => {
    svc?.dispose()
    svc = undefined
  })

  async function startWith(proc: FakeProc) {
    const made = makeService(proc)
    svc = made.svc
    const { handle } = await made.svc.start()
    // Only stderr routing is under test; drop the start/exit bookkeeping lines.
    const stderr = () => made.records.filter((r) => r.message.startsWith('[stderr '))
    return { handle, records: made.records, stderr }
  }

  it('routes tagged lines to their level, stripped of the tag', async () => {
    const proc = new FakeProc()
    const { handle, stderr } = await startWith(proc)

    proc.emitStderr('[info] [ext-host] ready\n[error] [ext-host] boom\n[debug] chatty\n')

    expect(stderr()).toEqual([
      { level: 'info', message: `[stderr ${handle}] [ext-host] ready` },
      { level: 'error', message: `[stderr ${handle}] [ext-host] boom` },
      { level: 'debug', message: `[stderr ${handle}] chatty` },
    ])
  })

  it('keeps untagged lines at warn (crash stacks, raw dependency writes)', async () => {
    const proc = new FakeProc()
    const { handle, stderr } = await startWith(proc)

    proc.emitStderr('RangeError: something raw\n')

    expect(stderr()).toEqual([
      { level: 'warn', message: `[stderr ${handle}] RangeError: something raw` },
    ])
  })

  it('treats indented lines as continuations of the previous level', async () => {
    const proc = new FakeProc()
    const { handle, stderr } = await startWith(proc)

    proc.emitStderr('[error] [ext-host] fatal: boom\n    at foo (bar.js:1:1)\nplain line\n')

    expect(stderr()).toEqual([
      { level: 'error', message: `[stderr ${handle}] [ext-host] fatal: boom` },
      { level: 'error', message: `[stderr ${handle}]     at foo (bar.js:1:1)` },
      { level: 'warn', message: `[stderr ${handle}] plain line` },
    ])
  })

  it('buffers a partial line and flushes it on exit', async () => {
    const proc = new FakeProc()
    const { handle, stderr } = await startWith(proc)

    proc.emitStderr('[info] partial without newline')
    expect(stderr()).toEqual([])

    proc.emitExit(0, null)
    expect(stderr()).toEqual([
      { level: 'info', message: `[stderr ${handle}] partial without newline` },
    ])
  })
})

describe('ExtensionHostMainService dev extensions + inspect flags', () => {
  let svc: ExtensionHostMainService | undefined

  afterEach(() => {
    svc?.dispose()
    svc = undefined
  })

  async function captureStart(opts?: {
    devPaths?: readonly string[]
    inspect?: { port: number | undefined; brk: number | undefined }
  }): Promise<{ args: readonly string[]; env: NodeJS.ProcessEnv }> {
    let captured: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined
    const made = makeService(new FakeProc(), {
      devPaths: () => opts?.devPaths ?? [],
      inspect: () => opts?.inspect ?? { port: undefined, brk: undefined },
      onSpawn: (args, env) => {
        captured = { args, env: env ?? {} }
      },
    })
    svc = made.svc
    await made.svc.start()
    if (!captured) throw new Error('spawner was not called')
    return captured
  }

  it('passes dev paths to the host env joined by path.delimiter', async () => {
    const { env } = await captureStart({ devPaths: ['D:\\dev\\ext-a', 'D:\\dev\\ext-b'] })
    expect(env.UNIVERSE_DEV_EXTENSIONS).toBe(['D:\\dev\\ext-a', 'D:\\dev\\ext-b'].join(delimiter))
  })

  it('omits UNIVERSE_DEV_EXTENSIONS when no dev paths are configured', async () => {
    const { env } = await captureStart()
    expect(env.UNIVERSE_DEV_EXTENSIONS).toBeUndefined()
  })

  it('injects --inspect bound to loopback BEFORE the entry script', async () => {
    const { args } = await captureStart({ inspect: { port: 9229, brk: undefined } })
    expect(args).toEqual(['--inspect=127.0.0.1:9229', '/fake/entry.js'])
  })

  it('inspect-brk wins over inspect and also precedes the entry', async () => {
    const { args } = await captureStart({ inspect: { port: 9229, brk: 9230 } })
    expect(args).toEqual(['--inspect-brk=127.0.0.1:9230', '/fake/entry.js'])
  })

  it('leaves argv as just the entry when neither dev nor inspect is configured', async () => {
    const { args } = await captureStart()
    expect(args).toEqual(['/fake/entry.js'])
  })
})
