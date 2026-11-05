/*---------------------------------------------------------------------------------------------
 *  Tests for packages/node-services/src/process/processLifecycle.ts and its
 *  ManagedChildProcess integration (owner tracking, containment, two-phase reclaim).
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Emitter } from '@universe-editor/platform'
import { ManagedChildProcess } from '../managedChildProcess.js'
import {
  APP_OWNER,
  ProcessLifecycleRegistry,
  processGroupSpawnOptions,
  windowOwner,
  type JobBackend,
  type StoppableProcess,
} from '../processLifecycle.js'
import { loadJobBackend } from '../jobBackend.js'

class FakeBackend implements JobBackend {
  private _next = 100n
  readonly calls: string[] = []
  readonly members = new Map<bigint, number[]>()
  readonly closed = new Set<bigint>()
  assignStatus = 0
  createThrows = false
  terminateResult = true

  createJob(): bigint {
    if (this.createThrows) throw new Error('create failed')
    const job = this._next++
    this.members.set(job, [])
    this.calls.push(`create:${job}`)
    return job
  }
  assign(job: bigint, pid: number): number {
    this.calls.push(`assign:${job}:${pid}`)
    if (this.assignStatus === 0) this.members.get(job)?.push(pid)
    return this.assignStatus
  }
  terminate(job: bigint): boolean {
    this.calls.push(`terminate:${job}`)
    return this.terminateResult
  }
  close(job: bigint): boolean {
    this.calls.push(`close:${job}`)
    this.closed.add(job)
    return true
  }
  listPids(job: bigint): number[] {
    // Mirrors the real addon: querying a closed handle throws.
    if (this.closed.has(job)) throw new Error(`job ${job} is closed`)
    return [...(this.members.get(job) ?? [])]
  }
}

class InheritedJobBackend extends FakeBackend {
  /** Models Windows: a process already in another job can only join an EMPTY job. */
  override assign(job: bigint, pid: number): number {
    if ((this.members.get(job) ?? []).length > 0) {
      this.calls.push(`assign:${job}:${pid}`)
      return 5 // ERROR_ACCESS_DENIED
    }
    return super.assign(job, pid)
  }
}

class FakeTarget implements StoppableProcess {
  exited = false
  readonly stops: string[] = []
  /** Live onDidExit subscriptions — the registry must not leave these behind. */
  subscriptions = 0
  private readonly _exit = new Emitter<unknown>({
    onDidAddListener: () => {
      this.subscriptions++
    },
    onWillRemoveListener: () => {
      this.subscriptions--
    },
  })
  readonly onDidExit = this._exit.event
  /** When true, requestStop() makes the process exit by itself (cooperative child). */
  cooperative = true

  requestStop(): void {
    this.stops.push('stop')
    if (this.cooperative) this.exit()
  }
  hardKill(): void {
    this.stops.push('hard')
    this.exit()
  }
  exit(): void {
    if (this.exited) return
    this.exited = true
    this._exit.fire(undefined)
  }
}

function winRegistry(backend: JobBackend | null = new FakeBackend(), selfPid = 1) {
  return new ProcessLifecycleRegistry({
    ...(backend ? { backend } : {}),
    platform: 'win32',
    selfPid,
  })
}

