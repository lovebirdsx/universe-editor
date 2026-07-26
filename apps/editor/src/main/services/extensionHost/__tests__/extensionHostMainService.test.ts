/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/extensionHost/extensionHostMainService.ts
 *
 *  Focus: stderr level routing. The host tags every console call with a level
 *  prefix (see stdoutProtection.ts in packages/extension-host); main maps tagged
 *  lines to the matching log level instead of warning on all of them.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { markAsSingleton } from '@universe-editor/platform'
import { ExtensionHostMainService, type ExtHostSpawner } from '../extensionHostMainService.js'

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

function makeService(proc: FakeProc): {
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
  } as unknown as ConstructorParameters<typeof ExtensionHostMainService>[5]
  const spawner: ExtHostSpawner = () => proc as unknown as ChildProcessWithoutNullStreams
  const svc = new ExtensionHostMainService(
    spawner,
    () => '/fake/entry.js',
    () => '/fake/builtin',
    () => '/fake/user',
    () => ({ kind: 'tsls', cli: '/fake/cli.mjs', tsserver: '/fake/tsserver.js', version: '0' }),
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
