/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/acpTerminal/acpTerminalMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NullLogger } from '@universe-editor/platform'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { AcpTerminalMainService, type AcpTerminalSpawner } from '../acpTerminalMainService.js'

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
  killCalls = 0
  kill(): boolean {
    this.killCalls++
    return true
  }
  emit_(stream: 'stdout' | 'stderr', data: string): void {
    this[stream].emit('data', data)
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal)
  }
  emitError(err: Error): void {
    this.emit('error', err)
  }
}

function spawnerWith(procs: FakeProc[]): AcpTerminalSpawner {
  let i = 0
  return () => {
    const next = procs[i++]
    if (!next) throw new Error('FakeSpawner: no more procs queued')
    return next as unknown as ChildProcessWithoutNullStreams
  }
}

function makeService(spawner: AcpTerminalSpawner): AcpTerminalMainService {
  return new AcpTerminalMainService(new NullLogger(), spawner)
}

describe('AcpTerminalMainService — basics', () => {
  let svc: AcpTerminalMainService
  afterEach(() => {
    svc?.dispose()
  })

  it('create returns a terminalId and routes stdout/stderr into the buffer', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({ command: 'ls', args: [] })
    expect(terminalId).toBeTruthy()

    proc.emit_('stdout', 'hello ')
    proc.emit_('stderr', 'world\n')

    const snap = await svc.output(terminalId)
    expect(snap.output).toBe('hello world\n')
    expect(snap.truncated).toBe(false)
    expect(snap.exitStatus).toBeUndefined()
  })

  it('returns exitStatus on output() once the proc exits', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({ command: 'ls', args: [] })
    proc.emit_('stdout', 'done')
    proc.emitExit(0, null)

    const snap = await svc.output(terminalId)
    expect(snap.output).toBe('done')
    expect(snap.exitStatus).toEqual({ exitCode: 0 })
  })

  it('waitForExit resolves when the process exits', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({ command: 'sleep', args: [] })
    const promise = svc.waitForExit(terminalId)

    // Promise should still be pending — drive it via a microtask race.
    let resolved = false
    void promise.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    proc.emitExit(42, null)
    await expect(promise).resolves.toEqual({ exitCode: 42 })
  })

  it('waitForExit resolves synchronously when the proc has already exited', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({ command: 'ls', args: [] })
    proc.emitExit(7, null)
    await expect(svc.waitForExit(terminalId)).resolves.toEqual({ exitCode: 7 })
  })

  it('reports the unix signal when the proc was killed by one', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({ command: 'sleep', args: [] })
    proc.emitExit(null, 'SIGTERM')
    const exit = await svc.waitForExit(terminalId)
    expect(exit).toEqual({ signal: 'SIGTERM' })
  })

  it('kill triggers proc.kill but is a no-op if the proc already exited', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({ command: 'sleep', args: [] })
    await svc.kill(terminalId)
    expect(proc.killCalls).toBe(1)

    proc.emitExit(null, 'SIGTERM')
    await svc.kill(terminalId)
    expect(proc.killCalls).toBe(1)
  })
})

describe('AcpTerminalMainService — buffering policy', () => {
  let svc: AcpTerminalMainService
  afterEach(() => {
    svc?.dispose()
  })

  it('respects outputByteLimit and reports truncated=true after head drop', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({
      command: 'noisy',
      args: [],
      outputByteLimit: 1024,
    })

    proc.emit_('stdout', 'a'.repeat(800))
    let snap = await svc.output(terminalId)
    expect(snap.output.length).toBe(800)
    expect(snap.truncated).toBe(false)

    // Spill past the limit — head should drop.
    proc.emit_('stdout', 'b'.repeat(400))
    snap = await svc.output(terminalId)
    expect(snap.output.length).toBe(1024)
    // Tail bytes must be the most recent ones.
    expect(snap.output.endsWith('b'.repeat(400))).toBe(true)
    expect(snap.truncated).toBe(true)
  })

  it('clamps an agent-supplied outputByteLimit below the minimum floor', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({
      command: 'noisy',
      args: [],
      outputByteLimit: 0,
    })
    // Floor is 1024 — so a 500-byte chunk does NOT trigger truncation.
    proc.emit_('stdout', 'x'.repeat(500))
    const snap = await svc.output(terminalId)
    expect(snap.output.length).toBe(500)
    expect(snap.truncated).toBe(false)
  })

  it('clamps an agent-supplied outputByteLimit above the absolute ceiling', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    // Ask for 1GB — the service must cap us at 16 MiB.
    const { terminalId } = await svc.create({
      command: 'noisy',
      args: [],
      outputByteLimit: 1_000_000_000,
    })
    const big = 'a'.repeat(17 * 1024 * 1024)
    proc.emit_('stdout', big)
    const snap = await svc.output(terminalId)
    expect(snap.output.length).toBe(16 * 1024 * 1024)
    expect(snap.truncated).toBe(true)
  })
})

