/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared lifecycle wrapper for child processes spawned via node:child_process.
 *  Centralizes what every spawn site previously re-wrote by hand: forced kill
 *  with a SIGTERM→SIGKILL timeout escalation, a single well-defined exit signal
 *  (spawn errors are surfaced as a synthetic exit), and raw stdout/stderr byte
 *  bridging (the caller decides the encoding).
 *
 *  It wraps an already-spawned child rather than spawning itself, because spawn
 *  argument assembly (shell, stdio, cwd, env) differs per call site. Decoding is
 *  left to the consumer (text search uses a StringDecoder for NDJSON, the ACP
 *  hosts decode stderr as gb18030) — see env.ts / decode.ts for the shared
 *  helpers those call sites use.
 *--------------------------------------------------------------------------------------------*/

import { execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Disposable, Emitter, type ILogger } from '@universe-editor/platform'
import type {
  ProcessLease,
  ProcessLifecycleRegistry,
  ProcessOwner,
  StoppableProcess,
} from './processLifecycle.js'

export const DEFAULT_KILL_TIMEOUT_MS = 2000

/**
 * Machine-readable codes stamped on `writeStdin` rejections. Consumers (acpHost /
 * extensionHost) branch on `err.code` instead of pattern-matching the human
 * message, and the structured IPC error envelope carries the code to the renderer
 * (see packages/platform ipc.ts). Both mean "the child can no longer accept input".
 */
export const CHILD_PROCESS_EXITED_CODE = 'CHILD_PROCESS_EXITED'
export const CHILD_STDIN_NOT_WRITABLE_CODE = 'CHILD_STDIN_NOT_WRITABLE'

/** An `Error` carrying one of the child-process rejection codes above. */
export interface ChildProcessError extends Error {
  code: string
}

function childProcessError(message: string, code: string): ChildProcessError {
  const err = new Error(message) as ChildProcessError
  err.code = code
  return err
}

/**
 * Tear down a whole process tree by PID. On Windows a cmd-wrapped spawn
 * (see `cmdSpawn.ts`) wraps the real command in `cmd.exe`; `child.kill()`
 * (TerminateProcess) then only reaps the wrapper, leaving the grandchild
 * (node/npx agent, shell command) orphaned with a dangling stdin pipe.
 * `taskkill /T` recurses the parent-PID tree so the real process dies too.
 * Injectable so unit tests don't shell out.
 *
 * The `sync` flag selects a blocking `execFileSync`. It matters on the app-quit
 * path (`dispose()`): Electron's `will-quit` is synchronous and does not await
 * promises, so a fire-and-forget async `taskkill` races the main process exit —
 * the main process can die *before* the grandchild is reaped, leaving it holding
 * inherited pipes open (blocks Playwright teardown; leaks agent processes for
 * real users). A synchronous kill forces will-quit to block until the tree dies.
 */
export type TreeKiller = (pid: number, sync?: boolean) => void

const defaultTreeKiller: TreeKiller = (pid, sync) => {
  const args = ['/pid', String(pid), '/T', '/F']
  if (sync) {
    try {
      execFileSync('taskkill', args, { stdio: 'ignore', windowsHide: true })
    } catch {
      // Best-effort: already exited, partial tree, or taskkill unavailable.
    }
    return
  }
  execFile('taskkill', args, { windowsHide: true }, () => {
    // Best-effort: already exited, partial tree, or taskkill unavailable —
    // nothing actionable during teardown.
  })
}

export interface ManagedExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** True when our SIGTERM→SIGKILL escalation forced the process down. */
  readonly forced: boolean
  /** Present when the process never started (spawn error, e.g. ENOENT). */
  readonly error?: string
}

