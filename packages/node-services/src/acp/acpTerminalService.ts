/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpTerminalService — the Electron-free ACP terminal-pool core, shared by the
 *  local editor (apps/editor main) and the remote server daemon. Owns
 *  child_process.spawn for `terminal/*` agent requests, buffers interleaved
 *  stdout+stderr with a head-dropping ring semantic when the agent's
 *  outputByteLimit is hit, and resolves any in-flight `waitForExit` long-polls
 *  when the process exits.
 *
 *  Data shape is the platform ACP contract (structurally the same as the SDK
 *  shapes the renderer passes through) — `sessionId` was already stripped at the
 *  renderer boundary because session routing lives in renderer. `cwd` is a
 *  host-native path string; `authority` is consumed by the caller (main-side
 *  shell) before this core is reached.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  createNamedLogger,
  Disposable,
  type IAcpTerminalService,
  type AcpTerminalCreateSpec,
  type AcpTerminalCreatedInfo,
  type AcpTerminalEnvVariable,
  type AcpTerminalExitStatus,
  type AcpTerminalOutput,
  type AcpTerminalWaitExit,
  type IDisposable,
  type ILogChannel,
  type ILogger,
} from '@universe-editor/platform'
import { buildChildEnv } from '../process/env.js'
import { spawnViaCmd } from '../process/cmdSpawn.js'
import { ManagedChildProcess } from '../process/managedChildProcess.js'

export type AcpTerminalSpawner = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
  },
) => ChildProcessWithoutNullStreams

export interface AcpTerminalOptions {
  readonly spawn?: AcpTerminalSpawner
  readonly logger?: { createLogger(channel: ILogChannel): ILogger }
  /**
   * Optional per-process hook, invoked with the spawned pid + label when a
   * terminal is created. The returned disposable is released on exit / release /
   * dispose. The local editor wires this to its process-role registry; the
   * server omits it.
   */
  readonly onSpawned?: (pid: number, label: string) => IDisposable | undefined
}

const defaultSpawner: AcpTerminalSpawner = (command, args, options) => {
  // `.cmd` shims (npx, pnpm, yarn) need a cmd.exe wrapper on Windows so
  // PATHEXT resolution picks them up — same reasoning as AcpHostService.
  if (process.platform === 'win32') {
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

function envArrayToRecord(
  env: readonly AcpTerminalEnvVariable[] | undefined,
): Record<string, string> {
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
  /** Pending `waitForExit` resolvers. Drained when the proc exits or is released. */
  readonly waiters: Array<{
    resolve(info: AcpTerminalWaitExit): void
    reject(err: Error): void
  }>
  /** UTF-8 decoded buffer of stdout+stderr interleaved in arrival order. */
  buffer: string
  /** True once we've dropped any bytes from `buffer`'s head. */
  truncated: boolean
  /** Set once we've observed `exit` or `error`. Stable for the entry's lifetime. */
  exit?: AcpTerminalExitStatus
  /** True after `release()` — guards against double-release races. */
  released: boolean
  /** Host-side registration (process role) handle; released on exit / release / dispose. */
  roleRegistration: IDisposable | undefined
}

export class AcpTerminalService extends Disposable implements IAcpTerminalService {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<string, TerminalEntry>()

  private readonly _logger: ILogger
  private readonly _spawn: AcpTerminalSpawner
  private readonly _onSpawned: ((pid: number, label: string) => IDisposable | undefined) | undefined

  constructor(options: AcpTerminalOptions = {}) {
    super()
    this._logger = createNamedLogger(options.logger, { id: 'acpTerminal', name: 'ACP Terminal' })
    this._spawn = options.spawn ?? defaultSpawner
    this._onSpawned = options.onSpawned
  }

  create(spec: AcpTerminalCreateSpec): Promise<AcpTerminalCreatedInfo> {
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
      roleRegistration: undefined,
    }
    this._entries.set(id, entry)

    if (proc.pid !== undefined) {
      entry.roleRegistration = this._onSpawned?.(proc.pid, path.basename(spec.command))
    }

    proc.onStdout((chunk: Buffer) => this._appendOutput(entry, entry.stdoutDecoder.write(chunk)))
    proc.onStderr((chunk: Buffer) => this._appendOutput(entry, entry.stderrDecoder.write(chunk)))
    proc.onDidExit((exit) => {
      if (entry.exit !== undefined) return
      entry.roleRegistration?.dispose()
      if (exit.error !== undefined) {
        this._logger.warn(`proc error id=${id}: ${exit.error}`)
        entry.exit = { signal: 'SPAWN_ERROR' }
        this._appendOutput(entry, `\n[spawn error] ${exit.error}\n`)
        this._drainWaiters(entry)
        return
      }
      this._logger.info(`exit id=${id} code=${exit.code} signal=${exit.signal}`)
      const info: AcpTerminalExitStatus = {
        ...(exit.code !== null ? { exitCode: exit.code } : {}),
        ...(exit.signal !== null ? { signal: exit.signal } : {}),
      }
      entry.exit = info
      this._drainWaiters(entry)
    })

    this._logger.info(`create id=${id} command=${spec.command}`)
    return Promise.resolve({ terminalId: id })
  }

  output(terminalId: string): Promise<AcpTerminalOutput> {
    const entry = this._entries.get(terminalId)
    if (!entry || entry.released) {
      return Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    const snapshot: AcpTerminalOutput = {
      output: entry.buffer,
      truncated: entry.truncated,
      ...(entry.exit !== undefined ? { exitStatus: entry.exit } : {}),
    }
    return Promise.resolve(snapshot)
  }

  waitForExit(terminalId: string): Promise<AcpTerminalWaitExit> {
    const entry = this._entries.get(terminalId)
    if (!entry || entry.released) {
      return Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    if (entry.exit !== undefined) {
      return Promise.resolve(exitStatusToWaitResponse(entry.exit))
    }
    return new Promise<AcpTerminalWaitExit>((resolve, reject) => {
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
    entry.roleRegistration?.dispose()
    // Release implies the agent no longer cares about the process — dispose the
    // managed child (immediate SIGKILL if still alive + clears any pending kill
    // escalation timer), since we're about to drop the entry that owns it.
    entry.proc.dispose()
    const releaseErr = new Error(`AcpTerminal: terminal ${terminalId} released`)
    for (const w of entry.waiters.splice(0)) w.reject(releaseErr)
    this._entries.delete(terminalId)
    this._logger.info(`release id=${terminalId}`)
    return Promise.resolve()
  }

  override dispose(): void {
    for (const [id, entry] of this._entries) {
      entry.roleRegistration?.dispose()
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

function exitStatusToWaitResponse(info: AcpTerminalExitStatus): AcpTerminalWaitExit {
  return {
    ...(info.exitCode != null ? { exitCode: info.exitCode } : {}),
    ...(info.signal != null ? { signal: info.signal } : {}),
  }
}