describe('AcpTerminalMainService — release and unknown terminal handling', () => {
  let svc: AcpTerminalMainService
  afterEach(() => {
    svc?.dispose()
  })

  it('release kills a live proc, clears state, and rejects subsequent operations', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({ command: 'sleep', args: [] })

    await svc.release(terminalId)
    expect(proc.killCalls).toBe(1)
    await expect(svc.output(terminalId)).rejects.toThrow(/unknown terminal/)
    await expect(svc.kill(terminalId)).rejects.toThrow(/unknown terminal/)
    await expect(svc.waitForExit(terminalId)).rejects.toThrow(/unknown terminal/)
  })

  it('release rejects in-flight waitForExit promises with a release sentinel', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({ command: 'sleep', args: [] })

    const waiter = svc.waitForExit(terminalId)
    await svc.release(terminalId)
    await expect(waiter).rejects.toThrow(/released/)
  })

  it('release on a non-existent terminal is a no-op', async () => {
    svc = makeService(spawnerWith([]))
    await expect(svc.release('does-not-exist')).resolves.toBeUndefined()
  })

  it('output / kill / waitForExit reject for unknown ids', async () => {
    svc = makeService(spawnerWith([]))
    await expect(svc.output('nope')).rejects.toThrow(/unknown terminal/)
    await expect(svc.kill('nope')).rejects.toThrow(/unknown terminal/)
    await expect(svc.waitForExit('nope')).rejects.toThrow(/unknown terminal/)
  })
})

describe('AcpTerminalMainService — env / cwd / spawn errors', () => {
  let svc: AcpTerminalMainService
  afterEach(() => {
    svc?.dispose()
  })

  it('rejects non-absolute cwd', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    await expect(svc.create({ command: 'ls', args: [], cwd: 'relative/dir' })).rejects.toThrow(
      /absolute path/,
    )
  })

  it('passes args, cwd, and merged env to the spawner', async () => {
    const proc = new FakeProc()
    const spawner = vi.fn(
      ((_cmd, _args, _opts) =>
        proc as unknown as ChildProcessWithoutNullStreams) as AcpTerminalSpawner,
    )
    svc = new AcpTerminalMainService(new NullLogger(), spawner)
    await svc.create({
      command: 'cmd',
      args: ['--flag'],
      cwd: '/abs/dir',
      env: [{ name: 'FOO', value: 'bar' }],
    })
    const call = spawner.mock.calls[0]!
    expect(call[0]).toBe('cmd')
    expect(call[1]).toEqual(['--flag'])
    expect(call[2].cwd).toBe('/abs/dir')
    expect(call[2].env?.FOO).toBe('bar')
    expect(call[2].env?.PATH ?? call[2].env?.Path).toBeDefined()
  })

  it('strips ELECTRON_RUN_AS_NODE / NODE_OPTIONS from inherited env', async () => {
    const proc = new FakeProc()
    const spawner = vi.fn(
      ((_cmd, _args, _opts) =>
        proc as unknown as ChildProcessWithoutNullStreams) as AcpTerminalSpawner,
    )
    const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    const originalNodeOptions = process.env.NODE_OPTIONS
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.NODE_OPTIONS = '--inspect=9229'
    try {
      svc = new AcpTerminalMainService(new NullLogger(), spawner)
      await svc.create({ command: 'cmd', args: [] })
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

  it('refuses denylisted env overrides supplied via spec.env', async () => {
    const proc = new FakeProc()
    const spawner = vi.fn(
      ((_cmd, _args, _opts) =>
        proc as unknown as ChildProcessWithoutNullStreams) as AcpTerminalSpawner,
    )
    svc = new AcpTerminalMainService(new NullLogger(), spawner)
    await svc.create({
      command: 'cmd',
      args: [],
      env: [
        { name: 'NODE_OPTIONS', value: '--require ./evil.js' },
        { name: 'SAFE', value: 'ok' },
      ],
    })
    const call = spawner.mock.calls[0]!
    expect(call[2].env?.NODE_OPTIONS).toBeUndefined()
    expect(call[2].env?.SAFE).toBe('ok')
  })

  it('rejects empty command', async () => {
    svc = makeService(spawnerWith([]))
    await expect(svc.create({ command: '', args: [] })).rejects.toThrow(/non-empty/)
  })

  it('rejects synchronous spawn errors with the underlying message', async () => {
    const throwing: AcpTerminalSpawner = () => {
      throw new Error('ENOENT cmd')
    }
    svc = makeService(throwing)
    await expect(svc.create({ command: 'missing', args: [] })).rejects.toThrow('ENOENT cmd')
  })

  it('translates an async spawn error into a synthetic exit and unblocks waiters', async () => {
    const proc = new FakeProc()
    svc = makeService(spawnerWith([proc]))
    const { terminalId } = await svc.create({ command: 'cmd', args: [] })
    const waiter = svc.waitForExit(terminalId)
    proc.emitError(new Error('spawn cmd ENOENT'))
    const exit = await waiter
    expect(exit.signal).toBe('SPAWN_ERROR')
    // Subsequent real exit must not double-fire (entry.exit is set).
    proc.emitExit(0, null)
    const snap = await svc.output(terminalId)
    expect(snap.exitStatus?.signal).toBe('SPAWN_ERROR')
    expect(snap.output).toContain('[spawn error] spawn cmd ENOENT')
  })

  it('dispose kills all live procs and rejects in-flight waiters', async () => {
    const procA = new FakeProc()
    const procB = new FakeProc()
    svc = makeService(spawnerWith([procA, procB]))
    const a = (await svc.create({ command: 'a', args: [] })).terminalId
    await svc.create({ command: 'b', args: [] })
    const waiter = svc.waitForExit(a)
    svc.dispose()
    expect(procA.killCalls).toBe(1)
    expect(procB.killCalls).toBe(1)
    await expect(waiter).rejects.toThrow(/disposed/)
  })
})
