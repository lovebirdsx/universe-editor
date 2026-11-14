/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OS-level process lifecycle binding ("layer 4" of the orphan-process defence).
 *
 *  Every locally spawned long-lived child is tracked under an OWNER (one window, or the
 *  app itself) and, where the OS allows it, contained in a per-owner kernel object so
 *  its WHOLE tree — including grandchildren the editor never sees (tsserver under the
 *  extension host, MCP servers' helpers, pty-launched programs) — dies with the owner:
 *
 *    - Windows: one Job Object per TRACKED PROCESS TREE (KILL_ON_JOB_CLOSE, no breakaway;
 *      see packages/process-job). Jobs must not be shared per owner: Windows only lets a
 *      process that is already in a job join an EMPTY one, and every child inherits the
 *      job the editor itself was launched in. Reclaiming an owner terminates its jobs;
 *      main crashing or being killed closes every job handle and the OS kills every tree.
 *    - POSIX:   children spawned `detached` lead their own process group; reclaim does
 *      kill(-pgid). Main-crash cleanup there still relies on the children's stdin-EOF
 *      watchdog (no Linux PDEATHSIG from Node — see docs/development/process-lifecycle.md).
 *
 *  Containment is strictly best-effort: if the addon is missing, a pid is already in an
 *  incompatible job, or the process raced to exit, tracking degrades to "recorded but
 *  uncontained" and reclaim falls back to the target's own hard kill (taskkill /T, group
 *  SIGKILL). Spawning is never blocked or failed by it.
 *
 *  Reclaim is GRACEFUL FIRST: owners are asked to stop (stdin EOF / SIGTERM) and given a
 *  grace window; only survivors are hard-killed. The owner slot is detached synchronously
 *  at the start of reclaim, so a reloaded renderer that spawns again under the same window
 *  id lands in a fresh slot and is never hit by the previous generation's hard kill.
 *--------------------------------------------------------------------------------------------*/

import { execFile, execFileSync } from 'node:child_process'
import type { Event, IDisposable, ILogger } from '@universe-editor/platform'

export type ProcessOwner =
  | { readonly kind: 'window'; readonly id: number }
  | { readonly kind: 'app' }

export const APP_OWNER: ProcessOwner = { kind: 'app' }

export function windowOwner(id: number): ProcessOwner {
  return { kind: 'window', id }
}

export function ownerKey(owner: ProcessOwner): string {
  return owner.kind === 'app' ? 'app' : `window:${owner.id}`
}

/**
 * The Job Object surface exposed by `packages/process-job`. Handles are opaque BigInts
 * owned by the registry; `assign` returns 0 on success, -1 when it refused to contain the
 * calling process, otherwise a Win32 error code.
 */
export interface JobBackend {
  createJob(): bigint
  assign(job: bigint, pid: number): number
  terminate(job: bigint, exitCode: number): boolean
  close(job: bigint): boolean
  listPids(job: bigint): number[]
  /** Whole-machine pid -> ppid snapshot; absent on older addons (orphan sweep disabled). */
  listProcesses?(): ReadonlyArray<ProcessIdPair>
}

export interface ProcessIdPair {
  readonly pid: number
  readonly ppid: number
  /** Executable name from the same snapshot, when the addon provides it. */
  readonly name?: string
}

/** What the registry needs from a tracked process in order to stop it gracefully. */
export interface StoppableProcess {
  readonly exited: boolean
  readonly onDidExit: Event<unknown>
  /** Ask the process to stop on its own (stdin EOF / SIGTERM); must be idempotent. */
  requestStop(): void
  /** Forced termination of the process (tree) — the fallback when it is not contained. */
  hardKill(): void
}

export interface TrackProcessSpec {
  readonly pid: number
  readonly owner: ProcessOwner
  readonly role: string
  readonly label: string
  /** The child was spawned `detached` on POSIX, so `pid` is also its process-group id. */
  readonly processGroup?: boolean
  /**
   * On lease release, terminate + close the job even when descendants survive, instead of
   * keeping it for owner reclaim. ACP agents opt in: their bash/MCP descendants must not
   * outlive the agent. Default false — pty keeps user background programs on purpose.
   */
  readonly reapDescendantsOnRelease?: boolean
  readonly target?: StoppableProcess
}

