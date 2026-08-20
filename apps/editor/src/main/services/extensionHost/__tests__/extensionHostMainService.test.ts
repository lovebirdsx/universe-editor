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
import { AbstractLogger, Emitter, LogLevel, markAsSingleton } from '@universe-editor/platform'
import type { IDisposable } from '@universe-editor/platform'
import {
  ExtensionHostMainService,
  createWindowScopedExtensionHost,
  type ExtHostDevPathsResolver,
  type ExtHostInspectResolver,
  type ExtHostSpawner,
} from '../extensionHostMainService.js'
import type {
  ExtHostExitEvent,
  ExtHostStartResult,
  ExtHostStartSpec,
  ExtHostStdioChunk,
  IExtensionHostService,
} from '../../../../shared/ipc/extensionHostService.js'

// The service imports `app` from electron for its default resolvers; the tests
// inject their own, so these stubs are never exercised.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '0.13.0',
    getAppPath: () => '/fake/app',
    getPath: () => '/fake/userData',
  },
}))

class FakeStdStream extends EventEmitter {
  setEncoding = vi.fn()
}

class FakeStdinStream extends EventEmitter {
  destroyed = false
  writable = true
  endCalls = 0
  write(_data: string, _enc: string, cb: (err?: Error | null) => void): boolean {
    cb(null)
    return true
  }
  end(): void {
    this.endCalls++
  }
}

class FakeProc extends EventEmitter {
  readonly stdout = new FakeStdStream()
  readonly stderr = new FakeStdStream()
  readonly stdin = new FakeStdinStream()
  killCalls = 0
  kill(): boolean {
    this.killCalls++
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

describe('ExtensionHostMainService — window-scoped reclaim', () => {
  let svc: ExtensionHostMainService | undefined

  afterEach(() => {
    svc?.dispose()
    svc = undefined
  })

  class CapturingLogger extends AbstractLogger {
    readonly warns: string[] = []
    protected override _log(level: LogLevel, message: string): void {
      if (level === LogLevel.Warning) this.warns.push(message)
    }
  }

  function makeScopedService(procs: FakeProc[], logger: CapturingLogger): ExtensionHostMainService {
    let i = 0
    const spawner: ExtHostSpawner = () => {
      const next = procs[i++]
      if (!next) throw new Error('no more procs queued')
      return next as unknown as ChildProcessWithoutNullStreams
    }
    const realSvc = new ExtensionHostMainService(
      spawner,
      () => '/fake/entry.js',
      () => '/fake/builtin',
      () => '/fake/user',
      () => ({ kind: 'tsls', cli: '/fake/cli.mjs', tsserver: '/fake/tsserver.js', version: '0' }),
      () => [],
      () => ({ port: undefined, brk: undefined }),
      { createLogger: () => markAsSingleton(logger) } as unknown as ConstructorParameters<
        typeof ExtensionHostMainService
      >[7],
    )
    return realSvc
  }

  class FakeRemoteHost implements IExtensionHostService, IDisposable {
    declare readonly _serviceBrand: undefined
    private readonly _onStdout = new Emitter<ExtHostStdioChunk>()
    private readonly _onStderr = new Emitter<ExtHostStdioChunk>()
    private readonly _onExit = new Emitter<ExtHostExitEvent>()
    readonly onStdout = this._onStdout.event
    readonly onStderr = this._onStderr.event
    readonly onExit = this._onExit.event
    readonly starts: Array<ExtHostStartSpec | undefined> = []
    readonly stops: string[] = []
    start(spec?: ExtHostStartSpec): Promise<ExtHostStartResult> {
      this.starts.push(spec)
      return Promise.resolve({ handle: 'remote-handle' })
    }
    writeStdin(_handle: string, _data: string): Promise<void> {
      return Promise.resolve()
    }
    stop(handle: string): Promise<void> {
      this.stops.push(handle)
      return Promise.resolve()
    }
    stopAll(): Promise<void> {
      return Promise.resolve()
    }
    hasUserExtensions(): Promise<boolean> {
      return Promise.resolve(false)
    }
    dispose(): void {}
  }

  it("startForWindow reclaims only that window's local hosts and logs the count", async () => {
    const logger = markAsSingleton(new CapturingLogger())
    const procA = new FakeProc()
    const procB = new FakeProc()
    const procC = new FakeProc()
    const realSvc = makeScopedService([procA, procB, procC], logger)
    svc = realSvc

    const win1 = createWindowScopedExtensionHost(realSvc, 1)
    const win2 = createWindowScopedExtensionHost(realSvc, 2)

    await win1.start()
    await win1.start()
    await win2.start()

    await realSvc.stopAllForWindow(1)

    expect(procA.stdin.endCalls).toBe(1)
    expect(procB.stdin.endCalls).toBe(1)
    expect(procC.stdin.endCalls).toBe(0)
    expect(logger.warns).toEqual(['stopAllForWindow windowId=1 killed=2'])

    // A second call is a no-op: the window's handles were already reclaimed.
    await realSvc.stopAllForWindow(1)
    expect(logger.warns).toHaveLength(1)
  })

  it('clears a handle from the window map when its host exits (stopAllForWindow becomes a no-op)', async () => {
    const logger = markAsSingleton(new CapturingLogger())
    const proc = new FakeProc()
    const realSvc = makeScopedService([proc], logger)
    svc = realSvc

    const win1 = createWindowScopedExtensionHost(realSvc, 1)
    await win1.start()
    proc.emitExit(0, null)

    await realSvc.stopAllForWindow(1)

    expect(logger.warns).toEqual([])
    expect(proc.stdin.endCalls).toBe(0)
  })

  it('stopAllForWindow leaves remote (server-managed) hosts untouched', async () => {
    const remote = new FakeRemoteHost()
    svc = new ExtensionHostMainService(
      () => {
        throw new Error('local spawn must not be used')
      },
      () => '/fake/entry.js',
      () => '/fake/builtin',
      () => '/fake/user',
      () => ({ kind: 'tsls', cli: '/fake/cli.mjs', tsserver: '/fake/tsserver.js', version: '0' }),
      () => [],
      () => ({ port: undefined, brk: undefined }),
      undefined,
      remote,
    )

    const win1 = createWindowScopedExtensionHost(svc, 1)
    await win1.start({ authority: 'host' })

    await svc.stopAllForWindow(1)

    expect(remote.stops).toEqual([])
  })
})