describe('ProcessLifecycleRegistry (win32 job backend)', () => {
  it('gives every tracked process its own fresh job', () => {
    // Windows only lets a process that is already in a job join an EMPTY job (or one in
    // its own hierarchy), and every child inherits the editor's launch job — so jobs must
    // be per process tree, never per owner.
    const backend = new FakeBackend()
    const registry = winRegistry(backend)
    const a = registry.track({ pid: 10, owner: windowOwner(1), role: 'extension-host', label: 'a' })
    const b = registry.track({ pid: 11, owner: windowOwner(1), role: 'acp-agent', label: 'b' })
    const c = registry.track({ pid: 12, owner: windowOwner(2), role: 'pty', label: 'c' })
    expect(backend.calls).toEqual([
      'create:100',
      'assign:100:10',
      'create:101',
      'assign:101:11',
      'create:102',
      'assign:102:12',
    ])
    expect([a.contained, b.contained, c.contained]).toEqual([true, true, true])
    expect(registry.snapshot().map((e) => [e.pid, e.owner, e.role])).toEqual([
      [10, 'window:1', 'extension-host'],
      [11, 'window:1', 'acp-agent'],
      [12, 'window:2', 'pty'],
    ])
  })

  it('contains sibling processes that already sit in an inherited job', () => {
    // Regression guard for the per-owner design: with a shared job the second sibling was
    // refused with ACCESS_DENIED (the job was no longer empty and not in its hierarchy).
    const backend = new InheritedJobBackend()
    const registry = winRegistry(backend)
    const a = registry.track({ pid: 10, owner: windowOwner(1), role: 'acp-agent', label: 'a' })
    const b = registry.track({ pid: 11, owner: windowOwner(1), role: 'ripgrep', label: 'b' })
    expect([a.contained, b.contained]).toEqual([true, true])
    expect(registry.listJobPids(windowOwner(1)).sort((x, y) => x - y)).toEqual([10, 11])
  })

  it('closes the empty job when the process cannot be assigned', () => {
    const backend = new FakeBackend()
    backend.assignStatus = 5
    winRegistry(backend).track({ pid: 10, owner: windowOwner(1), role: 'r', label: 'l' })
    // Closing immediately matters: KILL_ON_JOB_CLOSE would otherwise take down a stranger
    // if the pid is reused before reclaim.
    expect(backend.calls).toEqual(['create:100', 'assign:100:10', 'close:100'])
  })

  it('closes a released process job once its tree is empty', () => {
    const backend = new FakeBackend()
    const registry = winRegistry(backend)
    registry.track({ pid: 10, owner: windowOwner(1), role: 'r', label: 'l' }).dispose()
    expect(backend.calls).toEqual(['create:100', 'assign:100:10', 'close:100'])
    expect(registry.listJobPids(windowOwner(1))).toEqual([])
  })

  it('never contains the editor itself or invalid pids', () => {
    const backend = new FakeBackend()
    const registry = winRegistry(backend, 777)
    expect(registry.track({ pid: 777, owner: APP_OWNER, role: 'x', label: 'self' }).contained).toBe(
      false,
    )
    expect(registry.track({ pid: 0, owner: APP_OWNER, role: 'x', label: 'zero' }).contained).toBe(
      false,
    )
    expect(backend.calls).toEqual([])
    expect(registry.snapshot()).toEqual([])
  })

  it('degrades (uncontained, never throws) when assign fails or the job cannot be created', () => {
    const backend = new FakeBackend()
    backend.assignStatus = 5
    const registry = winRegistry(backend)
    const lease = registry.track({ pid: 10, owner: windowOwner(1), role: 'r', label: 'l' })
    expect(lease.contained).toBe(false)
    expect(lease.rejected).toBe(false)

    const broken = new FakeBackend()
    broken.createThrows = true
    const registry2 = winRegistry(broken)
    expect(registry2.track({ pid: 10, owner: APP_OWNER, role: 'r', label: 'l' }).contained).toBe(
      false,
    )
    // a second track on a failed slot does not retry job creation each time
    registry2.track({ pid: 11, owner: APP_OWNER, role: 'r', label: 'l' })
    expect(broken.calls).toEqual([])
  })

  it('is a recorded-but-uncontained no-op without a backend', () => {
    const registry = winRegistry(null)
    const lease = registry.track({ pid: 10, owner: windowOwner(1), role: 'r', label: 'l' })
    expect(lease.contained).toBe(false)
    expect(registry.snapshot()).toHaveLength(1)
    lease.dispose()
    expect(registry.snapshot()).toHaveLength(0)
  })

  it('keeps the first registration when the same pid is tracked twice', () => {
    const backend = new FakeBackend()
    const registry = winRegistry(backend)
    registry.track({ pid: 10, owner: windowOwner(1), role: 'a', label: 'first' })
    const dup = registry.track({ pid: 10, owner: windowOwner(2), role: 'b', label: 'second' })
    expect(dup.contained).toBe(true)
    expect(backend.calls).toEqual(['create:100', 'assign:100:10'])
    expect(registry.snapshot()).toHaveLength(1)
  })

  it('release only removes its own entry (pid reuse safe)', () => {
    const registry = winRegistry()
    const target = new FakeTarget()
    const first = registry.track({ pid: 10, owner: APP_OWNER, role: 'a', label: 'old', target })
    target.exit() // process died without releasing; pid is reused
    registry.track({ pid: 10, owner: APP_OWNER, role: 'a', label: 'new' })
    first.dispose()
    expect(registry.snapshot().map((e) => e.label)).toEqual(['new'])
  })

  describe('reclaimOwner', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('asks politely first and only hard-kills the job after the targets exited', async () => {
      const backend = new FakeBackend()
      const registry = winRegistry(backend)
      const host = new FakeTarget()
      registry.track({
        pid: 10,
        owner: windowOwner(1),
        role: 'extension-host',
        label: 'h',
        target: host,
      })

      const report = await registry.reclaimOwner(windowOwner(1), { reason: 'window-closed' })

      expect(host.stops).toEqual(['stop'])
      expect(report.gracefullyExited).toBe(1)
      // order: graceful stop strictly before terminate/close
      expect(backend.calls.slice(-2)).toEqual(['terminate:100', 'close:100'])
      expect(report.hardKilledPids).toEqual([10])
      expect(registry.snapshot()).toEqual([])
    })

    it('waits out the grace window for a stubborn child, then terminates the job', async () => {
      const backend = new FakeBackend()
      const registry = winRegistry(backend)
      const stubborn = new FakeTarget()
      stubborn.cooperative = false
      registry.track({ pid: 10, owner: windowOwner(1), role: 'r', label: 'l', target: stubborn })

      const pending = registry.reclaimOwner(windowOwner(1), { reason: 'x', graceMs: 1000 })
      await vi.advanceTimersByTimeAsync(999)
      expect(backend.calls.some((c) => c.startsWith('terminate'))).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const report = await pending

      expect(backend.calls.slice(-2)).toEqual(['terminate:100', 'close:100'])
      expect(report.gracefullyExited).toBe(0)
      expect(report.hardKilledPids).toEqual([10])
    })

    it('detaches the slot synchronously so a reloaded generation is not reaped', async () => {
      const backend = new FakeBackend()
      const registry = winRegistry(backend)
      const old = new FakeTarget()
      old.cooperative = false
      registry.track({ pid: 10, owner: windowOwner(1), role: 'r', label: 'old', target: old })

      const pending = registry.reclaimOwner(windowOwner(1), {
        reason: 'window-reloaded',
        graceMs: 500,
      })
      // The reloaded renderer spawns again under the same window id while the old
      // generation is still in its grace period.
      const fresh = registry.track({ pid: 20, owner: windowOwner(1), role: 'r', label: 'new' })
      expect(fresh.rejected).toBe(false)
      await vi.advanceTimersByTimeAsync(500)
      await pending

      expect(backend.calls).toContain('terminate:100')
      expect(backend.calls).not.toContain('terminate:101')
      expect(registry.snapshot().map((e) => e.pid)).toEqual([20])
    })

    it('rejects spawns for a retired owner so in-flight starts stop themselves', async () => {
      const registry = winRegistry()
      await registry.reclaimOwner(windowOwner(3), { reason: 'window-closed', retire: true })
      const lease = registry.track({ pid: 10, owner: windowOwner(3), role: 'r', label: 'late' })
      expect(lease.rejected).toBe(true)
      // other owners and non-retiring reclaims stay usable
      expect(
        registry.track({ pid: 11, owner: windowOwner(4), role: 'r', label: 'ok' }).rejected,
      ).toBe(false)
    })

    it('falls back to the target hard kill for uncontained survivors', async () => {
      const backend = new FakeBackend()
      backend.assignStatus = 5
      const registry = winRegistry(backend)
      const stubborn = new FakeTarget()
      stubborn.cooperative = false
      registry.track({ pid: 10, owner: windowOwner(1), role: 'r', label: 'l', target: stubborn })

      const pending = registry.reclaimOwner(windowOwner(1), { reason: 'x', graceMs: 100 })
      await vi.advanceTimersByTimeAsync(100)
      const report = await pending

      expect(stubborn.stops).toEqual(['stop', 'hard'])
      expect(report.uncontainedKilled).toBe(1)
    })

    it('uses the pid killer for uncontained entries that have no target', async () => {
      const killPid = vi.fn()
      const registry = new ProcessLifecycleRegistry({ platform: 'win32', selfPid: 1, killPid })
      registry.track({ pid: 10, owner: APP_OWNER, role: 'utility', label: 'watcher' })
      await registry.reclaimOwner(APP_OWNER, { reason: 'x' })
      expect(killPid).toHaveBeenCalledWith(10)
    })

    it('reclaiming an unknown owner is a harmless no-op', async () => {
      const report = await winRegistry().reclaimOwner(windowOwner(99), { reason: 'x' })
      expect(report.tracked).toBe(0)
    })

    it('ignores the late exit of a hard-killed target (no use-after-close)', async () => {
      const backend = new FakeBackend()
      const registry = winRegistry(backend)
      const stubborn = new FakeTarget()
      stubborn.cooperative = false
      const lease = registry.track({
        pid: 10,
        owner: windowOwner(1),
        role: 'r',
        label: 'l',
        target: stubborn,
      })

      const pending = registry.reclaimOwner(windowOwner(1), { reason: 'x', graceMs: 100 })
      await vi.advanceTimersByTimeAsync(100)
      await pending
      const callsAfterReclaim = backend.calls.length

      // The killed process reports its exit afterwards; the handle is closed and could be
      // reused, so the release must not list/close it again.
      stubborn.exit()
      lease.dispose()
      expect(backend.calls.length).toBe(callsAfterReclaim)
    })

    it('falls back to the target hard kill when the job cannot be terminated', async () => {
      const backend = new FakeBackend()
      backend.terminateResult = false
      const registry = winRegistry(backend)
      const stubborn = new FakeTarget()
      stubborn.cooperative = false
      registry.track({ pid: 10, owner: windowOwner(1), role: 'r', label: 'l', target: stubborn })

      const pending = registry.reclaimOwner(windowOwner(1), { reason: 'x', graceMs: 100 })
      await vi.advanceTimersByTimeAsync(100)
      const report = await pending

      expect(stubborn.stops).toEqual(['stop', 'hard'])
      expect(report.uncontainedKilled).toBe(1)
    })

    it('sweeps a released job once its surviving descendants exit', () => {
      const backend = new FakeBackend()
      const registry = winRegistry(backend)
      const lease = registry.track({ pid: 10, owner: APP_OWNER, role: 'r', label: 'l' })
      // A descendant outlived the tracked parent: release keeps the job for reclaim.
      backend.members.get(100n)!.push(11)
      lease.dispose()
      expect(backend.calls).not.toContain('close:100')

      // Descendant gone before the delayed re-check: the handle is released.
      backend.members.set(100n, [])
      vi.advanceTimersByTime(5000)
      expect(backend.calls).toContain('close:100')
    })
  })

  it('dispose terminates every job synchronously and rejects later tracking', () => {
    const backend = new FakeBackend()
    const registry = winRegistry(backend)
    registry.track({ pid: 10, owner: windowOwner(1), role: 'r', label: 'l' })
    registry.track({ pid: 11, owner: APP_OWNER, role: 'r', label: 'l' })
    registry.dispose()
    expect(backend.calls.filter((c) => c.startsWith('terminate')).sort()).toEqual([
      'terminate:100',
      'terminate:101',
    ])
    expect(registry.track({ pid: 12, owner: APP_OWNER, role: 'r', label: 'l' }).rejected).toBe(true)
  })
})