export interface ProcessLease extends IDisposable {
  /** True when the kernel (job / process group) will take the whole tree down with the owner. */
  readonly contained: boolean
  /** The owner was already retired: the caller must kill the process itself. */
  readonly rejected: boolean
}

export interface ReclaimReport {
  readonly owner: string
  readonly reason: string
  readonly tracked: number
  readonly gracefullyExited: number
  /** pids still alive in the owner's job when the hard kill ran (includes untracked grandchildren). */
  readonly hardKilledPids: readonly number[]
  readonly uncontainedKilled: number
}

export interface ReclaimOptions {
  readonly reason: string
  /** How long requestStop()ed processes get before the hard kill. */
  readonly graceMs?: number
  /** Owner is gone for good (window closed): later track() calls are rejected. */
  readonly retire?: boolean
}

export interface ProcessLifecycleRegistryOptions {
  readonly backend?: JobBackend
  readonly logger?: ILogger
  readonly platform?: NodeJS.Platform
  /** The editor's own pid — never contained, never killed. */
  readonly selfPid?: number
  /** Hard kill for a pid-only entry that is not contained. */
  readonly killPid?: (pid: number) => void
  /** Kill for one orphan-sweep victim; must NOT kill its subtree (see defaultKillOrphanPid). */
  readonly killOrphanPid?: (pid: number) => void
  /** POSIX group kill; injectable for tests. */
  readonly killGroup?: (pgid: number) => void
  /** POSIX probe for whether a process group still has members; injectable for tests. */
  readonly groupAlive?: (pgid: number) => boolean
}

export const DEFAULT_RECLAIM_GRACE_MS = 2500
export const DEFAULT_ORPHAN_SWEEP_MS = 30_000
// Node clamps timer delays above 2^31-1 to 1ms; accepting such a value would turn the
// sweep into a busy loop that takes a system snapshot and runs taskkill on every tick.
const MAX_SWEEP_INTERVAL_MS = 0x7fffffff

function parseSweepInterval(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ORPHAN_SWEEP_MS
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_SWEEP_INTERVAL_MS
    ? parsed
    : DEFAULT_ORPHAN_SWEEP_MS
}

interface Entry {
  readonly spec: TrackProcessSpec
  readonly slot: Slot
  contained: boolean
  /** Windows: the job this process tree was placed in (closed on release once empty). */
  job: bigint | undefined
}

interface Slot {
  readonly key: string
  /**
   * One job PER TRACKED PROCESS TREE, not one per owner. Windows refuses to add a process
   * that is already in another job to a non-empty job unless that job is in the process's
   * own job hierarchy (`AssignProcessToJobObject` remarks) — and every child of the editor
   * already inherits whatever job the editor itself was launched in (CI runner, terminal,
   * sandbox). A fresh, empty job always accepts it; an owner job with earlier siblings
   * does not.
   */
  readonly jobs: Set<bigint>
  /** Root pid + reap policy per job, so orphan sweeps can skip roots and non-reap trees. */
  readonly jobRoots: Map<bigint, { readonly pid: number; readonly reap: boolean }>
  jobFailed: boolean
  readonly entries: Set<Entry>
  /** Process-group ids kept after the leader exits: orphans may still be in the group. */
  readonly groups: Set<number>
}

const NOOP_LEASE: ProcessLease = { contained: false, rejected: false, dispose: () => undefined }

function defaultKillPid(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // Already exited or partial tree — best effort.
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // ESRCH: already gone.
  }
}

/**
 * Orphan-sweep kill: the victim's own tree must survive. A wrapper shell can have a
 * dead parent while its child is a live command (Git-Bash's MSYS `exec` emulation
 * always leaves that shape), and `taskkill /T` on such a pid took down whole agent
 * Bash-tool commands mid-run — the sweep must only reap the pid it identified.
 */
