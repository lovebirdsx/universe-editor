/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side ACP terminal pool. Owns child_process.spawn for `terminal/*`
 *  agent requests, buffers interleaved stdout+stderr with a head-dropping ring
 *  semantic when the agent's outputByteLimit is hit, and resolves any
 *  in-flight `waitForExit` long-polls when the process exits.
 *
 *  Env sanitization mirrors AcpHostMainService — ELECTRON_RUN_AS_NODE,
 *  NODE_OPTIONS, etc. are stripped before the spawn so a compromised agent
 *  cannot reinterpret an Electron helper or smuggle a --require payload.
 *
 *  cwd must be absolute. The renderer additionally validates the path against
 *  the session sandbox via IAcpPathPolicy before reaching this service; this
 *  guard is defense-in-depth, not the primary check.
 *
 *  Data shape is SDK-native (`CreateTerminalResponse` / `TerminalOutputResponse`
 *  / `WaitForTerminalExitResponse` / `TerminalExitStatus`). The SDK form of
 *  `env` is `Array<EnvVariable>`; we convert to a Record only when feeding
 *  child_process.spawn.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  createNamedLogger,
  Disposable,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import type {
  CreateTerminalResponse,
  EnvVariable,
  TerminalExitStatus,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'
import { buildChildEnv } from '../process/env.js'
import { ManagedChildProcess } from '../process/managedChildProcess.js'
import type {
  AcpTerminalCreateSpec,
  IAcpTerminalService,
} from '../../../shared/ipc/acpTerminalService.js'

export type AcpTerminalSpawner = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
  },
) => ChildProcessWithoutNullStreams

const defaultSpawner: AcpTerminalSpawner = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // `.cmd` shims (npx, pnpm, yarn) need the shell on Windows so PATHEXT
    // resolution picks them up — same reasoning as AcpHostMainService.
    shell: process.platform === 'win32',
  })

function envArrayToRecord(env: readonly EnvVariable[] | undefined): Record<string, string> {
  if (!env) return {}
  const out: Record<string, string> = {}
  for (const v of env) out[v.name] = v.value
  return out
}

/** Default byte cap if the agent does not specify one. */
const DEFAULT_OUTPUT_BYTE_LIMIT = 1 * 1024 * 1024 // 1 MiB
/** Absolute ceiling regardless of agent-supplied value — bounds memory. */
const MAX_OUTPUT_BYTE_LIMIT = 16 * 1024 * 1024 // 16 MiB
/** Minimum so a degenerate `outputByteLimit: 0` still yields a usable buffer. */
const MIN_OUTPUT_BYTE_LIMIT = 1024

interface TerminalEntry {
  readonly proc: ManagedChildProcess
  readonly byteLimit: number
  /** Per-stream UTF-8 decoders so a multibyte char split across chunks survives. */
  readonly stdoutDecoder: StringDecoder
  readonly stderrDecoder: StringDecoder
  /**
   * Pending `waitForExit` resolvers. Drained when the proc exits or the
   * terminal is released.
   */
  readonly waiters: Array<{
    resolve(info: WaitForTerminalExitResponse): void
    reject(err: Error): void
  }>
  /** UTF-8 decoded buffer of stdout+stderr interleaved in arrival order. */
  buffer: string
  /** True once we've dropped any bytes from `buffer`'s head. */
  truncated: boolean
  /** Set once we've observed `exit` or `error`. Stable for the entry's lifetime. */
  exit?: TerminalExitStatus
  /** True after `release()` — guards against double-release races. */
  released: boolean
}

export class AcpTerminalMainService extends Disposable implements IAcpTerminalService {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<string, TerminalEntry>()

  private readonly _logger: ILogger

