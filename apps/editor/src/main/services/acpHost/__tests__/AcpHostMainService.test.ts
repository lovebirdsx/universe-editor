/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/acpHost/acpHostMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  AcpHostMainService,
  type AcpCommandLookup,
  type AcpSpawner,
} from '../acpHostMainService.js'
import type { AcpExitEvent, AcpStdioChunk } from '../../../../shared/ipc/acpHostService.js'

// The service imports `app` from electron for the default runAsNode entry
// resolver; stub it so the module loads in the node test env. The runAsNode
// test injects its own resolver, so these values are never exercised.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app' },
}))

class FakeStdStream extends EventEmitter {
  setEncoding = vi.fn()
}

class FakeStdinStream extends EventEmitter {
  readonly writes: string[] = []
  destroyed = false
  writable = true
  write(data: string, _enc: string, cb: (err?: Error | null) => void): boolean {
    this.writes.push(data)
    cb(null)
    return true
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
  emitData(stream: 'stdout' | 'stderr', data: string): void {
    this[stream].emit('data', data)
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal)
  }
  emitError(err: Error): void {
    this.emit('error', err)
  }
}

function fakeSpawnerWith(procs: FakeProc[]): AcpSpawner {
  let i = 0
  return () => {
    const next = procs[i++]
    if (!next) throw new Error('FakeSpawner: no more procs queued')
    return next as unknown as ChildProcessWithoutNullStreams
  }
}

function makeService(spawner: AcpSpawner): AcpHostMainService {
  return new AcpHostMainService(spawner)
}