export function defaultKillOrphanPid(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // Already exited — best effort.
    }
    return
  }
  defaultKillPid(pid)
}

/** How long descendants may outlive a process-group leader before the group is reaped. */
const ORPHAN_GROUP_REAP_MS = 5000

/** Delayed empty-check for a released job that still had descendants at release time. */
const ORPHAN_JOB_SWEEP_MS = 5000

/** Win32 codes the native assign returns when the target process is already gone. */
const ERROR_NO_PROCESS = 87
const ERROR_PROCESS_ABORTED = 1067

function defaultKillGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // ESRCH: the group is empty — the normal outcome after a clean stop.
  }
}

/** Probe whether a process group still has members (POSIX). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class ProcessLifecycleRegistry implements IDisposable {
  private _backend: JobBackend | undefined
  private _logger: ILogger | undefined
  private readonly _platform: NodeJS.Platform
  private readonly _selfPid: number
  private readonly _killPid: (pid: number) => void
  private readonly _killOrphanPid: (pid: number) => void
  private readonly _killGroup: (pgid: number) => void
  private readonly _groupAlive: (pgid: number) => boolean

  private readonly _slots = new Map<string, Slot>()
  /** Slots detached by an in-flight reclaim; dispose() must still hard-kill them. */
  private readonly _reclaiming = new Set<Slot>()
  /**
   * Grace waits still listening for child exits. Their unref'd timer never fires before
   * `exit`, where the main-process leak tracker reports, so dispose() must settle them.
   */
  private readonly _pendingWaits = new Set<() => void>()
  private readonly _byPid = new Map<number, Entry>()
  private readonly _retired = new Set<string>()
  private _orphanSweepTimer: ReturnType<typeof setInterval> | undefined
  private _disposed = false

  constructor(options: ProcessLifecycleRegistryOptions = {}) {
    this._backend = options.backend
    this._logger = options.logger
    this._platform = options.platform ?? process.platform
    this._selfPid = options.selfPid ?? process.pid
    this._killPid = options.killPid ?? defaultKillPid
    this._killOrphanPid = options.killOrphanPid ?? defaultKillOrphanPid
    this._killGroup = options.killGroup ?? defaultKillGroup
    this._groupAlive = options.groupAlive ?? groupAlive
  }

  /** Late wiring: the registry is a module singleton created before logging/addon are up. */
  configure(options: { backend?: JobBackend | undefined; logger?: ILogger | undefined }): void {
    if ('backend' in options) this._backend = options.backend
    if (options.logger !== undefined) this._logger = options.logger
  }

  get hasJobBackend(): boolean {
    return this._backend !== undefined
  }

  /** Live (not yet released) tracked pids, for diagnostics and tests. */
  snapshot(): ReadonlyArray<{
    pid: number
    owner: string
    role: string
    label: string
    contained: boolean
  }> {
    return [...this._byPid.values()].map((e) => ({
      pid: e.spec.pid,
      owner: e.slot.key,
      role: e.spec.role,
      label: e.spec.label,
      contained: e.contained,
    }))
  }

  /** Pids currently in the owner's process-tree jobs (empty when there are none). Debug/e2e aid. */
  listJobPids(owner: ProcessOwner): number[] {
    const slot = this._slots.get(ownerKey(owner))
    if (!this._backend || !slot) return []
    const pids = new Set<number>()
    for (const job of slot.jobs) {
      try {
        for (const pid of this._backend.listPids(job)) pids.add(pid)
      } catch {
        // A job can be gone between listing and querying; diagnostics only.
      }
    }
    return [...pids]
  }

  /**
   * Periodically reap descendants that outlived their parent inside a reap-enabled job
   * (ACP agents). The Claude CLI's TaskStop can leave a grandchild behind on Windows; the
   * job still contains it, but without this it would survive until owner reclaim.
   */
  startOrphanSweep(intervalMs?: number): void {
    if (this._disposed || this._orphanSweepTimer !== undefined) return
    const backend = this._backend
    if (this._platform !== 'win32' || !backend || typeof backend.listProcesses !== 'function') {
      return
    }
    if (process.env['UNIVERSE_DISABLE_ORPHAN_SWEEP'] === '1') return
    const interval = intervalMs ?? parseSweepInterval(process.env['UNIVERSE_ORPHAN_SWEEP_MS'])
    this._orphanSweepTimer = setInterval(() => {
      try {
        this.sweepOrphans()
      } catch (err) {
        this._logger?.warn(`orphan sweep failed: ${String(err)}`)
      }
    }, interval)
    this._orphanSweepTimer.unref?.()
  }

  /** One orphan pass over reap-enabled jobs. Public for tests and diagnostics. */
  sweepOrphans(): void {
    if (this._disposed || this._platform !== 'win32') return
    const backend = this._backend
    if (!backend) return
    const listProcesses = backend.listProcesses
    if (typeof listProcesses !== 'function') return

    // Cheap pre-check: most apps have no ACP agent tree, so never take a system snapshot.
    let hasReapJob = false
    for (const slot of this._slots.values()) {
      for (const job of slot.jobs) {
        if (slot.jobRoots.get(job)?.reap === true) {
          hasReapJob = true
          break
        }
      }
      if (hasReapJob) break
    }
    if (!hasReapJob) return

    let rows: ReadonlyArray<ProcessIdPair>
    try {
      rows = listProcesses.call(backend)
    } catch (err) {
      this._logger?.warn(`orphan sweep snapshot failed: ${String(err)}`)
      return
    }
    const alive = new Set<number>()
    const parentOf = new Map<number, number>()
    const nameOf = new Map<number, string>()
    for (const row of rows) {
      if (!Number.isInteger(row.pid) || row.pid <= 0) continue
      alive.add(row.pid)
      if (Number.isInteger(row.ppid)) parentOf.set(row.pid, row.ppid)
      if (typeof row.name === 'string' && row.name.length > 0) nameOf.set(row.pid, row.name)
    }
    // A dead parent does not make a process a leftover: shell wrappers keep running
    // the command below them (Git-Bash's MSYS `exec` emulation ALWAYS leaves a
    // wrapper whose parent already exited). Only pids with no live descendant are
    // true orphans; reaping the rest severed live agent tool commands mid-run. A
    // subtree whose root still parents a live process is left to P0 / owner reclaim.
    const hasLiveDescendant = new Set<number>()
    for (const row of rows) {
      let ancestor = parentOf.get(row.pid)
      while (ancestor !== undefined && ancestor > 1 && !hasLiveDescendant.has(ancestor)) {
        hasLiveDescendant.add(ancestor)
        ancestor = parentOf.get(ancestor)
      }
    }

    for (const slot of this._slots.values()) {
      for (const job of [...slot.jobs]) {
        const root = slot.jobRoots.get(job)
        if (root?.reap !== true) continue
        let members: number[]
        try {
          members = backend.listPids(job)
        } catch {
          continue
        }
        const killed: number[] = []
        const labels: string[] = []
        for (const pid of members) {
          if (pid <= 0 || pid === this._selfPid || pid === root.pid) continue
          const ppid = parentOf.get(pid)
          // Missing snapshot entry / missing parent / live parent: not an orphan. A reused
          // parent pid reads as live and is left alone — owner reclaim still covers it.
          if (ppid === undefined || ppid <= 0 || alive.has(ppid)) continue
          // Still parenting a live process: it is part of a running chain, not a leftover.
          if (hasLiveDescendant.has(pid)) continue
          try {
            this._killOrphanPid(pid)
            killed.push(pid)
            // Name from the snapshot already in hand: no extra process for diagnostics,
            // and a pid alone is useless once the process is gone.
            const name = nameOf.get(pid)
            labels.push(name === undefined ? String(pid) : `${pid}:${name}`)
          } catch (err) {
            this._logger?.warn(`orphan kill failed pid=${pid}: ${String(err)}`)
          }
        }
        if (killed.length === 0) continue
        this._logger?.info(`orphan sweep owner=${slot.key} killedPids=[${labels.join(',')}]`)
        try {
          // Close an emptied job only when its root is gone too: listPids can come back
          // empty on error, and closing a job with a live root would kill the agent.
          if (backend.listPids(job).length === 0 && !alive.has(root.pid)) {
            slot.jobs.delete(job)
            slot.jobRoots.delete(job)
            this._closeJob(job)
          }
        } catch {
          // Membership cannot be re-checked now; owner reclaim remains the fallback.
        }
      }
    }
  }

  track(spec: TrackProcessSpec): ProcessLease {
    const key = ownerKey(spec.owner)
    const tag = `${spec.role}:${spec.label} pid=${spec.pid} owner=${key}`
    if (this._disposed || this._retired.has(key)) {
      this._logger?.warn(`track rejected (owner retired) ${tag}`)
      return { contained: false, rejected: true, dispose: () => undefined }
    }
    if (spec.pid === this._selfPid || spec.pid <= 0) {
      this._logger?.warn(`track refused (not a child pid) ${tag}`)
      return NOOP_LEASE
    }
    const existing = this._byPid.get(spec.pid)
    if (existing) {
      if (!existing.spec.target?.exited) {
        // Same pid tracked twice (double registration). A process cannot sit in two
        // sibling jobs, so keep the first and report its containment.
        this._logger?.warn(
          `track duplicate ${tag} (already ${existing.slot.key}/${existing.spec.role})`,
        )
        return { contained: existing.contained, rejected: false, dispose: () => undefined }
      }
      // A stale entry whose process exited without release: the pid was reused.
      this._releaseJob(existing)
      this._forget(existing)
    }

    const slot = this._slotFor(key)
    const entry: Entry = { spec, slot, contained: false, job: undefined }
    slot.entries.add(entry)
    this._byPid.set(spec.pid, entry)

    if (this._backend && this._platform === 'win32') {
      const assigned = this._assignToJob(slot, spec, tag)
      entry.contained = assigned.contained
      entry.job = assigned.job
      if (assigned.job !== undefined) {
        slot.jobRoots.set(assigned.job, {
          pid: spec.pid,
          reap: spec.reapDescendantsOnRelease === true,
        })
      }
    } else if (spec.processGroup === true && this._platform !== 'win32') {
      // pid is the group leader (spawned detached) — group kill at reclaim covers descendants.
      slot.groups.add(spec.pid)
      entry.contained = true
      this._logger?.debug(`track pgid=${spec.pid} ${tag}`)
    } else {
      this._logger?.debug(`track uncontained ${tag}`)
    }

    return {
      contained: entry.contained,
      rejected: false,
      dispose: () => this._release(entry),
    }
  }

  /**
   * Stop everything an owner spawned: ask politely, wait out the grace window, then
   * hard-kill the survivors and whatever is left in the owner's kernel container.
   */
  async reclaimOwner(owner: ProcessOwner, options: ReclaimOptions): Promise<ReclaimReport> {
    const key = ownerKey(owner)
    // Detach FIRST and synchronously: anything spawned after this point belongs to the
    // next generation of the same owner id (window reload) and must not be reaped.
    const slot = this._slots.get(key)
    this._slots.delete(key)
    if (options.retire === true) this._retired.add(key)
    if (!slot) {
      return {
        owner: key,
        reason: options.reason,
        tracked: 0,
        gracefullyExited: 0,
        hardKilledPids: [],
        uncontainedKilled: 0,
      }
    }

    // The slot is detached above, so make it visible to dispose() while the grace wait runs;
    // quitting mid-reclaim must still hard-kill it (POSIX has no OS-level fallback).
    this._reclaiming.add(slot)
    const entries = [...slot.entries]
    const targets = entries.flatMap((e) => (e.spec.target ? [e.spec.target] : []))
    for (const target of targets) {
      if (!target.exited) {
        try {
          target.requestStop()
        } catch (err) {
          this._logger?.warn(`requestStop failed owner=${key}: ${String(err)}`)
        }
      }
    }
    await this._waitForExit(targets, options.graceMs ?? DEFAULT_RECLAIM_GRACE_MS)

    const gracefullyExited = targets.filter((t) => t.exited).length
    const survivors = entries.filter((e) => e.spec.target?.exited !== true)
    const hardKill = this._hardKill(slot)
    const uncontainedKilled = this._killUncontained(survivors, hardKill.failedPids)

    for (const entry of entries) this._forget(entry)
    this._reclaiming.delete(slot)
    const report: ReclaimReport = {
      owner: key,
      reason: options.reason,
      tracked: entries.length,
      gracefullyExited,
      hardKilledPids: hardKill.killed,
      uncontainedKilled,
    }
    const detail =
      `reclaim owner=${key} reason=${options.reason} tracked=${entries.length} ` +
      `graceful=${gracefullyExited} hardKilledPids=[${hardKill.killed.join(',')}] ` +
      `uncontainedKilled=${uncontainedKilled}`
    if (hardKill.killed.length > 0 || uncontainedKilled > 0) this._logger?.warn(detail)
    else this._logger?.info(detail)
    return report
  }

  /** App quit: synchronously terminate every container. No graceful phase — callers ran stopAll first. */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    if (this._orphanSweepTimer !== undefined) {
      clearInterval(this._orphanSweepTimer)
      this._orphanSweepTimer = undefined
    }
    // Settle in-flight grace waits first: they hold exit-event subscriptions and their
    // timer is unref'd, so quitting mid-wait would otherwise leak those subscriptions
    // past `process.on('exit')` (the main-process tracker reports there).
    for (const finish of [...this._pendingWaits]) finish()
    this._pendingWaits.clear()
    // In-flight reclaims already detached their slot; their grace wait will never finish
    // once the process exits, so hard-kill them here too.
    for (const slot of this._reclaiming) {
      const { killed } = this._hardKill(slot)
      if (killed.length > 0) this._logger?.warn(`dispose owner=${slot.key} killedPids=[${killed}]`)
    }
    this._reclaiming.clear()
    for (const slot of this._slots.values()) {
      const { killed } = this._hardKill(slot)
      if (killed.length > 0) this._logger?.warn(`dispose owner=${slot.key} killedPids=[${killed}]`)
    }
    this._slots.clear()
    this._byPid.clear()
  }

  private _slotFor(key: string): Slot {
    let slot = this._slots.get(key)
    if (!slot) {
      slot = {
        key,
        jobs: new Set(),
        jobRoots: new Map(),
        jobFailed: false,
        entries: new Set(),
        groups: new Set(),
      }
      this._slots.set(key, slot)
    }
    return slot
  }

  private _assignToJob(
    slot: Slot,
    spec: TrackProcessSpec,
    tag: string,
  ): { contained: boolean; job: bigint | undefined } {
    const backend = this._backend!
    if (slot.jobFailed) return { contained: false, job: undefined }
    let job: bigint
    try {
      job = backend.createJob()
    } catch (err) {
      slot.jobFailed = true
      this._logger?.warn(`job create failed owner=${slot.key}: ${String(err)} — degrading`)
      return { contained: false, job: undefined }
    }
    let status: number
    try {
      status = backend.assign(job, spec.pid)
    } catch (err) {
      this._logger?.warn(`job assign threw ${tag}: ${String(err)} — degrading`)
      this._closeJob(job)
      return { contained: false, job: undefined }
    }
    if (status === 0) {
      this._logger?.debug(`job assign ok ${tag}`)
      slot.jobs.add(job)
      return { contained: true, job }
    }
    // Nothing was contained: the job is still empty, so close it (KILL_ON_JOB_CLOSE would
    // otherwise terminate a pid-reused stranger) and degrade to tree-kill.
    this._closeJob(job)
    // 1067 = ERROR_PROCESS_ABORTED (exited before/while assigning), 87 = no such pid.
    // Nothing to contain in either case, and a short-lived child (ripgrep) routinely hits it.
    if (status === ERROR_PROCESS_ABORTED || status === ERROR_NO_PROCESS) {
      this._logger?.debug(`job assign skipped ${tag}: process already exited`)
      return { contained: false, job: undefined }
    }
    // 5 = ACCESS_DENIED (terminating process / incompatible job / protected process).
    this._logger?.warn(`job assign failed ${tag} status=${status} — falling back to tree-kill`)
    return { contained: false, job: undefined }
  }

  private _closeJob(job: bigint): void {
    try {
      if (this._backend?.close(job) === false) {
        this._logger?.warn(`job close returned false handle=${String(job)}`)
      }
    } catch (err) {
      this._logger?.warn(`job close failed: ${String(err)}`)
    }
  }

  private _release(entry: Entry): void {
    const { pid, processGroup } = entry.spec
    entry.slot.entries.delete(entry)
    if (this._byPid.get(pid) === entry) this._byPid.delete(pid)
    if (entry.job !== undefined) this._releaseJob(entry)
    if (processGroup !== true || this._platform === 'win32') return
    if (!this._groupAlive(pid)) {
      entry.slot.groups.delete(pid)
      return
    }
    // The leader is gone but descendants linger: keep the group for reclaim, yet bound how
    // long — a pgid retained forever could be recycled by an unrelated group leader.
    const { slot } = entry
    const timer = setTimeout(() => {
      if (!slot.groups.has(pid)) return
      const current = this._byPid.get(pid)
      if (current !== undefined) {
        // The pid was reused. The old group is only still ours if the new entry sits in
        // the same slot as a process-group leader; otherwise drop the stale pgid WITHOUT
        // killing — a later _hardKill would otherwise signal an unrelated group.
        if (current.slot === slot && current.spec.processGroup === true) return
        slot.groups.delete(pid)
        return
      }
      this._logger?.debug(`reaping orphaned process group pgid=${pid}`)
      this._killGroup(pid)
      slot.groups.delete(pid)
    }, ORPHAN_GROUP_REAP_MS)
    timer.unref?.()
  }

  /**
   * Close the entry's job once its tree is empty. A job that still holds descendants is
   * kept for reclaim: closing it early would kill them at release time, which is the
   * owner's decision, not the releasing child's. `reapDescendantsOnRelease` is the explicit
   * exception (ACP agents): their descendants must die with the agent, so the job is
   * terminated and closed here instead of waiting for owner reclaim.
   */
  private _releaseJob(entry: Entry): void {
    const job = entry.job
    if (job === undefined) return
    entry.job = undefined
    const { slot } = entry
    // A reclaim/dispose already terminated and closed this job (the process exit simply
    // lands here later). Touching the handle now could close a REUSED handle of another
    // job — KILL_ON_JOB_CLOSE would then take down the wrong process tree.
    if (!slot.jobs.has(job)) return
    const root = slot.jobRoots.get(job)
    if (root?.reap === true) {
      slot.jobs.delete(job)
      slot.jobRoots.delete(job)
      try {
        if (this._backend?.terminate(job, 1) === false) {
          this._logger?.warn(`job terminate on release returned false handle=${String(job)}`)
        }
      } catch (err) {
        this._logger?.warn(`job terminate on release failed: ${String(err)}`)
      }
      // terminate is best effort; closing the job is the actual guarantee (KILL_ON_JOB_CLOSE).
      this._closeJob(job)
      return
    }
    let survivors: number[]
    try {
      survivors = this._backend?.listPids(job) ?? []
    } catch {
      // Cannot tell whether the tree is empty — keep the handle for reclaim.
      this._scheduleJobSweep(slot, job, entry.spec.pid)
      return
    }
    if (survivors.some((pid) => pid !== entry.spec.pid)) {
      this._scheduleJobSweep(slot, job, entry.spec.pid)
      return
    }
    slot.jobs.delete(job)
    slot.jobRoots.delete(job)
    this._closeJob(job)
  }

  /** One delayed empty-check for a released job that still had descendants at release. */
  private _scheduleJobSweep(slot: Slot, job: bigint, ownPid: number): void {
    const timer = setTimeout(() => {
      if (!slot.jobs.has(job)) return
      let survivors: number[]
      try {
        survivors = this._backend?.listPids(job) ?? []
      } catch {
        return
      }
      if (survivors.some((pid) => pid !== ownPid)) return
      slot.jobs.delete(job)
      slot.jobRoots.delete(job)
      this._closeJob(job)
    }, ORPHAN_JOB_SWEEP_MS)
    timer.unref?.()
  }

  private _forget(entry: Entry): void {
    entry.slot.entries.delete(entry)
    if (this._byPid.get(entry.spec.pid) === entry) this._byPid.delete(entry.spec.pid)
  }

  private _waitForExit(targets: readonly StoppableProcess[], graceMs: number): Promise<void> {
    const pending = new Set(targets.filter((t) => !t.exited))
    if (pending.size === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const subs: IDisposable[] = []
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._pendingWaits.delete(done)
        for (const s of subs) s.dispose()
        resolve()
      }
      const timer = setTimeout(done, graceMs)
      timer.unref?.()
      this._pendingWaits.add(done)
      for (const target of pending) {
        subs.push(
          target.onDidExit(() => {
            pending.delete(target)
            if (pending.size === 0) done()
          }),
        )
        // exited between the filter above and the subscription (synchronous exit).
        if (target.exited) {
          pending.delete(target)
          if (pending.size === 0) done()
        }
      }
    })
  }

  /** Terminate + close every job of the owner and group-kill its process groups. */
  private _hardKill(slot: Slot): { killed: number[]; failedPids: Set<number> } {
    const killed = new Set<number>()
    const failedJobs = new Set<bigint>()
    if (this._backend) {
      for (const job of slot.jobs) {
        try {
          for (const pid of this._backend.listPids(job)) {
            if (pid !== this._selfPid) killed.add(pid)
          }
        } catch {
          // listing is diagnostics only
        }
        let terminated = false
        try {
          terminated = this._backend.terminate(job, 1)
        } catch (err) {
          this._logger?.warn(`job terminate failed owner=${slot.key}: ${String(err)}`)
        }
        if (!terminated) {
          this._logger?.warn(`job terminate returned false owner=${slot.key}`)
          failedJobs.add(job)
        }
        this._closeJob(job)
      }
    }
    // Late process-exit callbacks must not touch handles that are closed now (and may be
    // reused by the next generation). Entries whose job failed to terminate still need the
    // per-process fallback below.
    const failedPids = new Set<number>()
    for (const entry of slot.entries) {
      if (entry.job !== undefined && failedJobs.has(entry.job)) failedPids.add(entry.spec.pid)
      entry.job = undefined
    }
    if (this._backend) slot.jobs.clear()
    slot.jobRoots.clear()
    for (const pgid of slot.groups) {
      if (pgid > 1 && pgid !== this._selfPid) {
        if (this._groupAlive(pgid)) killed.add(pgid)
        this._killGroup(pgid)
      }
    }
    slot.groups.clear()
    return { killed: [...killed], failedPids }
  }

  private _killUncontained(survivors: readonly Entry[], failedPids: ReadonlySet<number>): number {
    let count = 0
    for (const entry of survivors) {
      if (entry.spec.target?.exited === true) continue
      if (entry.contained && !failedPids.has(entry.spec.pid)) continue
      count++
      try {
        if (entry.spec.target) entry.spec.target.hardKill()
        else this._killPid(entry.spec.pid)
      } catch (err) {
        this._logger?.warn(`hard kill failed pid=${entry.spec.pid}: ${String(err)}`)
      }
    }
    return count
  }
}

/**
 * Spawn options that make a POSIX child lead its own process group (so a group kill
 * reaches its descendants). Windows uses Job Objects instead and must NOT detach — that
 * would allocate a new console/process group.
 */
export function processGroupSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): { detached: true } | Record<string, never> {
  return platform === 'win32' ? {} : { detached: true }
}

/**
 * Hard-kill a process tree by pid, asynchronously — for the remote server, which has no
 * registry. POSIX kills the group when the child led one (`group`), else just the pid.
 */
export function killProcessTree(pid: number, options: { group?: boolean } = {}): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    return
  }
  try {
    process.kill(options.group === true ? -pid : pid, 'SIGKILL')
  } catch {
    // ESRCH: already gone.
  }
}
