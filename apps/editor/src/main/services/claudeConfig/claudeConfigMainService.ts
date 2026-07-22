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
  ClaudeCredentialDraft,
  ClaudeCredentialProfile,
  ClaudeSettings,
  ClaudeSettingsPatch,
  IClaudeConfigService,
} from '../../../shared/ipc/claudeConfigService.js'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { readAiSettingsAgentState, updateAiSettingsAgentState } from '../ai/aiSettingsAgentState.js'

interface ClaudeAgentSettingsState {
  authentication?: {
    profiles?: ClaudeCredentialProfile[]
    draft?: ClaudeCredentialDraft
  }
}

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
    private readonly _configLocation?: IConfigLocationService,
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
      // A refresh token lets the SDK/CLI renew silently, so an access token past
      // its expiresAt is not truly expired while one is present (mirrors the
      // Codex auth status logic). Only report expired when there is no way to
      // renew. `claude auth status` confirms such sessions as still logged in.
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

  async readProfiles(): Promise<ClaudeCredentialProfile[]> {
    if (this._configLocation) {
      const state = await readAiSettingsAgentState<ClaudeAgentSettingsState>(
        this._configLocation,
        'claude',
      )
      const profiles = state?.authentication?.profiles
      if (Array.isArray(profiles)) return profiles
      const legacyProfiles = await this._readLegacyProfiles()
      if (legacyProfiles.length > 0) await this.writeProfiles(legacyProfiles)
      return legacyProfiles
    }
    return this._readLegacyProfiles()
  }

  async writeProfiles(profiles: ClaudeCredentialProfile[]): Promise<void> {
    if (this._configLocation) {
      await updateAiSettingsAgentState<ClaudeAgentSettingsState>(
        this._configLocation,
        'claude',
        (current) => ({
          ...current,
          authentication: { ...current?.authentication, profiles },
        }),
      )
      this._logger.info(`wrote ${profiles.length} Claude credential profile(s) to aiSettings.json`)
      return
    }
    const path = this._profilesPath()
    await this._writeAtomicTo(path, { profiles })
    this._logger.info(`wrote ${profiles.length} credential profile(s) to ${path}`)
  }

  async readCredentialDraft(): Promise<ClaudeCredentialDraft | undefined> {
    if (!this._configLocation) return undefined
    const state = await readAiSettingsAgentState<ClaudeAgentSettingsState>(
      this._configLocation,
      'claude',
    )
    return state?.authentication?.draft
  }

  async writeCredentialDraft(draft: ClaudeCredentialDraft | undefined): Promise<void> {
    if (!this._configLocation) return
    await updateAiSettingsAgentState<ClaudeAgentSettingsState>(
      this._configLocation,
      'claude',
      (current) => {
        const authentication = { ...current?.authentication }
        if (draft === undefined) delete authentication.draft
        else authentication.draft = draft
        return { ...current, authentication }
      },
    )
  }

  private async _readLegacyProfiles(): Promise<ClaudeCredentialProfile[]> {
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
