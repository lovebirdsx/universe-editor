/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side ACP agent process host. Spawns the agent as a child_process with
 *  stdio pipes, forwards stdout/stderr chunks to the renderer keyed by an
 *  opaque handle, and never exposes the PID. The renderer drives the ACP
 *  protocol (newline-delimited JSON-RPC) on top of the raw byte stream.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Disposable, Emitter, type ILogger } from '@universe-editor/platform'
import type {
  AcpExitEvent,
  AcpLaunchSpec,
  AcpStartResult,
  AcpStdioChunk,
  IAcpHostService,
} from '../../../shared/ipc/acpHostService.js'

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
  },
) => ChildProcessWithoutNullStreams

const defaultSpawner: AcpSpawner = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // On Windows, common agent entry points (`npx`, `pnpm`, `yarn`) ship as
    // `.cmd` shims that `spawn` cannot exec directly without a shell. Setting
    // `shell` routes the call through cmd.exe so PATHEXT resolution kicks in.
    shell: process.platform === 'win32',
  })

interface ProcEntry {
  readonly proc: ChildProcessWithoutNullStreams
  exited: boolean
}

export class AcpHostMainService extends Disposable implements IAcpHostService {
  declare readonly _serviceBrand: undefined

  private readonly _onStdout = this._register(new Emitter<AcpStdioChunk>())
  readonly onStdout = this._onStdout.event

  private readonly _onStderr = this._register(new Emitter<AcpStdioChunk>())
  readonly onStderr = this._onStderr.event

  private readonly _onExit = this._register(new Emitter<AcpExitEvent>())
  readonly onExit = this._onExit.event

  private readonly _procs = new Map<string, ProcEntry>()

  constructor(
    private readonly _logger: ILogger,
    private readonly _spawn: AcpSpawner = defaultSpawner,
  ) {
    super()
  }

  start(spec: AcpLaunchSpec): Promise<AcpStartResult> {
    const handle = randomUUID()
    const env: NodeJS.ProcessEnv = { ...process.env, ...(spec.env ?? {}) }
    const options: { cwd?: string; env?: NodeJS.ProcessEnv } = { env }
    if (spec.cwd !== undefined) options.cwd = spec.cwd
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = this._spawn(spec.command, spec.args, options)
    } catch (err) {
      this._logger.warn(
        `[acpHost] spawn failed handle=${handle} command=${spec.command}: ${(err as Error).message}`,
      )
      return Promise.reject(err as Error)
    }

    const entry: ProcEntry = { proc, exited: false }
    this._procs.set(handle, entry)

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (data: string) => {
      this._onStdout.fire({ handle, data })
    })
    proc.stderr.on('data', (data: string) => {
      this._onStderr.fire({ handle, data })
    })
    proc.on('error', (err) => {
      this._logger.warn(`[acpHost] proc error handle=${handle}: ${err.message}`)
      // Treat spawn failures (ENOENT etc.) as a synthetic exit so callers get
      // a single, well-defined termination signal — without this, the renderer
      // would chase an undead handle and hit "Cannot call write after a stream
      // was destroyed" on the next writeStdin.
      if (entry.exited) return
      entry.exited = true
      this._onExit.fire({ handle, code: null, signal: null, error: err.message })
      this._procs.delete(handle)
    })
    proc.on('exit', (code, signal) => {
      if (entry.exited) return
      entry.exited = true
      this._logger.info(`[acpHost] exit handle=${handle} code=${code} signal=${signal}`)
      this._onExit.fire({ handle, code, signal })
      this._procs.delete(handle)
    })

    this._logger.info(`[acpHost] start handle=${handle} command=${spec.command}`)
    return Promise.resolve({ handle })
  }

  writeStdin(handle: string, data: string): Promise<void> {
    const entry = this._procs.get(handle)
    if (!entry || entry.exited) {
      return Promise.reject(new Error(`AcpHost: unknown or exited handle ${handle}`))
    }
    // Defend against the narrow race where the child died after `start` but
    // before the 'exit' / 'error' event reached us — stdin can already be
    // destroyed even though `entry.exited` is still false.
    const stdin = entry.proc.stdin
    if (stdin.destroyed || stdin.writable === false) {
      return Promise.reject(new Error(`AcpHost: stdin is not writable for handle ${handle}`))
    }
    return new Promise<void>((resolve, reject) => {
      stdin.write(data, 'utf8', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  stop(handle: string): Promise<void> {
    const entry = this._procs.get(handle)
    if (!entry || entry.exited) {
      return Promise.resolve()
    }
    try {
      entry.proc.kill()
    } catch (err) {
      this._logger.warn(`[acpHost] kill failed handle=${handle}: ${(err as Error).message}`)
    }
    return Promise.resolve()
  }

  override dispose(): void {
    for (const [handle, entry] of this._procs) {
      if (!entry.exited) {
        try {
          entry.proc.kill()
        } catch {
          // ignore — we're shutting down
        }
        this._logger.info(`[acpHost] dispose killed handle=${handle}`)
      }
    }
    this._procs.clear()
    super.dispose()
  }
}