describe('AcpHostMainService', () => {
  let svc: AcpHostMainService

  afterEach(() => {
    svc?.dispose()
  })

  it('start returns a handle and fires onStdout chunks for that handle', async () => {
    const proc = new FakeProc()
    svc = makeService(fakeSpawnerWith([proc]))

    const stdoutChunks: AcpStdioChunk[] = []
    svc.onStdout((c) => stdoutChunks.push(c))

    const { handle } = await svc.start({ command: 'agent', args: [] })
    expect(handle).toBeTruthy()

    proc.emitData('stdout', 'line-1\n')
    proc.emitData('stdout', 'line-2\n')

    expect(stdoutChunks).toEqual([
      { handle, data: 'line-1\n' },
      { handle, data: 'line-2\n' },
    ])
  })

  it('routes stderr to onStderr keyed by handle', async () => {
    const proc = new FakeProc()
    svc = makeService(fakeSpawnerWith([proc]))

    const stderrChunks: AcpStdioChunk[] = []
    svc.onStderr((c) => stderrChunks.push(c))

    const { handle } = await svc.start({ command: 'agent', args: [] })
    proc.stderr.emit('data', Buffer.from('oops', 'utf8'))

    expect(stderrChunks).toEqual([{ handle, data: 'oops' }])
  })

  it('decodes valid UTF-8 stderr and falls back to the OEM code page for non-UTF-8 bytes', async () => {
    const proc = new FakeProc()
    svc = makeService(fakeSpawnerWith([proc]))

    const stderrChunks: AcpStdioChunk[] = []
    svc.onStderr((c) => stderrChunks.push(c))

    await svc.start({ command: 'agent', args: [] })

    // Valid UTF-8 (incl. multibyte) round-trips untouched.
    proc.stderr.emit('data', Buffer.from('hello 世界', 'utf8'))
    // GBK bytes for "你" (0xC4 0xE3) are invalid UTF-8 — must NOT mojibake into
    // the replacement character; the gb18030 fallback decodes them instead.
    const gbkBytes = Buffer.from([0xc4, 0xe3])
    proc.stderr.emit('data', gbkBytes)

    expect(stderrChunks[0]?.data).toBe('hello 世界')
    expect(stderrChunks[1]?.data).not.toContain('�')
    expect(stderrChunks[1]?.data).toBe(new TextDecoder('gb18030').decode(gbkBytes))
  })

  it('events from one handle do not leak to listeners filtering on another', async () => {
    const procA = new FakeProc()
    const procB = new FakeProc()
    svc = makeService(fakeSpawnerWith([procA, procB]))

    const allChunks: AcpStdioChunk[] = []
    svc.onStdout((c) => allChunks.push(c))

    const { handle: ha } = await svc.start({ command: 'a', args: [] })
    const { handle: hb } = await svc.start({ command: 'b', args: [] })
    expect(ha).not.toBe(hb)

    procA.emitData('stdout', 'from-a')
    procB.emitData('stdout', 'from-b')

    const fromA = allChunks.filter((c) => c.handle === ha)
    const fromB = allChunks.filter((c) => c.handle === hb)
    expect(fromA).toEqual([{ handle: ha, data: 'from-a' }])
    expect(fromB).toEqual([{ handle: hb, data: 'from-b' }])
  })

  it('writeStdin writes utf-8 to the matching proc and rejects for unknown/exited handles', async () => {
    const proc = new FakeProc()
    svc = makeService(fakeSpawnerWith([proc]))
    const { handle } = await svc.start({ command: 'agent', args: [] })

    await svc.writeStdin(handle, 'hello\n')
    expect(proc.stdin.writes).toEqual(['hello\n'])

    await expect(svc.writeStdin('does-not-exist', 'x')).rejects.toThrow(/unknown or exited/)
  })

  it('onExit fires exactly once with the handle, code, and signal', async () => {
    const proc = new FakeProc()
    svc = makeService(fakeSpawnerWith([proc]))

    const events: AcpExitEvent[] = []
    svc.onExit((e) => events.push(e))

    const { handle } = await svc.start({ command: 'agent', args: [] })
    proc.emitExit(0, null)
    // Spurious second exit must be ignored.
    proc.emitExit(1, 'SIGTERM')

    expect(events).toEqual([{ handle, code: 0, signal: null }])
    // After exit, writes reject.
    await expect(svc.writeStdin(handle, 'x')).rejects.toThrow(/unknown or exited/)
  })

  it('stop is a no-op for unknown handles and kills live procs once', async () => {
    const proc = new FakeProc()
    svc = makeService(fakeSpawnerWith([proc]))
    await svc.stop('never-started')

    const { handle } = await svc.start({ command: 'agent', args: [] })
    await svc.stop(handle)
    expect(proc.killCalls).toBe(1)

    // Calling stop a second time after the proc has exited should be a no-op.
    proc.emitExit(null, 'SIGTERM')
    await svc.stop(handle)
    expect(proc.killCalls).toBe(1)
  })

  it('dispose kills all live procs and clears its book-keeping', async () => {
    const procA = new FakeProc()
    const procB = new FakeProc()
    svc = makeService(fakeSpawnerWith([procA, procB]))

    await svc.start({ command: 'a', args: [] })
    await svc.start({ command: 'b', args: [] })

    svc.dispose()
    expect(procA.killCalls).toBe(1)
    expect(procB.killCalls).toBe(1)
  })

  it('rejects the start promise if spawn throws synchronously', async () => {
    const throwingSpawner: AcpSpawner = () => {
      throw new Error('ENOENT')
    }
    svc = makeService(throwingSpawner)
    await expect(svc.start({ command: 'missing', args: [] })).rejects.toThrow('ENOENT')
  })

  it('translates an async spawn error into a synthetic exit event', async () => {
    const proc = new FakeProc()
    svc = makeService(fakeSpawnerWith([proc]))
    const exits: AcpExitEvent[] = []
    svc.onExit((e) => exits.push(e))

    const { handle } = await svc.start({ command: 'agent', args: [] })
    proc.emitError(new Error('spawn npx ENOENT'))

    expect(exits).toEqual([{ handle, code: null, signal: null, error: 'spawn npx ENOENT' }])
    // After the synthetic exit, writeStdin must reject — without this, the
    // renderer would land in "Cannot call write after a stream was destroyed".
    await expect(svc.writeStdin(handle, 'x')).rejects.toThrow(/unknown or exited/)
    // A subsequent real exit must not double-fire.
    proc.emitExit(null, null)
    expect(exits).toHaveLength(1)
  })

  it('rejects writeStdin when stdin has been destroyed mid-flight', async () => {
    const proc = new FakeProc()
    svc = makeService(fakeSpawnerWith([proc]))
    const { handle } = await svc.start({ command: 'agent', args: [] })
    // Simulate the narrow race: stdin already destroyed but the exit event
    // has not yet propagated through the event loop.
    proc.stdin.destroyed = true
    await expect(svc.writeStdin(handle, 'x')).rejects.toThrow(/stdin is not writable/)
  })
})