describe('ProcessLifecycleRegistry (POSIX process groups)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('group-kills detached leaders on reclaim, even after the leader exited', async () => {
    const killGroup = vi.fn()
    const registry = new ProcessLifecycleRegistry({ platform: 'linux', selfPid: 1, killGroup })
    const host = new FakeTarget()
    const lease = registry.track({
      pid: 4000,
      owner: windowOwner(1),
      role: 'extension-host',
      label: 'h',
      processGroup: true,
      target: host,
    })
    expect(lease.contained).toBe(true)
    // leader exits cleanly; its group can still hold an orphaned tsserver
    host.exit()

    await registry.reclaimOwner(windowOwner(1), { reason: 'window-closed' })
    // a real group (pid 4000) does not exist on the test machine; the kill is still issued
    // because the registry cannot know the group is empty without probing.
    expect(killGroup).toHaveBeenCalledWith(4000)
  })

  it('reaps a group whose leader exited but left descendants, then forgets it', () => {
    const killGroup = vi.fn()
    const registry = new ProcessLifecycleRegistry({
      platform: 'linux',
      selfPid: 1,
      killGroup,
      groupAlive: () => true,
    })
    const lease = registry.track({
      pid: 4100,
      owner: windowOwner(1),
      role: 'pty',
      label: 'p',
      processGroup: true,
    })
    lease.dispose()
    expect(killGroup).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5000)
    expect(killGroup).toHaveBeenCalledWith(4100)
  })

  it('does not reap a group that was already emptied or whose pid was re-tracked', () => {
    const killGroup = vi.fn()
    let alive = true
    const registry = new ProcessLifecycleRegistry({
      platform: 'linux',
      selfPid: 1,
      killGroup,
      groupAlive: () => alive,
    })
    const first = registry.track({
      pid: 4200,
      owner: APP_OWNER,
      role: 'r',
      label: 'a',
      processGroup: true,
    })
    first.dispose()
    // same pid handed to a new tracked process before the timer fires: its group is live, not an orphan
    registry.track({ pid: 4200, owner: APP_OWNER, role: 'r', label: 'b', processGroup: true })
    vi.advanceTimersByTime(5000)
    expect(killGroup).not.toHaveBeenCalled()

    alive = false
    const second = registry.track({
      pid: 4300,
      owner: APP_OWNER,
      role: 'r',
      label: 'c',
      processGroup: true,
    })
    second.dispose()
    vi.advanceTimersByTime(5000)
    expect(killGroup).not.toHaveBeenCalled()
  })

  it('does not kill an orphan group whose pid was reused by another owner', async () => {
    const killGroup = vi.fn()
    const registry = new ProcessLifecycleRegistry({
      platform: 'linux',
      selfPid: 1,
      killGroup,
      groupAlive: () => true,
    })
    registry
      .track({ pid: 4500, owner: windowOwner(1), role: 'pty', label: 'a', processGroup: true })
      .dispose()
    // The orphan timer is pending; the pgid is recycled by another owner before it fires.
    registry.track({
      pid: 4500,
      owner: windowOwner(2),
      role: 'pty',
      label: 'b',
      processGroup: true,
    })
    vi.advanceTimersByTime(5000)
    expect(killGroup).not.toHaveBeenCalled()

    // The stale pgid must also be gone from the old owner's slot, or its reclaim would
    // signal window 2's unrelated process group.
    await registry.reclaimOwner(windowOwner(1), { reason: 'x' })
    expect(killGroup).not.toHaveBeenCalled()
  })

  it('dispose hard-kills an owner whose reclaim is still in its grace window', async () => {
    const killGroup = vi.fn()
    const registry = new ProcessLifecycleRegistry({ platform: 'linux', selfPid: 1, killGroup })
    const stubborn = new FakeTarget()
    stubborn.cooperative = false
    registry.track({
      pid: 4400,
      owner: windowOwner(1),
      role: 'r',
      label: 'l',
      processGroup: true,
      target: stubborn,
    })
    const pending = registry.reclaimOwner(windowOwner(1), { reason: 'x', graceMs: 1000 })
    registry.dispose()
    expect(killGroup).toHaveBeenCalledWith(4400)
    await vi.advanceTimersByTimeAsync(1000)
    await pending
  })

  it('dispose settles the in-flight grace wait so its exit subscriptions are released', async () => {
    // The wait's timer is unref'd and cannot fire before process exit, where the main
    // tracker snapshots leaks — quitting mid-reclaim must unsubscribe synchronously.
    const registry = new ProcessLifecycleRegistry({ platform: 'linux', selfPid: 1 })
    const stubborn = new FakeTarget()
    stubborn.cooperative = false
    registry.track({
      pid: 4401,
      owner: windowOwner(1),
      role: 'r',
      label: 'l',
      processGroup: true,
      target: stubborn,
    })
    const pending = registry.reclaimOwner(windowOwner(1), { reason: 'x', graceMs: 1000 })
    expect(stubborn.subscriptions).toBe(1)
    registry.dispose()
    expect(stubborn.subscriptions).toBe(0)
    await pending
  })

  it('does not treat non-detached children as contained', () => {
    const registry = new ProcessLifecycleRegistry({ platform: 'linux', selfPid: 1 })
    expect(registry.track({ pid: 4000, owner: APP_OWNER, role: 'r', label: 'l' }).contained).toBe(
      false,
    )
  })

  it('refuses to group-kill pid 1 or itself', async () => {
    const killGroup = vi.fn()
    const registry = new ProcessLifecycleRegistry({ platform: 'linux', selfPid: 555, killGroup })
    registry.track({ pid: 1, owner: APP_OWNER, role: 'r', label: 'l', processGroup: true })
    await registry.reclaimOwner(APP_OWNER, { reason: 'x' })
    expect(killGroup).not.toHaveBeenCalled()
  })
})

