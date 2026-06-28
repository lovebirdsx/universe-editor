/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Window-scoped pool of node-pty processes backing the integrated terminal.
 *
 *  Unlike AcpTerminalMainService (agent-facing, child_process.spawn + polling, no
 *  real PTY) this owns real pseudoterminals and pushes every output chunk live to
 *  the renderer through the `onData` Emitter, keyed by terminalId so one IPC
 *  channel multiplexes all terminals in the window.
 *
 *  node-pty is loaded lazily via createRequire so unit tests can inject a fake
 *  spawner without dlopen'ing the native module.
 *
 *  Env sanitization mirrors AcpHostMainService / AcpTerminalMainService —
 *  ELECTRON_RUN_AS_NODE, NODE_OPTIONS, etc. are stripped before the spawn so a
 *  child cannot reinterpret an Electron helper or smuggle a --require payload.
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  type Event,
  type ILogChannel,
  type ILogger,
} from '@universe-editor/platform'
import type { IPty } from '@lydell/node-pty'
import { buildChildEnv } from '../process/env.js'
import type {
  ITerminalCreatedInfo,
  ITerminalDataEvent,
  ITerminalExitEvent,
  ITerminalService,
  ITerminalSpawnSpec,
  ITerminalTitleEvent,
} from '../../../shared/ipc/terminalService.js'

export type PtySpawner = (
  file: string,
  args: readonly string[],
  options: {
    name?: string
    cwd?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
  },
) => IPty

const requireFromHere = createRequire(import.meta.url)

const defaultSpawner: PtySpawner = (file, args, options) =>
  (requireFromHere('@lydell/node-pty') as typeof import('@lydell/node-pty')).spawn(
    file,
    [...args],
    options,
  )

/** Defense-in-depth env denylist lives in process/env.ts (shared with the ACP hosts). */

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['COMSPEC'] ?? 'cmd.exe'
  return process.env['SHELL'] ?? '/bin/bash'
}

function basename(p: string): string {
  const m = /[^\\/]+$/.exec(p)
  return m ? m[0] : p
}

function sanitizeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  // node-pty requires a string-valued env; buildChildEnv already drops undefined
  // and denylisted keys, so the cast is safe.
  return buildChildEnv(base, { overrides }) as Record<string, string>
}

interface TerminalEntry {
  readonly pty: IPty
  readonly info: ITerminalCreatedInfo
}

export class TerminalMainService extends Disposable implements ITerminalService {
  declare readonly _serviceBrand: undefined

  private readonly _entries = new Map<string, TerminalEntry>()
  private readonly _logger: ILogger

  private readonly _onData = this._register(new Emitter<ITerminalDataEvent>())
  readonly onData: Event<ITerminalDataEvent> = this._onData.event

  private readonly _onExit = this._register(new Emitter<ITerminalExitEvent>())
  readonly onExit: Event<ITerminalExitEvent> = this._onExit.event

  private readonly _onTitleChange = this._register(new Emitter<ITerminalTitleEvent>())
  readonly onTitleChange: Event<ITerminalTitleEvent> = this._onTitleChange.event

  constructor(
    private readonly _spawn: PtySpawner = defaultSpawner,
    loggerService?: { createLogger(channel: ILogChannel): ILogger },
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'terminal', name: 'Terminal' })
  }

  create(spec: ITerminalSpawnSpec): Promise<ITerminalCreatedInfo> {
    const shell = spec.shell && spec.shell.length > 0 ? spec.shell : defaultShell()
    const cols = spec.cols && spec.cols > 0 ? spec.cols : DEFAULT_COLS
    const rows = spec.rows && spec.rows > 0 ? spec.rows : DEFAULT_ROWS
    const env = sanitizeEnv(process.env, spec.env ?? {})
    const options: {
      name: string
      cwd?: string
      env: Record<string, string>
      cols: number
      rows: number
    } = {
      name: 'xterm-256color',
      env,
      cols,
      rows,
    }
    if (spec.cwd != null && spec.cwd.length > 0) options.cwd = spec.cwd

    let pty: IPty
    try {
      pty = this._spawn(shell, spec.args ?? [], options)
    } catch (err) {
      this._logger.warn(`spawn failed shell=${shell}: ${(err as Error).message}`)
      return Promise.reject(err as Error)
    }

    const id = randomUUID()
    const info: ITerminalCreatedInfo = {
      id,
      pid: pty.pid,
      shell,
      name: spec.name && spec.name.length > 0 ? spec.name : basename(shell),
    }
    this._entries.set(id, { pty, info })

    pty.onData((data) => this._onData.fire({ id, data }))
    pty.onExit(({ exitCode, signal }) => {
      this._logger.info(`exit id=${id} code=${exitCode} signal=${signal ?? ''}`)
      this._onExit.fire({ id, exitCode, ...(signal != null ? { signal } : {}) })
      this._entries.delete(id)
    })

    this._logger.info(`create id=${id} pid=${pty.pid} shell=${shell}`)
    return Promise.resolve(info)
  }

  input(id: string, data: string): Promise<void> {
    const entry = this._entries.get(id)
    if (!entry) return Promise.reject(new Error(`Terminal: unknown terminal ${id}`))
    entry.pty.write(data)
    return Promise.resolve()
  }

  resize(id: string, cols: number, rows: number): Promise<void> {
    const entry = this._entries.get(id)
    if (!entry) return Promise.reject(new Error(`Terminal: unknown terminal ${id}`))
    if (cols > 0 && rows > 0) {
      try {
        entry.pty.resize(cols, rows)
      } catch (err) {
        this._logger.warn(`resize failed id=${id}: ${(err as Error).message}`)
      }
    }
    return Promise.resolve()
  }

  kill(id: string): Promise<void> {
    const entry = this._entries.get(id)
    if (!entry) return Promise.resolve()
    try {
      entry.pty.kill()
    } catch (err) {
      this._logger.warn(`kill failed id=${id}: ${(err as Error).message}`)
    }
    return Promise.resolve()
  }

  list(): Promise<readonly ITerminalCreatedInfo[]> {
    return Promise.resolve([...this._entries.values()].map((e) => e.info))
  }

  release(id: string): Promise<void> {
    const entry = this._entries.get(id)
    if (!entry) return Promise.resolve()
    this._entries.delete(id)
    try {
      entry.pty.kill()
    } catch {
      // best-effort
    }
    this._logger.info(`release id=${id}`)
    return Promise.resolve()
  }

  override dispose(): void {
    for (const [id, entry] of this._entries) {
      try {
        entry.pty.kill()
      } catch {
        // ignore — shutting down
      }
      this._logger.info(`dispose killed id=${id}`)
    }
    this._entries.clear()
    super.dispose()
  }
}