export interface ManagedChildOptions {
  /** Grace period before SIGTERM is escalated to SIGKILL. */
  readonly killTimeoutMs?: number
  readonly logger?: ILogger
  /** Identifier used in log lines (e.g. a handle / session id). */
  readonly label?: string
  /**
   * When the child was spawned through a cmd.exe wrapper (see `cmdSpawn.ts`) on
   * Windows, `kill()` only reaps the `cmd.exe` wrapper and orphans the real
   * grandchild process. Set this so termination recurses the PID tree
   * (`taskkill /T`) instead. No-op off Windows, where a parent SIGKILL already
   * reaps the group.
   */
  readonly treeKill?: boolean
  /** Injectable tree-killer for tests. Defaults to `taskkill /T /F`. */
  readonly killTree?: TreeKiller
  /** Host-side hook bracketing a synchronous kill (e.g. shutdown trace marks). */
  readonly shutdownMark?: (label: string) => void
  /**
   * The child was spawned `detached` on POSIX (see `processGroupSpawnOptions`), so it leads
   * its own process group: signals go to the whole group and descendants die with it.
   * Ignored on Windows, where containment is a Job Object (see `lifecycle`).
   */
  readonly processGroup?: boolean
  /** Bind the child to an owner so the OS-level container reaps its whole tree. */
  readonly lifecycle?: ManagedLifecycleOptions
}

export interface ManagedLifecycleOptions {
  readonly registry: ProcessLifecycleRegistry
  readonly owner: ProcessOwner
  /** Diagnostic role (`extension-host`, `acp-agent`, …). */
  readonly role: string
  /**
   * How an owner reclaim first asks this child to stop, before the hard kill:
   * `stdin-eof` closes its stdin (children that run their own shutdown cascade on parent
   * loss, e.g. the extension host reaping tsserver); `kill` (default) is {@link kill}.
   */
  readonly stop?: 'kill' | 'stdin-eof'
  /** Terminate the job's descendants when this child exits (ACP agents; off by default). */
  readonly reapDescendantsOnRelease?: boolean
}

/**
 * Wraps a spawned child with a uniform lifecycle. Emits raw stdout/stderr
 * buffers and exactly one {@link ManagedExit} (whether the child exited, errored
 * on spawn, or was force-killed).
 */
export class ManagedChildProcess extends Disposable implements StoppableProcess {
  private readonly _onStdout = this._register(new Emitter<Buffer>())
  readonly onStdout = this._onStdout.event

  private readonly _onStderr = this._register(new Emitter<Buffer>())
  readonly onStderr = this._onStderr.event

  private readonly _onDidExit = this._register(new Emitter<ManagedExit>())
  readonly onDidExit = this._onDidExit.event

  private readonly _killTimeoutMs: number
  private readonly _logger: ILogger | undefined
  private readonly _label: string
  private readonly _treeKill: boolean
  private readonly _killTree: TreeKiller
  private readonly _shutdownMark: ((label: string) => void) | undefined
  private readonly _processGroup: boolean
  private readonly _lifecycle: ManagedLifecycleOptions | undefined
  private _lease: ProcessLease | undefined
  private _stopTimer: ReturnType<typeof setTimeout> | undefined

  private _exited = false
  private _forced = false
  private _treeKilled = false
  private _killTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Last error seen on the child's stdin. Node emits `'error'` on the stream for a
   * failed write *in addition* to invoking the write callback, and an `'error'` with
   * no listener becomes an `uncaughtException` that takes the whole main process
   * down — the shipped crash was exactly this (`write EPIPE at writeStdin`). Held so
   * later writes can reject with the documented code instead of writing into a
   * broken pipe again.
   */
  private _stdinError: NodeJS.ErrnoException | undefined
  /**
   * Reject functions of writes still waiting on their callback. Node may report a failed
   * write *only* as a stream `'error'` (never through the callback), and a promise that
   * never settles is a hung caller rather than a surfaced failure — which is the shape
   * this whole path exists to avoid.
   */
  private readonly _pendingWrites = new Set<(err: Error) => void>()
  private _disposed = false