describe('processGroupSpawnOptions', () => {
  it('detaches on POSIX only (Windows would allocate a new console)', () => {
    expect(processGroupSpawnOptions('linux')).toEqual({ detached: true })
    expect(processGroupSpawnOptions('darwin')).toEqual({ detached: true })
    expect(processGroupSpawnOptions('win32')).toEqual({})
  })
})

describe('loadJobBackend', () => {
  it('is off-platform / disabled safe', () => {
    expect(loadJobBackend('/nope', { platform: 'linux' })).toBeUndefined()
    expect(loadJobBackend('C:/missing.node', { platform: 'win32' })).toBeUndefined()
  })

  it('rejects an addon with an unexpected shape and swallows load errors', () => {
    expect(
      loadJobBackend('x', { platform: 'win32', load: () => ({ createJob() {} }) }),
    ).toBeUndefined()
    expect(
      loadJobBackend('x', {
        platform: 'win32',
        load: () => {
          throw new Error('dlopen failed')
        },
      }),
    ).toBeUndefined()
  })

  it('accepts a complete addon', () => {
    const backend = new FakeBackend()
    const loaded = loadJobBackend('x', { platform: 'win32', load: () => backend })
    expect(loaded).toBe(backend)
  })
})

// --- ManagedChildProcess integration ----------------------------------------------------

