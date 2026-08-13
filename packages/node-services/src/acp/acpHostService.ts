/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpHostService — the Electron-free ACP agent spawn core, shared by the local
 *  editor (apps/editor main) and the remote server daemon. Spawns the agent as a
 *  child_process with stdio pipes, forwards stdout/stderr chunks keyed by an
 *  opaque handle, and never exposes the PID. The renderer drives the ACP
 *  protocol (newline-delimited JSON-RPC) on top of the raw byte stream.
 *
 *  It eats a NARROW input — `cwd` is a host-native path string and `authority` is
 *  already consumed by the caller (the main-side thin shell routes a remote
 *  launch to the server before this core is reached). Env sanitization uses the
 *  shared buildChildEnv denylist so a compromised agent cannot reinterpret an
 *  Electron helper or smuggle a --require payload.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  createNamedLogger,
  Disposable,
  DisposableStore,
  Emitter,
  type IAcpHostService,
  type AcpExitEvent,
  type AcpLaunchSpec,
  type AcpStartResult,
  type AcpStdioChunk,
  type IDisposable,
  type ILogChannel,
  type ILogger,
} from '@universe-editor/platform'
import { buildChildEnv } from '../process/env.js'
import { spawnViaCmd } from '../process/cmdSpawn.js'
import { decodeDiagnostic } from '../process/decode.js'
import {
  CHILD_PROCESS_EXITED_CODE,
  CHILD_STDIN_NOT_WRITABLE_CODE,
  ManagedChildProcess,
} from '../process/managedChildProcess.js'

/**
 * Spawner abstraction — injectable for tests so we don't have to launch real
 * processes. The default factory is `node:child_process.spawn`.
 */
export type AcpSpawner = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    /**
     * Route the call through a cmd.exe wrapper. Defaults to win32 (so `.cmd`
     * shims like `npx` resolve). The `runAsNode` launch sets this `false`:
     * `process.execPath` is a real binary and its path may contain spaces, so a
     * shell wrapper would mis-quote it.
     */
    shell?: boolean
  },
) => ChildProcessWithoutNullStreams

/** Resolves a bundled agent entry file for the `runAsNode` launch. */
export type NodeEntryResolver = (entry: 'claude' | 'codex') => string

/** Lookup abstraction for `probe()` — injectable so tests don't shell out. */
export type AcpCommandLookup = (command: string) => Promise<boolean>

/**
 * Extra env re-added to a `runAsNode` child. On the local editor this must be
 * `{ ELECTRON_RUN_AS_NODE: '1' }` (the child is Electron's `process.execPath`);
 * on a plain Node server it must be empty. Defaults to the runtime auto-detected
 * from `process.versions.electron`.
 */
export type RunAsNodeEnv = () => Record<string, string>

export interface AcpHostOptions {
  readonly spawn?: AcpSpawner
  readonly lookup?: AcpCommandLookup
  readonly resolveNodeEntry?: NodeEntryResolver
  readonly runAsNodeEnv?: RunAsNodeEnv
  readonly logger?: { createLogger(channel: ILogChannel): ILogger }
  /**
   * Optional per-process hook, invoked with the spawned pid + label when an
   * agent is started. The returned disposable is released on exit / dispose.
   * The local editor wires this to its process-role registry; the server omits it.
   */
  readonly onSpawned?: (pid: number, label: string) => IDisposable | undefined
}

const defaultSpawner: AcpSpawner = (command, args, options) => {
  // On Windows, common agent entry points (`npx`, `pnpm`, `yarn`) ship as
  // `.cmd` shims that `spawn` cannot exec directly without a shell. Route the
  // call through an explicit cmd.exe wrapper so PATHEXT resolution kicks in.
  if (options.shell ?? process.platform === 'win32') {
    return spawnViaCmd(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env,
    })
  }
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