  constructor(
    private readonly _child: ChildProcessWithoutNullStreams,
    options: ManagedChildOptions = {},
  ) {
    super()
    this._killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS
    this._logger = options.logger
    this._label = options.label ?? String(_child.pid ?? 'unknown')
    this._treeKill = options.treeKill ?? false
    this._killTree = options.killTree ?? defaultTreeKiller
    this._shutdownMark = options.shutdownMark
    this._processGroup = options.processGroup === true && process.platform !== 'win32'
    this._lifecycle = options.lifecycle

    _child.stdout.on('data', this._onStdoutData)
    _child.stderr.on('data', this._onStderrData)
    _child.stdin.on('error', this._onStdinError)
    _child.on('error', this._onChildError)
    _child.on('exit', this._onChildExit)
    this._bindLifecycle()
  }

  /**
   * Assign right after spawn, in the same tick: a grandchild forked before the assign would
   * not be in the container. Never throws and never blocks the spawn — a failed assign just
   * leaves the child uncontained (reclaim then falls back to {@link hardKill}).
   */
  private _bindLifecycle(): void {
    const lifecycle = this._lifecycle
    const pid = this._child.pid
    if (!lifecycle || pid === undefined) return
    try {
      this._lease = lifecycle.registry.track({
        pid,
        owner: lifecycle.owner,
        role: lifecycle.role,
        label: this._label,
        processGroup: this._processGroup,
        ...(lifecycle.reapDescendantsOnRelease === true ? { reapDescendantsOnRelease: true } : {}),
        target: this,
      })
    } catch (err) {
      this._logger?.warn(
        `ManagedChildProcess(${this._label}): lifecycle track failed: ${(err as Error).message}`,
      )
      return
    }
    if (this._lease.rejected) {
      // The owner (a closed window) is gone: a spawn that was in flight when it was
      // reclaimed must not outlive it.
      this._logger?.warn(
        `ManagedChildProcess(${this._label}): owner already reclaimed — killing immediately`,
      )
      this.kill()
    }
  }

  private readonly _onStdoutData = (data: Buffer): void => this._onStdout.fire(data)

  private readonly _onStderrData = (data: Buffer): void => this._onStderr.fire(data)

  private readonly _onStdinError = (err: NodeJS.ErrnoException): void => {
    if (!this._stdinError) {
      this._stdinError = err
      // Still absorbed after dispose (that is the point of keeping the listener), but
      // no longer worth a log line — the shutdown path is already tearing down.
      if (!this._disposed) {
        this._logger?.warn(
          `ManagedChildProcess(${this._label}): stdin error ${err.code ?? err.message} — the child can no longer accept input`,
        )
      }
    }
    this._failPendingWrites()
  }

  /** Settle every in-flight write the stream error may have swallowed. */
  private _failPendingWrites(): void {
    if (this._pendingWrites.size === 0) return
    const reason = this._stdinError?.code ?? this._stdinError?.message ?? 'unknown'
    const error = childProcessError(
      `ManagedChildProcess(${this._label}): stdin write failed (${reason})`,
      CHILD_STDIN_NOT_WRITABLE_CODE,
    )
    const pending = [...this._pendingWrites]
    this._pendingWrites.clear()
    for (const reject of pending) reject(error)
  }

  private readonly _onChildError = (err: Error): void =>
    this._settleExit({ code: null, signal: null, error: err.message })

  private readonly _onChildExit = (code: number | null, signal: NodeJS.Signals | null): void =>
    this._settleExit({ code, signal })

  get pid(): number | undefined {
    return this._child.pid
  }

  get exited(): boolean {
    return this._exited
  }

  /** True when the kernel (job / process group) guarantees the tree dies with its owner. */
  get contained(): boolean {
    return this._lease?.contained ?? false
  }