class FakeStream extends EventEmitter {
  destroyed = false
  writable = true
  ended = false
  write(_d: string, _e: string, cb: (err?: Error | null) => void): boolean {
    cb(null)
    return true
  }
  end(): void {
    this.ended = true
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly stdin = new FakeStream()
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = []
  constructor(readonly pid: number | undefined = 4242) {
    super()
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    return true
  }
  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams
  }
}

describe('ManagedChildProcess lifecycle binding', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tracks on construction and releases on exit', () => {
    const registry = winRegistry()
    const child = new FakeChild()
    const managed = new ManagedChildProcess(child.asChild(), {
      lifecycle: { registry, owner: windowOwner(1), role: 'acp-agent' },
      label: 'h1',
    })
    expect(registry.snapshot()).toMatchObject([
      { pid: 4242, owner: 'window:1', role: 'acp-agent', label: 'h1' },
    ])
    expect(managed.contained).toBe(true)
    child.emit('exit', 0, null)
    expect(registry.snapshot()).toEqual([])
    managed.dispose()
  })

  it('does not track a child that failed to spawn (no pid)', () => {
    const registry = winRegistry()
    new ManagedChildProcess(new FakeChild(undefined).asChild(), {
      lifecycle: { registry, owner: APP_OWNER, role: 'r' },
    }).dispose()
    expect(registry.snapshot()).toEqual([])
  })

  it('kills itself immediately when its owner was already retired', async () => {
    const registry = winRegistry()
    await registry.reclaimOwner(windowOwner(7), { reason: 'closed', retire: true })
    const child = new FakeChild()
    new ManagedChildProcess(child.asChild(), {
      lifecycle: { registry, owner: windowOwner(7), role: 'extension-host' },
    })
    expect(child.killSignals).toEqual(['SIGTERM'])
  })

  it('stdin-eof reclaim closes stdin first and escalates to kill after the timeout', async () => {
    const backend = new FakeBackend()
    const registry = winRegistry(backend)
    const child = new FakeChild()
    const managed = new ManagedChildProcess(child.asChild(), {
      killTimeoutMs: 2000,
      lifecycle: { registry, owner: windowOwner(1), role: 'extension-host', stop: 'stdin-eof' },
    })

    const pending = registry.reclaimOwner(windowOwner(1), {
      reason: 'window-closed',
      graceMs: 3000,
    })
    expect(child.stdin.ended).toBe(true)
    expect(child.killSignals).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(child.killSignals).toEqual(['SIGTERM'])
    child.emit('exit', 0, null)
    const report = await pending
    expect(report.gracefullyExited).toBe(1)
    managed.dispose()
  })

  it('hardKill bypasses the grace timer and kills the process group on POSIX', () => {
    if (process.platform === 'win32') return
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const child = new FakeChild(4343)
      const managed = new ManagedChildProcess(child.asChild(), { processGroup: true })
      managed.kill()
      managed.hardKill()
      expect(killSpy).toHaveBeenCalledWith(-4343, 'SIGTERM')
      expect(killSpy).toHaveBeenCalledWith(-4343, 'SIGKILL')
      managed.dispose()
    } finally {
      killSpy.mockRestore()
    }
  })
})