const defaultLookup: AcpCommandLookup = (command) =>
  new Promise<boolean>((resolve) => {
    const tool = process.platform === 'win32' ? 'where' : 'which'
    const proc = spawn(tool, [command], { stdio: 'ignore', windowsHide: true })
    proc.once('error', () => resolve(false))
    proc.once('exit', (code) => resolve(code === 0))
  })

function defaultRunAsNodeEnv(): Record<string, string> {
  return process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

/**
 * Code stamped on `writeStdin` rejections after the child can no longer accept
 * input (exited / stdin destroyed). Consumers classify by this code rather than
 * matching the message; it rides the structured IPC error envelope to the renderer.
 */
export const ACP_HOST_STDIN_NOT_WRITABLE_CODE = 'ACP_HOST_STDIN_NOT_WRITABLE'

function acpHostStdinError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = ACP_HOST_STDIN_NOT_WRITABLE_CODE
  return err
}

interface ProcEntry {
  readonly proc: ManagedChildProcess
  /** Owns `proc` + its stdout/stderr/exit subscriptions; disposed on exit or service dispose. */
  readonly store: DisposableStore
  readonly stdoutDecoder: StringDecoder
  roleRegistration: IDisposable | undefined
  exited: boolean
}

export class AcpHostService extends Disposable implements IAcpHostService {
  declare readonly _serviceBrand: undefined

  private readonly _onStdout = this._register(new Emitter<AcpStdioChunk>())
  readonly onStdout = this._onStdout.event

  private readonly _onStderr = this._register(new Emitter<AcpStdioChunk>())
  readonly onStderr = this._onStderr.event

  private readonly _onExit = this._register(new Emitter<AcpExitEvent>())
  readonly onExit = this._onExit.event

  private readonly _procs = new Map<string, ProcEntry>()

  private readonly _logger: ILogger
  private readonly _spawn: AcpSpawner
  private readonly _lookup: AcpCommandLookup
  private readonly _resolveNodeEntry: NodeEntryResolver
  private readonly _runAsNodeEnv: RunAsNodeEnv
  private readonly _onSpawned: ((pid: number, label: string) => IDisposable | undefined) | undefined

  constructor(options: AcpHostOptions = {}) {
    super()
    this._logger = createNamedLogger(options.logger, { id: 'acpHost', name: 'ACP Host' })
    this._spawn = options.spawn ?? defaultSpawner
    this._lookup = options.lookup ?? defaultLookup
    this._resolveNodeEntry = options.resolveNodeEntry ?? (() => '')
    this._runAsNodeEnv = options.runAsNodeEnv ?? defaultRunAsNodeEnv
    this._onSpawned = options.onSpawned
  }

  start(spec: AcpLaunchSpec): Promise<AcpStartResult> {
    const handle = randomUUID()
    if (spec.cwd !== undefined && !path.isAbsolute(spec.cwd)) {
      return Promise.reject(
        new Error(`AcpHost: cwd must be an absolute path, got ${JSON.stringify(spec.cwd)}`),
      )
    }
    const env = buildChildEnv(process.env, spec.env ? { overrides: spec.env } : {})
    const options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean } = { env }
    if (spec.cwd !== undefined) options.cwd = spec.cwd
    if (spec.shell !== undefined) options.shell = spec.shell

    let command = spec.command
    let args: readonly string[] = spec.args
    if (spec.runAsNode) {
      // Run the bundled agent through the host's own Node runtime — no system
      // `node`/`npx` required. On the local editor the self-exec env
      // (ELECTRON_RUN_AS_NODE) is re-added because the agent re-spawns itself via
      // `process.execPath` and the child must inherit it; a plain Node server
      // adds nothing.
      command = process.execPath
      args = [this._resolveNodeEntry(spec.nodeEntry ?? 'claude'), ...spec.args]
      Object.assign(env, this._runAsNodeEnv())
      options.shell = false
    }

