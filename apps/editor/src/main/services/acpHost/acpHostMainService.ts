/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side ACP agent process host. Spawns the agent as a child_process with
 *  stdio pipes, forwards stdout/stderr chunks to the renderer keyed by an
 *  opaque handle, and never exposes the PID. The renderer drives the ACP
 *  protocol (newline-delimited JSON-RPC) on top of the raw byte stream.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { app } from 'electron'
import {
  createNamedLogger,
  Disposable,
  DisposableStore,
  Emitter,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import { buildChildEnv } from '../process/env.js'
import { decodeDiagnostic } from '../process/decode.js'
import {
  CHILD_PROCESS_EXITED_CODE,
  CHILD_STDIN_NOT_WRITABLE_CODE,
  ManagedChildProcess,
} from '../process/managedChildProcess.js'
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
    /**
     * Route the call through the platform shell. Defaults to win32 (so `.cmd`
     * shims like `npx` resolve). The `runAsNode` launch sets this `false`:
     * `process.execPath` is a real binary and its path may contain spaces, so a
     * shell wrapper would mis-quote it.
     */
    shell?: boolean
  },
) => ChildProcessWithoutNullStreams

/**
 * Resolves a bundled agent entry file for the `runAsNode` launch, keyed by which
 * agent it is. Injectable for tests; the default branches on whether the app is
 * packaged.
 */
export type NodeEntryResolver = (entry: 'claude' | 'codex') => string

/**
 * Lookup abstraction for `probe()` — injectable so tests don't shell out. The
 * default uses `where` / `which` and returns true when the lookup exits 0.
 */
export type AcpCommandLookup = (command: string) => Promise<boolean>

const defaultSpawner: AcpSpawner = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // On Windows, common agent entry points (`npx`, `pnpm`, `yarn`) ship as
    // `.cmd` shims that `spawn` cannot exec directly without a shell. Setting
    // `shell` routes the call through cmd.exe so PATHEXT resolution kicks in.
    // Callers may force it off (e.g. `runAsNode`, which spawns a real binary).
    shell: options.shell ?? process.platform === 'win32',
  })

/**
 * Bundled agent entries, relative to `app.getAppPath()` in the dev tree
 * (`apps/editor` → repo root → `vendor/`).
 */
const BUNDLED_CLAUDE_ENTRY_DEV = '../../vendor/claude-agent-acp/dist/index.js'
/** Bundled Claude agent entry under `resourcesPath` in a packaged build. */
const BUNDLED_CLAUDE_ENTRY_PACKAGED = 'claude-agent-acp/dist/index.js'
/** Bundled Codex agent entry in the dev tree. */
const BUNDLED_CODEX_ENTRY_DEV = '../../vendor/codex-acp/dist/index.js'
/** Bundled Codex agent entry under `resourcesPath` in a packaged build. */
const BUNDLED_CODEX_ENTRY_PACKAGED = 'codex-acp/dist/index.js'

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

const defaultResolveNodeEntry: NodeEntryResolver = (entry) => {
  const dev = entry === 'codex' ? BUNDLED_CODEX_ENTRY_DEV : BUNDLED_CLAUDE_ENTRY_DEV
  const packaged = entry === 'codex' ? BUNDLED_CODEX_ENTRY_PACKAGED : BUNDLED_CLAUDE_ENTRY_PACKAGED
  return app.isPackaged
    ? path.join(process.resourcesPath, packaged)
    : path.resolve(app.getAppPath(), dev)
}

const defaultLookup: AcpCommandLookup = (command) =>
  new Promise<boolean>((resolve) => {
    const tool = process.platform === 'win32' ? 'where' : 'which'
    const proc = spawn(tool, [command], { stdio: 'ignore', windowsHide: true })
    proc.once('error', () => resolve(false))
    proc.once('exit', (code) => resolve(code === 0))
  })

interface ProcEntry {
  readonly proc: ManagedChildProcess
  /** Owns `proc` + its stdout/stderr/exit subscriptions; disposed on exit or service dispose. */
  readonly store: DisposableStore
  readonly stdoutDecoder: StringDecoder
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

  private readonly _logger: ILogger

  constructor(
    private readonly _spawn: AcpSpawner = defaultSpawner,
    private readonly _lookup: AcpCommandLookup = defaultLookup,
    private readonly _resolveNodeEntry: NodeEntryResolver = defaultResolveNodeEntry,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'acpHost', name: 'ACP Host' })
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
      // Run the bundled agent through Electron's own Node runtime — no system
      // `node`/`npx` required. `ELECTRON_RUN_AS_NODE` is re-added here (the
      // denylist strips it from inherited/override env) because the agent
      // re-spawns itself via `process.execPath` and the child must inherit it.
      command = process.execPath
      args = [this._resolveNodeEntry(spec.nodeEntry ?? 'claude'), ...spec.args]
      env.ELECTRON_RUN_AS_NODE = '1'
      options.shell = false
    }

    let proc: ManagedChildProcess
    try {
      // Tree-kill is required whenever the spawned child is not the process that
      // actually owns the agent's stdio pipes:
      //   • shell-wrapped spawn (Windows default, for `.cmd` shims): `kill()`
      //     reaps only the `cmd.exe` wrapper and orphans the real grandchild.
      //   • runAsNode: the bundled agent re-spawns itself via `process.execPath`
      //     (see the ELECTRON_RUN_AS_NODE note above), so killing our direct
      //     child leaves that re-spawned grandchild orphaned — on Windows it then
      //     survives app quit holding the inherited pipe open (blocking teardown).
      // Either way we must recurse the PID tree (`taskkill /T`) so the real agent
      // dies. No-op off Windows, where a parent SIGKILL already reaps the group.
      const usesShell = options.shell ?? process.platform === 'win32'
      proc = new ManagedChildProcess(this._spawn(command, args, options), {
        logger: this._logger,
        label: handle,
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
      exited: false,
    }
    this._procs.set(handle, entry)

    store.add(
      proc.onStdout((data: Buffer) => {
        this._onStdout.fire({ handle, data: entry.stdoutDecoder.write(data) })
      }),
    )
    // stderr is decoded per-chunk with the OEM fallback (Windows cmd.exe shim).
    store.add(
      proc.onStderr((data: Buffer) => {
        this._onStderr.fire({ handle, data: decodeDiagnostic(data) })
      }),
    )
    store.add(
      proc.onDidExit((exit) => {
        if (entry.exited) return
        entry.exited = true
        if (exit.error !== undefined) {
          // Treat spawn failures (ENOENT etc.) as a synthetic exit so callers get
          // a single, well-defined termination signal — without this, the renderer
          // would chase an undead handle and hit "Cannot call write after a stream
          // was destroyed" on the next writeStdin.
          this._logger.warn(`proc error handle=${handle}: ${exit.error}`)
          this._onExit.fire({ handle, code: null, signal: null, error: exit.error })
        } else {
          const msg = `exit handle=${handle} code=${exit.code} signal=${exit.signal}`
          if (exit.code === 0 || exit.code === null) {
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
      // Normalize the managed wrapper's not-writable/exited rejection to AcpHost's
      // contract. Branch on the structured `code` (not the human message, which can
      // be reworded) and re-throw with a code so the renderer can classify it after
      // the error crosses IPC.
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
      if (!entry.exited) {
        entry.store.dispose()
        this._logger.info(`dispose killed handle=${handle}`)
      }
    }
    this._procs.clear()
    super.dispose()
  }
}
