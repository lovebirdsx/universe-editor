/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexMcpConfigStore — read-only access to the Codex MCP server definitions,
 *  which live under the `[mcp_servers]` table in `config.toml`:
 *
 *    - user-level:    `~/.codex/config.toml`
 *    - project-level: `<cwd>/.codex/config.toml` (when a workspace folder is
 *                     provided)
 *
 *  Codex's TOML shape per server is a single table:
 *    [mcp_servers.fs]
 *    command = "npx"
 *    args    = ["-y", "@modelcontextprotocol/server-filesystem", "."]
 *    env     = { FOO = "bar" }
 *
 *  Remote (http-like) MCP servers are not currently part of Codex's on-disk
 *  schema — anything without a `command` is surfaced as-is and normalized
 *  downstream.
 *
 *  The editor never writes these files from this store; reads tolerate
 *  missing/malformed files (return `{}`); a watcher fires `onDidChange` so
 *  the renderer pool can refresh live.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseToml } from 'smol-toml'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  type Event,
  type ILogChannel,
  type ILogger,
} from '@universe-editor/platform'

/** Mirrors Codex's own resolution of `$CODEX_HOME` (defaults to `~/.codex`). */
export function defaultCodexHome(): string {
  return process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
}

export function defaultCodexMcpUserConfigPath(): string {
  return join(defaultCodexHome(), 'config.toml')
}

/** Project-level Codex config is `<cwd>/.codex/config.toml`. */
export function codexMcpProjectConfigPath(cwd: string): string {
  return join(cwd, '.codex', 'config.toml')
}

export interface CodexMcpConfigStoreOptions {
  readonly userConfigPath?: string
  readonly logger?: { createLogger(channel: ILogChannel): ILogger }
}

/**
 * Reads Codex MCP servers from the user-level file; project-level reads are
 * separate (`readProjectMcpServers`) because the workspace folder is a
 * renderer-side concept the store does not own.
 */
export class CodexMcpConfigStore extends Disposable {
  private readonly _logger: ILogger
  private readonly _userConfigPath: string

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  private _watcher: FSWatcher | undefined
  private _debounce: ReturnType<typeof setTimeout> | undefined
  private _disposed = false

  constructor(options: CodexMcpConfigStoreOptions = {}) {
    super()
    this._userConfigPath = options.userConfigPath ?? defaultCodexMcpUserConfigPath()
    this._logger = createNamedLogger(options.logger, {
      id: 'codexMcpConfig',
      name: 'Codex MCP Config',
    })
    this._startWatch()
  }

  get watching(): boolean {
    return this._watcher !== undefined
  }

  private _startWatch(): void {
    const dir = dirname(this._userConfigPath)
    const name = this._userConfigPath.slice(dir.length + 1)
    void fs
      .mkdir(dir, { recursive: true })
      .then(() => {
        if (this._disposed) return
        try {
          this._watcher = watch(dir, (_event, filename) => {
            if (filename && filename.toString() !== name) return
            if (this._debounce) clearTimeout(this._debounce)
            this._debounce = setTimeout(() => {
              this._logger.info('codex MCP config changed; notifying')
              this._onDidChange.fire()
            }, 150)
          })
          this._watcher.on('error', (err) => this._logger.warn(`watcher error: ${err.message}`))
        } catch (err) {
          this._logger.warn(`watch failed: ${(err as Error).message}`)
        }
      })
      .catch((err: unknown) => {
        this._logger.warn(`watch mkdir failed: ${(err as Error).message}`)
      })
  }

  override dispose(): void {
    this._disposed = true
    if (this._debounce) clearTimeout(this._debounce)
    this._watcher?.close()
    this._watcher = undefined
    super.dispose()
  }

  /** User-level `[mcp_servers]` from `~/.codex/config.toml`. */
  readUserMcpServers(): Promise<Record<string, unknown>> {
    return this._readMcpServersFrom(this._userConfigPath)
  }

  /**
   * Project-level `[mcp_servers]` from `<cwd>/.codex/config.toml`. Static so
   * the renderer-side service can call it for the active workspace folder
   * without the store owning cwd state.
   */
  async readProjectMcpServers(cwd: string): Promise<Record<string, unknown>> {
    return this._readMcpServersFrom(codexMcpProjectConfigPath(cwd))
  }

  private async _readMcpServersFrom(path: string): Promise<Record<string, unknown>> {
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this._logger.warn(`read ${path} failed: ${(err as Error).message}`)
      }
      return {}
    }
    try {
      const parsed = parseToml(raw) as unknown
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const inner = (parsed as Record<string, unknown>)['mcp_servers']
      if (inner == null || typeof inner !== 'object' || Array.isArray(inner)) return {}
      return inner as Record<string, unknown>
    } catch {
      this._logger.warn(`${path} is not valid TOML`)
      return {}
    }
  }
}