  writeStdin(data: string): Promise<void> {
    if (this._exited) {
      return Promise.reject(
        childProcessError(
          `ManagedChildProcess(${this._label}): process has exited`,
          CHILD_PROCESS_EXITED_CODE,
        ),
      )
    }
    const stdin = this._child.stdin
    // A stdin that already errored (EPIPE, ECONNRESET) is never coming back: reject
    // rather than hand the write to a dead pipe that will only error again.
    if (this._stdinError) {
      return Promise.reject(
        childProcessError(
          `ManagedChildProcess(${this._label}): stdin failed (${this._stdinError.code ?? this._stdinError.message})`,
          CHILD_STDIN_NOT_WRITABLE_CODE,
        ),
      )
    }
    // Defend against the narrow race where the child died after spawn but before
    // its exit/error event reached us — stdin can already be destroyed.
    if (stdin.destroyed || stdin.writable === false) {
      return Promise.reject(
        childProcessError(
          `ManagedChildProcess(${this._label}): stdin is not writable`,
          CHILD_STDIN_NOT_WRITABLE_CODE,
        ),
      )
    }
    return new Promise<void>((resolve, reject) => {
      // Registered so a failure delivered only as a stream 'error' still settles this
      // promise; the callback below deregisters it either way.
      const onStreamError = (err: Error): void => reject(err)
      this._pendingWrites.add(onStreamError)
      const settle = (): void => {
        this._pendingWrites.delete(onStreamError)
      }
      try {
        stdin.write(data, 'utf8', (err) => {
          settle()
          // Normalized to the documented "child can no longer accept input" code so
          // callers have one branch to write; the errno stays in the message. The
          // callback is not a reliable error channel on its own (Node may deliver the
          // failure only as a stream 'error'), which is why _onStdinError exists.
          if (err) {
            reject(
              childProcessError(
                `ManagedChildProcess(${this._label}): stdin write failed (${(err as NodeJS.ErrnoException).code ?? err.message})`,
                CHILD_STDIN_NOT_WRITABLE_CODE,
              ),
            )
          } else resolve()
        })
      } catch (err) {
        // A write into an already-closing stream can still throw synchronously; the
        // promise settles by itself, but the rejecter must not be left behind.
        settle()
        throw err
      }
    })
  }

  /**
   * Close the child's stdin (EOF). For children that watch stdin for their parent
   * going away (the extension host shuts itself down on `stdin end`), this is the
   * graceful-stop trigger: it lets the child tear down its own descendants (e.g.
   * tsserver) synchronously and exit cleanly, instead of us hard-killing it and
   * orphaning those grandchildren. No-op if already exited or stdin is gone.
   */
  endStdin(): void {
    if (this._exited) return
    const stdin = this._child.stdin
    if (stdin.destroyed) return
    try {
      stdin.end()
    } catch {
      // Already closing / destroyed — nothing to do.
    }
  }

  /**
   * Request termination. Sends `signal` (default SIGTERM); if the process has
   * not exited within `killTimeoutMs`, escalates to SIGKILL. Idempotent.
   *
   * When {@link ManagedChildOptions.treeKill} is set on Windows, this instead
   * force-kills the whole PID tree in one shot (`taskkill /T /F`): the graceful
   * SIGTERM would only reap the `cmd.exe` shell wrapper and orphan the real
   * grandchild, so there is nothing to escalate.
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this._exited || this._killTimer) return
    if (this._shouldTreeKill()) {
      this._forced = true
      this._killTreeNow()
      return
    }
    this._send(signal)
    this._killTimer = setTimeout(() => {
      this._killTimer = undefined
      if (this._exited) return
      this._forced = true
      this._logger?.warn(
        `ManagedChildProcess(${this._label}): ${signal} timed out after ${this._killTimeoutMs}ms, sending SIGKILL`,
      )
      this._send('SIGKILL')
    }, this._killTimeoutMs)
  }

  /**
   * Owner-reclaim entry point: the graceful half of the two-phase stop (the registry
   * hard-kills whatever is left afterwards). Idempotent.
   */
  requestStop(): void {
    if (this._exited) return
    if (this._lifecycle?.stop === 'stdin-eof') {
      this.endStdin()
      if (this._stopTimer) return
      this._stopTimer = setTimeout(() => {
        this._stopTimer = undefined
        if (!this._exited) this.kill()
      }, this._killTimeoutMs)
      this._stopTimer.unref?.()
      return
    }
    this.kill()
  }

