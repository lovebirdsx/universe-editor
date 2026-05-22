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
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { Disposable, type ILogger } from '@universe-editor/platform'
import type {
  AcpTerminalCreateResultWire,
  AcpTerminalExitInfo,
  AcpTerminalOutputSnapshot,
  AcpTerminalSpec,
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

/** Defense-in-depth env denylist; identical to AcpHostMainService. */
const ENV_DENYLIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
]

function sanitizeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (ENV_DENYLIST.includes(k)) continue
    out[k] = v
  }
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (ENV_DENYLIST.includes(k)) continue
      out[k] = v
    }
  }
  return out
}

/** Default byte cap if the agent does not specify one. */
const DEFAULT_OUTPUT_BYTE_LIMIT = 1 * 1024 * 1024 // 1 MiB
/** Absolute ceiling regardless of agent-supplied value — bounds memory. */
const MAX_OUTPUT_BYTE_LIMIT = 16 * 1024 * 1024 // 16 MiB
/** Minimum so a degenerate `outputByteLimit: 0` still yields a usable buffer. */
const MIN_OUTPUT_BYTE_LIMIT = 1024

interface TerminalEntry {
  readonly proc: ChildProcessWithoutNullStreams
  readonly byteLimit: number
  /**
   * Pending `waitForExit` resolvers. Drained when the proc exits or the
   * terminal is released.
   */
  readonly waiters: Array<{
    resolve(info: AcpTerminalExitInfo): void
    reject(err: Error): void
  }>
  /** UTF-8 decoded buffer of stdout+stderr interleaved in arrival order. */
  buffer: string
  /** True once we've dropped any bytes from `buffer`'s head. */
  truncated: boolean
  /** Set once we've observed `exit` or `error`. Stable for the entry's lifetime. */
  exit?: AcpTerminalExitInfo
  /** True after `release()` — guards against double-release races. */
  released: boolean
}

export class AcpTerminalMainService extends Disposable implements IAcpTerminalService {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<string, TerminalEntry>()

  constructor(
    private readonly _logger: ILogger,
    private readonly _spawn: AcpTerminalSpawner = defaultSpawner,
  ) {
    super()
  }

  create(spec: AcpTerminalSpec): Promise<AcpTerminalCreateResultWire> {
    if (typeof spec.command !== 'string' || spec.command.length === 0) {
      return Promise.reject(new Error('AcpTerminal: command must be a non-empty string'))
    }
    if (spec.cwd !== undefined && !path.isAbsolute(spec.cwd)) {
      return Promise.reject(
        new Error(`AcpTerminal: cwd must be an absolute path, got ${JSON.stringify(spec.cwd)}`),
      )
    }
    const env = sanitizeEnv(process.env, spec.env)
    const options: { cwd?: string; env?: NodeJS.ProcessEnv } = { env }
    if (spec.cwd !== undefined) options.cwd = spec.cwd

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = this._spawn(spec.command, spec.args, options)
    } catch (err) {
      this._logger.warn(
        `[acpTerminal] spawn failed command=${spec.command}: ${(err as Error).message}`,
      )
      return Promise.reject(err as Error)
    }

    const id = randomUUID()
    const requested = spec.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT
    const byteLimit = Math.max(MIN_OUTPUT_BYTE_LIMIT, Math.min(requested, MAX_OUTPUT_BYTE_LIMIT))
    const entry: TerminalEntry = {
      proc,
      byteLimit,
      waiters: [],
      buffer: '',
      truncated: false,
      released: false,
    }
    this._entries.set(id, entry)

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this._appendOutput(entry, chunk))
    proc.stderr.on('data', (chunk: string) => this._appendOutput(entry, chunk))
    proc.on('error', (err) => {
      this._logger.warn(`[acpTerminal] proc error id=${id}: ${err.message}`)
      // Surface spawn failures (ENOENT etc.) as a synthetic exit so the agent
      // gets a deterministic terminal status instead of hanging on
      // wait_for_exit.
      if (entry.exit !== undefined) return
      entry.exit = { signal: 'SPAWN_ERROR' }
      this._appendOutput(entry, `\n[spawn error] ${err.message}\n`)
      this._drainWaiters(entry)
    })
    proc.on('exit', (code, signal) => {
      if (entry.exit !== undefined) return
      this._logger.info(`[acpTerminal] exit id=${id} code=${code} signal=${signal}`)
      const info: AcpTerminalExitInfo = {
        ...(code !== null ? { exitCode: code } : {}),
        ...(signal !== null ? { signal } : {}),
      }
      entry.exit = info
      this._drainWaiters(entry)
    })

    this._logger.info(`[acpTerminal] create id=${id} command=${spec.command}`)
    return Promise.resolve({ terminalId: id })
  }

  output(terminalId: string): Promise<AcpTerminalOutputSnapshot> {
    const entry = this._entries.get(terminalId)
    if (!entry || entry.released) {
      return Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    const snapshot: AcpTerminalOutputSnapshot = {
      output: entry.buffer,
      truncated: entry.truncated,
      ...(entry.exit !== undefined ? { exitStatus: entry.exit } : {}),
    }
    return Promise.resolve(snapshot)
  }

  waitForExit(terminalId: string): Promise<AcpTerminalExitInfo> {
    const entry = this._entries.get(terminalId)
    if (!entry || entry.released) {
      return Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    if (entry.exit !== undefined) {
      return Promise.resolve(entry.exit)
    }
    return new Promise<AcpTerminalExitInfo>((resolve, reject) => {
      entry.waiters.push({ resolve, reject })
    })
  }

  kill(terminalId: string): Promise<void> {
    const entry = this._entries.get(terminalId)
    if (!entry || entry.released) {
      return Promise.reject(new Error(`AcpTerminal: unknown terminal ${terminalId}`))
    }
    if (entry.exit !== undefined) return Promise.resolve()
    try {
      entry.proc.kill()
    } catch (err) {
      this._logger.warn(`[acpTerminal] kill failed id=${terminalId}: ${(err as Error).message}`)
    }
    return Promise.resolve()
  }

  release(terminalId: string): Promise<void> {
    const entry = this._entries.get(terminalId)
    if (!entry) return Promise.resolve()
    if (entry.released) return Promise.resolve()
    entry.released = true
    // Kill if still alive — release implies the agent no longer cares about
    // observing the process, so cleanest to stop it.
    if (entry.exit === undefined) {
      try {
        entry.proc.kill()
      } catch {
        // ignore — best-effort
      }
    }
    // Reject any in-flight wait_for_exit so the agent doesn't hang on a
    // promise the server can never deliver.
    const releaseErr = new Error(`AcpTerminal: terminal ${terminalId} released`)
    for (const w of entry.waiters.splice(0)) w.reject(releaseErr)
    this._entries.delete(terminalId)
    this._logger.info(`[acpTerminal] release id=${terminalId}`)
    return Promise.resolve()
  }

  override dispose(): void {
    for (const [id, entry] of this._entries) {
      if (entry.exit === undefined) {
        try {
          entry.proc.kill()
        } catch {
          // ignore — shutting down
        }
      }
      const err = new Error('AcpTerminal: service disposed')
      for (const w of entry.waiters.splice(0)) w.reject(err)
      this._logger.info(`[acpTerminal] dispose killed id=${id}`)
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
    for (const w of entry.waiters.splice(0)) w.resolve(info)
  }
}
