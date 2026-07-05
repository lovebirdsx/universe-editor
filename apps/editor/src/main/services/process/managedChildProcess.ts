/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared lifecycle wrapper for main-process child processes spawned via
 *  node:child_process. Centralizes what every spawn site previously re-wrote by
 *  hand: forced kill with a SIGTERM→SIGKILL timeout escalation, a single
 *  well-defined exit signal (spawn errors are surfaced as a synthetic exit), and
 *  raw stdout/stderr byte bridging (the caller decides the encoding).
 *
 *  It wraps an already-spawned child rather than spawning itself, because spawn
 *  argument assembly (shell, stdio, cwd, env) differs per call site. Decoding is
 *  left to the consumer (text search uses a StringDecoder for NDJSON, the ACP
 *  hosts decode stderr as gb18030) — see env.ts / decode.ts for the shared
 *  helpers those call sites use.
 *--------------------------------------------------------------------------------------------*/

import { execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Disposable, Emitter, type ILogger } from '@universe-editor/platform'

export const DEFAULT_KILL_TIMEOUT_MS = 2000

/**
 * Tear down a whole process tree by PID. On Windows a `shell: true` spawn wraps
 * the real command in `cmd.exe`; `child.kill()` (TerminateProcess) then only
 * reaps the wrapper, leaving the grandchild (node/npx agent, shell command)
 * orphaned with a dangling stdin pipe. `taskkill /T` recurses the parent-PID
 * tree so the real process dies too. Injectable so unit tests don't shell out.
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
      execFileSync('taskkill', args, { stdio: 'ignore' })
    } catch {
      // Best-effort: already exited, partial tree, or taskkill unavailable.
    }
    return
  }
  execFile('taskkill', args, () => {
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
   * When the child was spawned with `shell: true` on Windows, `kill()` only
   * reaps the `cmd.exe` wrapper and orphans the real grandchild process. Set
   * this so termination recurses the PID tree (`taskkill /T`) instead. No-op
   * off Windows, where a parent SIGKILL already reaps the group.
   */
  readonly treeKill?: boolean
  /** Injectable tree-killer for tests. Defaults to `taskkill /T /F`. */
  readonly killTree?: TreeKiller
}

/**
 * Wraps a spawned child with a uniform lifecycle. Emits raw stdout/stderr
 * buffers and exactly one {@link ManagedExit} (whether the child exited, errored
 * on spawn, or was force-killed).
 */
export class ManagedChildProcess extends Disposable {
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

  private _exited = false
  private _forced = false
  private _treeKilled = false
  private _killTimer: ReturnType<typeof setTimeout> | undefined

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

    _child.stdout.on('data', (data: Buffer) => this._onStdout.fire(data))
    _child.stderr.on('data', (data: Buffer) => this._onStderr.fire(data))
    _child.on('error', (err) => this._settleExit({ code: null, signal: null, error: err.message }))
    _child.on('exit', (code, signal) => this._settleExit({ code, signal }))
  }

  get pid(): number | undefined {
    return this._child.pid
  }

  get exited(): boolean {
    return this._exited
  }

  writeStdin(data: string): Promise<void> {
    if (this._exited) {
      return Promise.reject(new Error(`ManagedChildProcess(${this._label}): process has exited`))
    }
    const stdin = this._child.stdin
    // Defend against the narrow race where the child died after spawn but before
    // its exit/error event reached us — stdin can already be destroyed.
    if (stdin.destroyed || stdin.writable === false) {
      return Promise.reject(new Error(`ManagedChildProcess(${this._label}): stdin is not writable`))
    }
    return new Promise<void>((resolve, reject) => {
      stdin.write(data, 'utf8', (err) => {
        if (err) reject(err)
        else resolve()
      })
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
    const exit: ManagedExit = partial.error
      ? { ...partial, forced: this._forced, error: partial.error }
      : { ...partial, forced: this._forced }
    this._onDidExit.fire(exit)
  }

  override dispose(): void {
    if (this._killTimer) {
      clearTimeout(this._killTimer)
      this._killTimer = undefined
    }
    if (!this._exited) {
      // dispose() runs on the app-quit path (will-quit → service dispose), which
      // is synchronous. Use a blocking tree-kill so the main process cannot exit
      // before the grandchild agent is reaped (otherwise it survives holding the
      // inherited pipe open). A plain SIGKILL suffices off the tree-kill path.
      if (this._shouldTreeKill()) this._killTreeNow(true)
      else this._send('SIGKILL')
    }
    super.dispose()
  }
}
