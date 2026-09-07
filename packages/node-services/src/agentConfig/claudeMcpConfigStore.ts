/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ClaudeMcpConfigStore — read-only access to the two user-level Claude config
 *  files that can declare MCP servers:
 *
 *    - `~/.claude.json`             — Claude Code CLI's primary config (what
 *                                     `claude mcp add` writes to). Top-level
 *                                     `mcpServers` record.
 *    - `~/.claude/settings.json`    — the newer split; can also carry
 *                                     `mcpServers`.
 *
 *  Both files are owned by the CLI / agent — the editor never writes them
 *  here. Reads tolerate missing or malformed files (return `{}`); a file
 *  watcher fires `onDidChange` so the renderer pool can refresh live.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  type Event,
  type ILogChannel,
  type ILogger,
} from '@universe-editor/platform'

/** Mirrors the CLI / vendor agent (`acp-agent.ts` CLAUDE_CONFIG_DIR). */
export function defaultClaudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
}

export function defaultClaudeJsonPath(): string {
  return join(homedir(), '.claude.json')
}

export interface ClaudeMcpConfigStoreOptions {
  readonly claudeJsonPath?: string
  readonly settingsPath?: string
  readonly logger?: { createLogger(channel: ILogChannel): ILogger }
}

/**
 * Read `mcpServers` from both Claude user-level files, merged (claude.json
 * wins on name conflict, since that is what `claude mcp add` writes to).
 */
export class ClaudeMcpConfigStore extends Disposable {
  private readonly _logger: ILogger
  private readonly _claudeJsonPath: string
  private readonly _settingsPath: string

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  private _watchers: FSWatcher[] = []
  private _debounce: ReturnType<typeof setTimeout> | undefined
  private _disposed = false

  constructor(options: ClaudeMcpConfigStoreOptions = {}) {
    super()
    this._claudeJsonPath = options.claudeJsonPath ?? defaultClaudeJsonPath()
    this._settingsPath = options.settingsPath ?? join(defaultClaudeConfigDir(), 'settings.json')
    this._logger = createNamedLogger(options.logger, {
      id: 'claudeMcpConfig',
      name: 'Claude MCP Config',
    })
    this._startWatch()
  }

  get watching(): boolean {
    return this._watchers.length > 0
  }

  private _startWatch(): void {
    const files = [this._claudeJsonPath, this._settingsPath]
    for (const file of files) {
      const dir = dirname(file)
      const name = file.slice(dir.length + 1)
      void fs
        .mkdir(dir, { recursive: true })
        .then(() => {
          if (this._disposed) return
          try {
            const watcher = watch(dir, (_event, filename) => {
              if (filename && filename.toString() !== name) return
              if (this._debounce) clearTimeout(this._debounce)
              this._debounce = setTimeout(() => {
                this._logger.info('claude MCP config changed; notifying')
                this._onDidChange.fire()
              }, 150)
            })
            watcher.on('error', (err) => this._logger.warn(`watcher error: ${err.message}`))
            this._watchers.push(watcher)
          } catch (err) {
            this._logger.warn(`watch failed: ${(err as Error).message}`)
          }
        })
        .catch((err: unknown) => {
          this._logger.warn(`watch mkdir failed: ${(err as Error).message}`)
        })
    }
  }

  override dispose(): void {
    this._disposed = true
    if (this._debounce) clearTimeout(this._debounce)
    for (const w of this._watchers) w.close()
    this._watchers = []
    super.dispose()
  }

  /** Merged `mcpServers` from both files (claude.json wins by name). */
  async readMcpServers(): Promise<Record<string, unknown>> {
    const [fromClaudeJson, fromSettings] = await Promise.all([
      this._readMcpServersFrom(this._claudeJsonPath),
      this._readMcpServersFrom(this._settingsPath),
    ])
    return { ...fromSettings, ...fromClaudeJson }
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
      const parsed = JSON.parse(raw) as unknown
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const inner = (parsed as Record<string, unknown>)['mcpServers']
      if (inner == null || typeof inner !== 'object' || Array.isArray(inner)) return {}
      return inner as Record<string, unknown>
    } catch {
      this._logger.warn(`${path} is not valid JSON`)
      return {}
    }
  }
}