  /** Unconditional forced termination (tree on Windows, group on POSIX); skips grace timers. */
  hardKill(): void {
    if (this._exited) return
    this._forced = true
    if (this._shouldTreeKill()) this._killTreeNow()
    else this._send('SIGKILL')
  }

  private _shouldTreeKill(): boolean {
    return this._treeKill && process.platform === 'win32' && this._child.pid !== undefined
  }

  private _killTreeNow(sync = false): void {
    if (this._treeKilled) return
    const pid = this._child.pid
    if (pid === undefined) return
    this._treeKilled = true
    try {
      this._killTree(pid, sync)
    } catch (err) {
      this._logger?.warn(
        `ManagedChildProcess(${this._label}): tree-kill failed: ${(err as Error).message}`,
      )
    }
  }

  private _send(signal: NodeJS.Signals): void {
    const pid = this._child.pid
    if (this._processGroup && pid !== undefined) {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Not actually a group leader (spawned without `detached`) or already gone —
        // fall through to signalling the direct child.
      }
    }
    try {
      this._child.kill(signal)
    } catch (err) {
      this._logger?.warn(
        `ManagedChildProcess(${this._label}): kill(${signal}) failed: ${(err as Error).message}`,
      )
    }
  }

  private _settleExit(partial: {
    code: number | null
    signal: NodeJS.Signals | null
    error?: string
  }): void {
    if (this._exited) return
    this._exited = true
    if (this._killTimer) {
      clearTimeout(this._killTimer)
      this._killTimer = undefined
    }
    this._clearStopTimer()
    this._lease?.dispose()
    const exit: ManagedExit = partial.error
      ? { ...partial, forced: this._forced, error: partial.error }
      : { ...partial, forced: this._forced }
    this._onDidExit.fire(exit)
  }

  private _clearStopTimer(): void {
    if (this._stopTimer) {
      clearTimeout(this._stopTimer)
      this._stopTimer = undefined
    }
  }

  override dispose(): void {
    this._disposed = true
    if (this._killTimer) {
      clearTimeout(this._killTimer)
      this._killTimer = undefined
    }
    this._clearStopTimer()
    // Detach before killing: a SIGKILL reaping the child can still deliver a final
    // stdout flush or exit, and firing into a disposed emitter is noise at best.
    // stdin's `'error'` is the exception — it stays attached. An `'error'` with no
    // listener is an uncaughtException, so detaching it would hand the shutdown path
    // back the very crash this listener was added to absorb.
    this._child.stdout.off('data', this._onStdoutData)
    this._child.stderr.off('data', this._onStderrData)
    this._child.off('error', this._onChildError)
    this._child.off('exit', this._onChildExit)
    if (!this._exited) {
      // dispose() runs on the app-quit path (will-quit → service dispose), which
      // is synchronous. Use a blocking tree-kill so the main process cannot exit
      // before the grandchild agent is reaped (otherwise it survives holding the
      // inherited pipe open). A plain SIGKILL suffices off the tree-kill path.
      //
      // Bracket the synchronous kill with shutdown marks: on the update-restart
      // path this is a prime suspect for a slow quit (blocking taskkill /T /F of a
      // slow-reaping tsserver tree). Marks are no-ops outside an armed install.
      this._shutdownMark?.(`kill.start:${this._label}`)
      if (this._shouldTreeKill()) this._killTreeNow(true)
      else this._send('SIGKILL')
      this._shutdownMark?.(`kill.end:${this._label}`)
    }
    this._lease?.dispose()
    super.dispose()
  }
}
