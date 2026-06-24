/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reads/writes the shared Claude config file (`~/.claude/settings.json`, or
 *  `$CLAUDE_CONFIG_DIR/settings.json`). The built-in agent (vendor fork) and the
 *  local Claude CLI both read this same file, so the editor edits it in place —
 *  preserving any key it doesn't manage — rather than keeping a separate store.
 *
 *  Writes are atomic (temp file + rename) so the agent's / CLI's `fs.watch` never
 *  observes a half-written file.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import {
  Disposable,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type {
  ClaudeAuthStatus,
  ClaudeCredentialProfile,
  ClaudeSettings,
  ClaudeSettingsPatch,
  IClaudeConfigService,
} from '../../../shared/ipc/claudeConfigService.js'

/** Mirrors the vendor agent's resolution (`acp-agent.ts` CLAUDE_CONFIG_DIR). */
function defaultSettingsPath(): string {
  const dir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
  return join(dir, 'settings.json')
}

export class ClaudeConfigMainService extends Disposable implements IClaudeConfigService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    private readonly _settingsPath: string = defaultSettingsPath(),
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'claudeConfig', name: 'Claude Config' })
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
      // patch() rewrites it from the current (empty) base, which is acceptable
      // since the file was already unreadable to the SDK too.
      this._logger.warn(`settings.json is not valid JSON at ${this._settingsPath}`)
      return {}
    }
  }

  async patch(patch: ClaudeSettingsPatch): Promise<void> {
    const current = await this.read()
    const next = mergePatch(current, patch)
    await this._writeAtomic(next)
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
      const expired = expiresAt !== undefined && expiresAt <= Date.now()
      const status: ClaudeAuthStatus = { loggedIn: true, expired }
      if (subscriptionType !== undefined) status.subscriptionType = subscriptionType
      if (expiresAt !== undefined) status.expiresAt = expiresAt
      return status
    } catch {
      this._logger.warn(`.credentials.json is not valid JSON at ${path}`)
      return { loggedIn: false, expired: false }
    }
  }

  async readProfiles(): Promise<ClaudeCredentialProfile[]> {
    const path = this._profilesPath()
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this._logger.warn(`readProfiles failed: ${(err as Error).message}`)
      }
      return []
    }
    try {
      const parsed = JSON.parse(raw) as { profiles?: unknown }
      return Array.isArray(parsed.profiles) ? (parsed.profiles as ClaudeCredentialProfile[]) : []
    } catch {
      this._logger.warn(`credential-profiles.json is not valid JSON at ${path}`)
      return []
    }
  }

  async writeProfiles(profiles: ClaudeCredentialProfile[]): Promise<void> {
    const path = this._profilesPath()
    await this._writeAtomicTo(path, { profiles })
    this._logger.info(`wrote ${profiles.length} credential profile(s) to ${path}`)
  }

  private _profilesPath(): string {
    return join(dirname(this._settingsPath), '.universe-editor', 'credential-profiles.json')
  }

  private _writeAtomic(value: ClaudeSettings): Promise<void> {
    return this._writeAtomicTo(this._settingsPath, value)
  }

  private async _writeAtomicTo(path: string, value: unknown): Promise<void> {
    const dir = dirname(path)
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    const text = `${JSON.stringify(value, null, 2)}\n`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, path)
  }
}

/**
 * Merge a patch into the current settings:
 *  - top-level keys are replaced; `null` deletes the key.
 *  - the `env` block is merged key-by-key; `null` deletes that env entry.
 * Every unmanaged key in `current` is preserved.
 */
function mergePatch(current: ClaudeSettings, patch: ClaudeSettingsPatch): ClaudeSettings {
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
