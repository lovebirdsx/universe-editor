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
 *  Remote (streamable-http) entries use Codex's own shape (`url` /
 *  `http_headers` / `bearer_token_env_var`, no `type` field) and are
 *  translated into the editor shape on read — see translateCodexMcpServers.
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

/**
 * Translate codex-native `[mcp_servers]` entries into the editor's internal
 * shape on read:
 *  - stdio entries (`command` / `args` / `env`) pass through untouched;
 *  - http entries (`url` / `http_headers` / `env_http_headers` /
 *    `bearer_token_env_var`, no `type` field) become
 *    `{ type: 'http', url, headers }`. Headers merge in this order, later
 *    sources win on name clashes: the editor-style `headers` field, the
 *    static `http_headers`, then `env_http_headers` (value names an env var
 *    to read; unset vars skip). `bearer_token_env_var` is resolved against
 *    `env` as `Authorization: Bearer <token>` unless a static Authorization
 *    header (any casing) already exists.
 *  - entries already carrying a `type` field pass through untouched.
 *
 * `env` must be the environment of the host that will actually run the agent —
 * the local main reads its own env, the remote server its own (each side owns
 * its store instance); never cache it here. Resolved secrets ride the read
 * result across IPC into the renderer pool, same as settings-layer and claude
 * config headers already do; the MCP UI never renders header values.
 *
 * Codex-only fields are dropped on purpose: `enabled` (the pool has its own
 * enablement mechanism), `oauth_*` (no wire channel), `http_headers_helper`
 * (a local-only shell command — reads must not execute commands).
 * Unrecognizable entries pass through so the downstream `buildServer` keeps
 * its existing skip-with-warning behavior.
 */
export function translateCodexMcpServers(
  servers: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(servers)) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      out[name] = entry
      continue
    }
    const o = entry as Record<string, unknown>
    if ('type' in o) {
      out[name] = entry
      continue
    }
    if (typeof o.command === 'string' && o.command) {
      out[name] = entry
      continue
    }
    if (typeof o.url === 'string' && o.url) {
      const headers: Record<string, string> = {}
      for (const src of [o.headers, o.http_headers]) {
        if (src != null && typeof src === 'object' && !Array.isArray(src)) {
          for (const [key, value] of Object.entries(src as Record<string, unknown>)) {
            if (typeof value === 'string') headers[key] = value
          }
        }
      }
      const envHeaders = o.env_http_headers
      if (envHeaders != null && typeof envHeaders === 'object' && !Array.isArray(envHeaders)) {
        for (const [key, value] of Object.entries(envHeaders as Record<string, unknown>)) {
          if (typeof value !== 'string') continue
          const resolved = env[value]
          if (typeof resolved === 'string' && resolved) headers[key] = resolved
        }
      }
      const bearerEnv = o.bearer_token_env_var
      if (typeof bearerEnv === 'string' && bearerEnv) {
        const token = env[bearerEnv]
        const hasStaticAuth = Object.keys(headers).some((key) => /^authorization$/i.test(key))
        if (typeof token === 'string' && token && !hasStaticAuth) {
          headers['Authorization'] = `Bearer ${token}`
        }
      }
      out[name] = { type: 'http', url: o.url, headers }
      continue
    }
    out[name] = entry
  }
  return out
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
      return translateCodexMcpServers(inner as Record<string, unknown>)
    } catch {
      this._logger.warn(`${path} is not valid TOML`)
      return {}
    }
  }
}
