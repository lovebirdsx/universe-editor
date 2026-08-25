/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ClaudeConfigStore — the Electron-free file store behind the shared Claude
 *  config (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`),
 *  shared by the local editor main and the remote server daemon. The built-in
 *  agent (vendor fork) and the local Claude CLI both read this same file, so the
 *  editor edits it in place — preserving any key it doesn't manage — rather than
 *  keeping a separate store.
 *
 *  Writes are atomic (temp file + rename) so the agent's / CLI's `fs.watch`
 *  never observes a half-written file. Every read tolerates a missing or
 *  malformed file by returning empty rather than throwing.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  type Event,
  type ILogChannel,
  type ILogger,
} from '@universe-editor/platform'
import type { ClaudeAuthStatus, ClaudeSettings, ClaudeSettingsPatch } from './types.js'
import { writeFileAtomic } from './atomicFile.js'

/** Mirrors the vendor agent's resolution (`acp-agent.ts` CLAUDE_CONFIG_DIR). */
export function defaultClaudeSettingsPath(): string {
  const dir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
  return join(dir, 'settings.json')
}

export interface ClaudeConfigStoreOptions {
  readonly settingsPath?: string
  readonly logger?: { createLogger(channel: ILogChannel): ILogger }
}

export class ClaudeConfigStore extends Disposable {
  private readonly _logger: ILogger
  private readonly _settingsPath: string

  private readonly _onDidChangeConfig = this._register(new Emitter<void>())
  readonly onDidChangeConfig: Event<void> = this._onDidChangeConfig.event

  private _configWatcher: FSWatcher | undefined
  private _configDebounce: ReturnType<typeof setTimeout> | undefined
  private _disposed = false

  constructor(options: ClaudeConfigStoreOptions = {}) {
    super()
    this._settingsPath = options.settingsPath ?? defaultClaudeSettingsPath()
    this._logger = createNamedLogger(options.logger, { id: 'claudeConfig', name: 'Claude Config' })
    this._startConfigWatch()
  }

  /** Whether the directory watch is attached. For tests to await arming without sleeping. */
  get watching(): boolean {
    return this._configWatcher !== undefined
  }

  /**
   * Watch the directory holding settings.json and .credentials.json (dir-level
   * because the CLI writes atomically via temp file + rename, which a file-level
   * watch would miss). Debounced so a rename's create/delete pair fires once,
   * and filtered to the two files — `~/.claude` also holds high-churn state.
   */
  private _startConfigWatch(): void {
    const dir = dirname(this._settingsPath)
    const watchedFiles = new Set([basename(this._settingsPath), '.credentials.json'])
    void fs.mkdir(dir, { recursive: true }).then(
      () => {
        // dispose() can land while the mkdir is in flight; attaching then would
        // leak a watcher nothing closes.
        if (this._disposed) return
        try {
          this._configWatcher = watch(dir, (_event, filename) => {
            if (filename && !watchedFiles.has(basename(filename.toString()))) return
            if (this._configDebounce) clearTimeout(this._configDebounce)
            this._configDebounce = setTimeout(() => {
              this._logger.info('claude config changed; notifying')
              this._onDidChangeConfig.fire()
            }, 150)
          })
          this._configWatcher.on('error', (err) =>
            this._logger.warn(`config watcher error: ${err.message}`),
          )
        } catch (err) {
          this._logger.warn(`config watch failed: ${(err as Error).message}`)
        }
      },
      (err) => this._logger.warn(`config watch mkdir failed: ${(err as Error).message}`),
    )
  }

  override dispose(): void {
    this._disposed = true
    if (this._configDebounce) clearTimeout(this._configDebounce)
    this._configWatcher?.close()
    this._configWatcher = undefined
    super.dispose()
  }

  async read(): Promise<ClaudeSettings> {
    let raw: string
    try {
      raw = await fs.readFile(this._settingsPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      this._logger.warn(`read failed: ${(err as Error).message}`)
      return {}
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as ClaudeSettings) : {}
    } catch {
      // A malformed file must not crash the panel. Surface empty; the next
      // patch() rewrites it from the current (empty) base.
      this._logger.warn(`settings.json is not valid JSON at ${this._settingsPath}`)
      return {}
    }
  }

  async patch(patch: ClaudeSettingsPatch): Promise<void> {
    const current = await this.read()
    const next = mergeClaudePatch(current, patch)
    await this._write(next)
    this._logger.info(`patched ${this._settingsPath}`)
  }

  configPath(): Promise<string> {
    return Promise.resolve(this._settingsPath)
  }

  async readAuthStatus(): Promise<ClaudeAuthStatus> {
    const path = join(dirname(this._settingsPath), '.credentials.json')
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this._logger.warn(`readAuthStatus failed: ${(err as Error).message}`)
      }
      return { loggedIn: false, expired: false }
    }
    try {
      const parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }
      const oauth = parsed.claudeAiOauth
      if (!oauth || typeof oauth['accessToken'] !== 'string' || oauth['accessToken'] === '') {
        return { loggedIn: false, expired: false }
      }
      const expiresAt = typeof oauth['expiresAt'] === 'number' ? oauth['expiresAt'] : undefined
      const subscriptionType =
        typeof oauth['subscriptionType'] === 'string' ? oauth['subscriptionType'] : undefined
      // A refresh token lets the SDK/CLI renew silently, so an access token past
      // its expiresAt is not truly expired while one is present.
      const refreshToken = typeof oauth['refreshToken'] === 'string' && oauth['refreshToken'] !== ''
      const accessExpired = expiresAt !== undefined && expiresAt <= Date.now()
      const expired = accessExpired && !refreshToken
      const status: ClaudeAuthStatus = { loggedIn: true, expired }
      if (subscriptionType !== undefined) status.subscriptionType = subscriptionType
      if (expiresAt !== undefined) status.expiresAt = expiresAt
      return status
    } catch {
      this._logger.warn(`.credentials.json is not valid JSON at ${path}`)
      return { loggedIn: false, expired: false }
    }
  }

  private _write(value: ClaudeSettings): Promise<void> {
    return writeFileAtomic(this._settingsPath, `${JSON.stringify(value, null, 2)}\n`)
  }
}

/**
 * Merge a patch into the current settings:
 *  - top-level keys are replaced; `null` deletes the key.
 *  - the `env` block is merged key-by-key; `null` deletes that env entry.
 * Every unmanaged key in `current` is preserved.
 */
export function mergeClaudePatch(
  current: ClaudeSettings,
  patch: ClaudeSettingsPatch,
): ClaudeSettings {
  const out: ClaudeSettings = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'env') continue
    if (value === null) delete out[key]
    else out[key] = value
  }
  if (patch.env) {
    const env: Record<string, string> = { ...(current.env ?? {}) }
    for (const [k, v] of Object.entries(patch.env)) {
      if (v === null) delete env[k]
      else env[k] = v
    }
    if (Object.keys(env).length > 0) out.env = env
    else delete out.env
  }
  return out
}
