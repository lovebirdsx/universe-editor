/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/process/managedChildProcess.ts
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  DEFAULT_KILL_TIMEOUT_MS,
  ManagedChildProcess,
  type ManagedExit,
} from '../managedChildProcess.js'

class FakeStream extends EventEmitter {
  destroyed = false
  writable = true
  write(_data: string, _enc: string, cb: (err?: Error | null) => void): boolean {
    cb(null)
    return true
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly stdin = new FakeStream()
  readonly pid = 4242
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = []
  killThrows = false

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    if (this.killThrows) throw new Error('kill failed')
    return true
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams
  }
}

describe('ManagedChildProcess', () => {
  let child: FakeChild

  beforeEach(() => {
    vi.useFakeTimers()
    child = new FakeChild()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bridges raw stdout / stderr buffers', () => {
    const managed = new ManagedChildProcess(child.asChild())
    const out: string[] = []
    const err: string[] = []
    managed.onStdout((b) => out.push(b.toString()))
    managed.onStderr((b) => err.push(b.toString()))

    child.stdout.emit('data', Buffer.from('hello'))
    child.stderr.emit('data', Buffer.from('oops'))

    expect(out).toEqual(['hello'])
    expect(err).toEqual(['oops'])
    managed.dispose()
  })

  it('escalates SIGTERM to SIGKILL after the timeout', () => {
    const managed = new ManagedChildProcess(child.asChild())
    let exit: ManagedExit | undefined
    managed.onDidExit((e) => (exit = e))

    managed.kill()
    expect(child.killSignals).toEqual(['SIGTERM'])

    vi.advanceTimersByTime(DEFAULT_KILL_TIMEOUT_MS)
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])

    // The real exit arrives after SIGKILL; it should be flagged as forced.
    child.emit('exit', null, 'SIGKILL')
    expect(exit).toEqual({ code: null, signal: 'SIGKILL', forced: true })
  })

  it('does not escalate when the process exits within the grace period', () => {
    const managed = new ManagedChildProcess(child.asChild())
    let exit: ManagedExit | undefined
    managed.onDidExit((e) => (exit = e))

    managed.kill()
    child.emit('exit', 0, null)
    vi.advanceTimersByTime(DEFAULT_KILL_TIMEOUT_MS * 2)

    expect(child.killSignals).toEqual(['SIGTERM'])
    expect(exit).toEqual({ code: 0, signal: null, forced: false })
  })

  it('honors a custom kill timeout', () => {
    const managed = new ManagedChildProcess(child.asChild(), { killTimeoutMs: 500 })
    managed.kill()
    vi.advanceTimersByTime(499)
    expect(child.killSignals).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(1)
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
    managed.dispose()
  })

  it('kill is idempotent — repeated calls do not re-arm escalation', () => {
    const managed = new ManagedChildProcess(child.asChild())
    managed.kill()
    managed.kill()
    managed.kill()
    expect(child.killSignals).toEqual(['SIGTERM'])
    managed.dispose()
  })

  it('surfaces a spawn error as a synthetic exit', () => {
    const managed = new ManagedChildProcess(child.asChild())
    let exit: ManagedExit | undefined
    managed.onDidExit((e) => (exit = e))

    child.emit('error', new Error('ENOENT'))
    expect(exit).toEqual({ code: null, signal: null, forced: false, error: 'ENOENT' })
  })

  it('fires exit exactly once', () => {
    const managed = new ManagedChildProcess(child.asChild())
    const exits: ManagedExit[] = []
    managed.onDidExit((e) => exits.push(e))

    child.emit('error', new Error('boom'))
    child.emit('exit', 1, null)
    expect(exits).toHaveLength(1)
  })

  it('writeStdin rejects after exit', async () => {
    const managed = new ManagedChildProcess(child.asChild())
    child.emit('exit', 0, null)
    await expect(managed.writeStdin('data')).rejects.toThrow(/has exited/)
  })

  it('writeStdin rejects when stdin is not writable', async () => {
    const managed = new ManagedChildProcess(child.asChild())
    child.stdin.writable = false
    await expect(managed.writeStdin('data')).rejects.toThrow(/not writable/)
    managed.dispose()
  })

  it('dispose sends SIGKILL to a still-running child', () => {
    const managed = new ManagedChildProcess(child.asChild())
    managed.dispose()
    expect(child.killSignals).toEqual(['SIGKILL'])
  })

  it('dispose does not kill an already-exited child', () => {
    const managed = new ManagedChildProcess(child.asChild())
    child.emit('exit', 0, null)
    managed.dispose()
    expect(child.killSignals).toEqual([])
  })

  describe('treeKill (Windows shell-wrapped children)', () => {
    const realPlatform = process.platform
    const setPlatform = (value: NodeJS.Platform): void => {
      Object.defineProperty(process, 'platform', { value, configurable: true })
    }
    afterEach(() => setPlatform(realPlatform))

    it('kill() force-kills the PID tree in one shot instead of SIGTERM (win32)', () => {
      setPlatform('win32')
      const killed: Array<{ pid: number; sync: boolean }> = []
      const managed = new ManagedChildProcess(child.asChild(), {
        treeKill: true,
        killTree: (pid, sync) => killed.push({ pid, sync: sync ?? false }),
      })
      let exit: ManagedExit | undefined
      managed.onDidExit((e) => (exit = e))

      managed.kill()
      // No SIGTERM/SIGKILL to the wrapper — the whole tree is reaped directly.
      // A caller-initiated kill uses the async (non-blocking) tree-kill.
      expect(child.killSignals).toEqual([])
      expect(killed).toEqual([{ pid: child.pid, sync: false }])

      // No escalation timer is armed; advancing time is a no-op.
      vi.advanceTimersByTime(DEFAULT_KILL_TIMEOUT_MS * 2)
      expect(killed).toEqual([{ pid: child.pid, sync: false }])

      child.emit('exit', null, 'SIGKILL')
      expect(exit).toEqual({ code: null, signal: 'SIGKILL', forced: true })
    })

    it('dispose() force-kills the PID tree synchronously (win32)', () => {
      setPlatform('win32')
      const killed: Array<{ pid: number; sync: boolean }> = []
      const managed = new ManagedChildProcess(child.asChild(), {
        treeKill: true,
        killTree: (pid, sync) => killed.push({ pid, sync: sync ?? false }),
      })
      managed.dispose()
      expect(child.killSignals).toEqual([])
      // dispose() runs on the synchronous will-quit path, so it must block until
      // the tree is reaped — otherwise the grandchild survives the main exit.
      expect(killed).toEqual([{ pid: child.pid, sync: true }])
    })

    it('falls back to SIGTERM off Windows even when treeKill is set', () => {
      setPlatform('linux')
      const killed: number[] = []
      const managed = new ManagedChildProcess(child.asChild(), {
        treeKill: true,
        killTree: (pid) => killed.push(pid),
      })
      managed.kill()
      expect(killed).toEqual([])
      expect(child.killSignals).toEqual(['SIGTERM'])
      managed.dispose()
    })

    it('kill() is idempotent under treeKill', () => {
      setPlatform('win32')
      const killed: number[] = []
      const managed = new ManagedChildProcess(child.asChild(), {
        treeKill: true,
        killTree: (pid) => killed.push(pid),
      })
      managed.kill()
      managed.kill()
      managed.kill()
      expect(killed).toEqual([child.pid])
    })
  })
})