describe('AcpHostMainService — env / cwd plumbing', () => {
  let svc: AcpHostMainService
  afterEach(() => {
    svc?.dispose()
  })

  it('passes cwd and merged env to the spawner', async () => {
    const proc = new FakeProc()
    const spawner = vi.fn(
      ((_cmd, _args, _opts) => proc as unknown as ChildProcessWithoutNullStreams) as AcpSpawner,
    )
    svc = new AcpHostMainService(spawner)
    await svc.start({
      command: 'agent',
      args: ['--flag'],
      cwd: '/some/path',
      env: { FOO: 'bar' },
    })
    expect(spawner).toHaveBeenCalledTimes(1)
    const call = spawner.mock.calls[0]!
    expect(call[0]).toBe('agent')
    expect(call[1]).toEqual(['--flag'])
    expect(call[2].cwd).toBe('/some/path')
    expect(call[2].env?.FOO).toBe('bar')
    // Inherited env should still be present.
    expect(call[2].env?.PATH ?? call[2].env?.Path).toBeDefined()
  })

  it('rejects non-absolute cwd to prevent unintended working-directory inheritance', async () => {
    const proc = new FakeProc()
    const spawner = vi.fn(
      ((_cmd, _args, _opts) => proc as unknown as ChildProcessWithoutNullStreams) as AcpSpawner,
    )
    svc = new AcpHostMainService(spawner)
    await expect(svc.start({ command: 'agent', args: [], cwd: 'relative/path' })).rejects.toThrow(
      /absolute path/,
    )
    expect(spawner).not.toHaveBeenCalled()
  })

  it('strips ELECTRON_RUN_AS_NODE / NODE_OPTIONS from inherited env before spawning', async () => {
    const proc = new FakeProc()
    const spawner = vi.fn(
      ((_cmd, _args, _opts) => proc as unknown as ChildProcessWithoutNullStreams) as AcpSpawner,
    )
    const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    const originalNodeOptions = process.env.NODE_OPTIONS
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.NODE_OPTIONS = '--inspect=9229'
    try {
      svc = new AcpHostMainService(spawner)
      await svc.start({ command: 'agent', args: [] })
      const call = spawner.mock.calls[0]!
      expect(call[2].env?.ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(call[2].env?.NODE_OPTIONS).toBeUndefined()
    } finally {
      if (originalRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = originalRunAsNode
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = originalNodeOptions
    }
  })

  it('refuses to honor denylisted env overrides supplied via spec.env', async () => {
    const proc = new FakeProc()
    const spawner = vi.fn(
      ((_cmd, _args, _opts) => proc as unknown as ChildProcessWithoutNullStreams) as AcpSpawner,
    )
    svc = new AcpHostMainService(spawner)
    await svc.start({
      command: 'agent',
      args: [],
      env: { NODE_OPTIONS: '--require ./evil.js', ELECTRON_RUN_AS_NODE: '1', SAFE: 'ok' },
    })
    const call = spawner.mock.calls[0]!
    expect(call[2].env?.NODE_OPTIONS).toBeUndefined()
    expect(call[2].env?.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(call[2].env?.SAFE).toBe('ok')
  })

  it('runAsNode launches the bundled entry via Electron-as-node', async () => {
    const proc = new FakeProc()
    const spawner = vi.fn(
      ((_cmd, _args, _opts) => proc as unknown as ChildProcessWithoutNullStreams) as AcpSpawner,
    )
    const entry = '/bundled/claude-agent-acp/dist/index.js'
    svc = new AcpHostMainService(spawner, undefined, () => entry)

    await svc.start({ command: 'claude-agent-acp', args: ['--flag'], runAsNode: true })

    const call = spawner.mock.calls[0]!
    expect(call[0]).toBe(process.execPath)
    expect(call[1]).toEqual([entry, '--flag'])
    // Re-added on the runAsNode path so the agent's self re-spawn inherits it.
    expect(call[2].env?.ELECTRON_RUN_AS_NODE).toBe('1')
    // execPath is a real binary — must not be routed through a shell.
    expect(call[2].shell).toBe(false)
  })
})

describe('AcpHostMainService — probe', () => {
  let svc: AcpHostMainService
  afterEach(() => {
    svc?.dispose()
  })

  it('returns true when the lookup hook reports the command is on PATH', async () => {
    const lookup = vi.fn(async () => true) as AcpCommandLookup
    svc = new AcpHostMainService(undefined, lookup)
    await expect(svc.probe('agent')).resolves.toBe(true)
  })

  it('returns false when the lookup hook reports the command is missing', async () => {
    const lookup = vi.fn(async () => false) as AcpCommandLookup
    svc = new AcpHostMainService(undefined, lookup)
    await expect(svc.probe('missing')).resolves.toBe(false)
  })

  it('returns false for empty command without invoking the lookup', async () => {
    const lookup = vi.fn(async () => true) as AcpCommandLookup
    svc = new AcpHostMainService(undefined, lookup)
    await expect(svc.probe('')).resolves.toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('swallows lookup errors and returns false', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('boom')
    }) as AcpCommandLookup
    svc = new AcpHostMainService(undefined, lookup)
    await expect(svc.probe('weird')).resolves.toBe(false)
  })
})