    let proc: ManagedChildProcess
    try {
      const usesShell = options.shell ?? process.platform === 'win32'
      proc = new ManagedChildProcess(this._spawn(command, args, options), {
        logger: this._logger,
        label: handle,
        // Tree-kill is required whenever the spawned child is not the process
        // that actually owns the agent's stdio pipes (cmd wrapper or the
        // runAsNode re-spawned grandchild).
        treeKill: usesShell || spec.runAsNode === true,
      })
    } catch (err) {
      this._logger.warn(
        `spawn failed handle=${handle} command=${command}: ${(err as Error).message}`,
      )
      return Promise.reject(err as Error)
    }

    const store = new DisposableStore()
    store.add(proc)
    const entry: ProcEntry = {
      proc,
      store,
      stdoutDecoder: new StringDecoder('utf8'),
      roleRegistration: undefined,
      exited: false,
    }
    this._procs.set(handle, entry)

    if (proc.pid !== undefined) {
      const agent = spec.runAsNode ? (spec.nodeEntry ?? 'claude') : path.basename(spec.command)
      entry.roleRegistration = this._onSpawned?.(proc.pid, agent)
    }

    store.add(
      proc.onStdout((data: Buffer) => {
        this._onStdout.fire({ handle, data: entry.stdoutDecoder.write(data) })
      }),
    )
    // stderr is decoded per-chunk with the OEM fallback (Windows cmd.exe wrapper).
    store.add(
      proc.onStderr((data: Buffer) => {
        this._onStderr.fire({ handle, data: decodeDiagnostic(data) })
      }),
    )
    store.add(
      proc.onDidExit((exit) => {
        if (entry.exited) return
        entry.exited = true
        entry.roleRegistration?.dispose()
        if (exit.error !== undefined) {
          // Treat spawn failures (ENOENT etc.) as a synthetic exit so callers get
          // a single, well-defined termination signal.
          this._logger.warn(`proc error handle=${handle}: ${exit.error}`)
          this._onExit.fire({ handle, code: null, signal: null, error: exit.error })
        } else {
          const msg = `exit handle=${handle} code=${exit.code} signal=${exit.signal}`
          if (exit.code === 0 || exit.code === null || exit.forced) {
            this._logger.info(msg)
          } else {
            this._logger.warn(msg)
          }
          this._onExit.fire({ handle, code: exit.code, signal: exit.signal })
        }
        this._procs.delete(handle)
        store.dispose()
      }),
    )

    this._logger.info(`start handle=${handle} command=${spec.command} cwd=${spec.cwd ?? ''}`)
    return Promise.resolve({ handle })
  }

  writeStdin(handle: string, data: string): Promise<void> {
    const entry = this._procs.get(handle)
    if (!entry || entry.exited) {
      return Promise.reject(acpHostStdinError(`AcpHost: unknown or exited handle ${handle}`))
    }
    return entry.proc.writeStdin(data).catch((err: Error) => {
      const code = (err as { code?: unknown }).code
      if (code === CHILD_STDIN_NOT_WRITABLE_CODE || code === CHILD_PROCESS_EXITED_CODE) {
        throw acpHostStdinError(`AcpHost: stdin is not writable for handle ${handle}`)
      }
      throw err
    })
  }

  stop(handle: string): Promise<void> {
    const entry = this._procs.get(handle)
    if (!entry || entry.exited) {
      return Promise.resolve()
    }
    entry.proc.kill()
    return Promise.resolve()
  }

  async probe(command: string): Promise<boolean> {
    if (!command) return false
    try {
      return await this._lookup(command)
    } catch (err) {
      this._logger.warn(`probe failed for ${command}: ${(err as Error).message}`)
      return false
    }
  }

  override dispose(): void {
    for (const [handle, entry] of this._procs) {
      entry.roleRegistration?.dispose()
      if (!entry.exited) {
        entry.store.dispose()
        this._logger.info(`dispose killed handle=${handle}`)
      }
    }
    this._procs.clear()
    super.dispose()
  }
}