  constructor(
    private readonly _spawn: AcpTerminalSpawner = defaultSpawner,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'acpTerminal', name: 'ACP Terminal' })
  }

  create(spec: AcpTerminalCreateSpec): Promise<CreateTerminalResponse> {
    if (typeof spec.command !== 'string' || spec.command.length === 0) {
      return Promise.reject(new Error('AcpTerminal: command must be a non-empty string'))
    }
    if (spec.cwd != null && !path.isAbsolute(spec.cwd)) {
      return Promise.reject(
        new Error(`AcpTerminal: cwd must be an absolute path, got ${JSON.stringify(spec.cwd)}`),
      )
    }
    const env = buildChildEnv(process.env, { overrides: envArrayToRecord(spec.env) })
    const options: { cwd?: string; env?: NodeJS.ProcessEnv } = { env }
    if (spec.cwd != null) options.cwd = spec.cwd

    const id = randomUUID()
    let proc: ManagedChildProcess
    try {
      // Windows spawns through cmd.exe (for `.cmd` shims); tree-kill on stop so
      // the real grandchild dies instead of orphaning under the shell wrapper.
      proc = new ManagedChildProcess(this._spawn(spec.command, spec.args ?? [], options), {
        logger: this._logger,
        label: id,
        treeKill: process.platform === 'win32',
      })
    } catch (err) {
      this._logger.warn(`spawn failed command=${spec.command}: ${(err as Error).message}`)
      return Promise.reject(err as Error)
    }

    const requested = spec.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT
    const byteLimit = Math.max(MIN_OUTPUT_BYTE_LIMIT, Math.min(requested, MAX_OUTPUT_BYTE_LIMIT))
    const entry: TerminalEntry = {
      proc,
      byteLimit,
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      waiters: [],
      buffer: '',
      truncated: false,
      released: false,
    }
    this._entries.set(id, entry)

    proc.onStdout((chunk: Buffer) => this._appendOutput(entry, entry.stdoutDecoder.write(chunk)))
    proc.onStderr((chunk: Buffer) => this._appendOutput(entry, entry.stderrDecoder.write(chunk)))
    proc.onDidExit((exit) => {
      if (entry.exit !== undefined) return
      if (exit.error !== undefined) {
        // Surface spawn failures (ENOENT etc.) as a synthetic exit so the agent
        // gets a deterministic terminal status instead of hanging on
        // wait_for_exit.
        this._logger.warn(`proc error id=${id}: ${exit.error}`)
        entry.exit = { signal: 'SPAWN_ERROR' }
        this._appendOutput(entry, `\n[spawn error] ${exit.error}\n`)
        this._drainWaiters(entry)
        return
      }
      this._logger.info(`exit id=${id} code=${exit.code} signal=${exit.signal}`)
      const info: TerminalExitStatus = {
        ...(exit.code !== null ? { exitCode: exit.code } : {}),
        ...(exit.signal !== null ? { signal: exit.signal } : {}),
      }
      entry.exit = info
      this._drainWaiters(entry)
    })

    this._logger.info(`create id=${id} command=${spec.command}`)
    return Promise.resolve({ terminalId: id })
  }

  output(terminalId: string): Promise<TerminalOutputResponse> {
    const entry = this._entries.get(terminalId)
    if (!entry || entry.released) {
      return Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    const snapshot: TerminalOutputResponse = {
      output: entry.buffer,
      truncated: entry.truncated,
      ...(entry.exit !== undefined ? { exitStatus: entry.exit } : {}),
    }
    return Promise.resolve(snapshot)
  }

  waitForExit(terminalId: string): Promise<WaitForTerminalExitResponse> {
    const entry = this._entries.get(terminalId)
    if (!entry || entry.released) {
      return Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    if (entry.exit !== undefined) {
      return Promise.resolve(exitStatusToWaitResponse(entry.exit))
    }
    return new Promise<WaitForTerminalExitResponse>((resolve, reject) => {
      entry.waiters.push({ resolve, reject })
    })
  }

  kill(terminalId: string): Promise<void> {
    const entry = this._entries.get(terminalId)
    if (!entry || entry.released) {
      return Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    if (entry.exit !== undefined) return Promise.resolve()
    entry.proc.kill()
    return Promise.resolve()
  }

  release(terminalId: string): Promise<void> {
    const entry = this._entries.get(terminalId)
    if (!entry) return Promise.resolve()
    if (entry.released) return Promise.resolve()
    entry.released = true
    // Release implies the agent no longer cares about the process — dispose the
    // managed child (immediate SIGKILL if still alive + clears any pending kill
    // escalation timer), since we're about to drop the entry that owns it.
    entry.proc.dispose()
    // Reject any in-flight wait_for_exit so the agent doesn't hang on a
    // promise the server can never deliver.
    const releaseErr = new Error(`AcpTerminal: terminal ${terminalId} released`)
    for (const w of entry.waiters.splice(0)) w.reject(releaseErr)
    this._entries.delete(terminalId)
    this._logger.info(`release id=${terminalId}`)
    return Promise.resolve()
  }

  override dispose(): void {
    for (const [id, entry] of this._entries) {
      entry.proc.dispose()
      const err = new Error('AcpTerminal: service disposed')
      for (const w of entry.waiters.splice(0)) w.reject(err)
      this._logger.info(`dispose killed id=${id}`)
    }
    this._entries.clear()
    super.dispose()
  }

  private _appendOutput(entry: TerminalEntry, chunk: string): void {
    if (entry.released) return
    if (chunk.length === 0) return
    const merged = entry.buffer + chunk
    if (merged.length <= entry.byteLimit) {
      entry.buffer = merged
      return
    }
    // Drop bytes from the head until we fit. This is "byte" semantics on a
    // UTF-16 JS string in practice — sufficient for buffering policy without
    // turning every chunk into a Buffer allocation.
    entry.buffer = merged.slice(merged.length - entry.byteLimit)
    entry.truncated = true
  }

  private _drainWaiters(entry: TerminalEntry): void {
    const info = entry.exit
    if (!info) return
    const resp = exitStatusToWaitResponse(info)
    for (const w of entry.waiters.splice(0)) w.resolve(resp)
  }
}

function exitStatusToWaitResponse(info: TerminalExitStatus): WaitForTerminalExitResponse {
  return {
    ...(info.exitCode != null ? { exitCode: info.exitCode } : {}),
    ...(info.signal != null ? { signal: info.signal } : {}),
  }
}
