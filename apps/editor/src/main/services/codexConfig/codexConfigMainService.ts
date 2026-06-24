/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reads/writes the shared Codex config the local Codex CLI and the built-in
 *  codex-acp agent both consult, under `$CODEX_HOME` (defaults to `~/.codex`):
 *
 *    - `config.toml`  — parsed/serialized with smol-toml; edited in place so any
 *                       key the editor does not manage is preserved.
 *    - `auth.json`    — JSON credentials from `codex login` (a ChatGPT token
 *                       block) or an `OPENAI_API_KEY`; only status is surfaced.
 *
 *  Writes are atomic (temp file + rename) so the CLI's / agent's reads never
 *  observe a half-written file. Every read tolerates a missing or malformed file
 *  by returning empty rather than throwing — a broken config must not crash the
 *  settings panel.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  Disposable,
  Emitter,
  type Event,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type {
  CodexAuthStatus,
  CodexCredentialProfile,
  CodexSettings,
  CodexSettingsPatch,
  ICodexConfigService,
} from '../../../shared/ipc/codexConfigService.js'

/** Mirrors Codex's own resolution of `$CODEX_HOME` (defaults to `~/.codex`). */
function defaultConfigPath(): string {
  const dir = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
  return join(dir, 'config.toml')
}

/** Decode a JWT payload (base64url) without verifying the signature. */
function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.')
  if (parts.length < 2 || !parts[1]) return undefined
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export class CodexConfigMainService extends Disposable implements ICodexConfigService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  private readonly _onDidChangeAuth = this._register(new Emitter<void>())
  readonly onDidChangeAuth: Event<void> = this._onDidChangeAuth.event

  private _authWatcher: FSWatcher | undefined
  private _authDebounce: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly _configPath: string = defaultConfigPath(),
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'codexConfig', name: 'Codex Config' })
    this._startAuthWatch()
  }

  /**
   * Watch the directory that holds auth.json (watching the dir survives the
   * temp-file + rename codex login uses to write atomically, which a file watch
   * would miss). Debounced so a rename's create/delete pair fires once.
   */
  private _startAuthWatch(): void {
    const dir = dirname(this._authPath())
    const authFile = basename(this._authPath())
    try {
      // Ensure the dir exists so watch() doesn't throw on a fresh install.
      void fs.mkdir(dir, { recursive: true }).then(() => {
        try {
          this._authWatcher = watch(dir, (_event, filename) => {
            if (filename && basename(filename.toString()) !== authFile) return
            if (this._authDebounce) clearTimeout(this._authDebounce)
            this._authDebounce = setTimeout(() => {
              this._logger.info('auth.json changed; notifying renderer')
              this._onDidChangeAuth.fire()
            }, 150)
          })
        } catch (err) {
          this._logger.warn(`auth watch failed: ${(err as Error).message}`)
        }
      })
    } catch (err) {
      this._logger.warn(`auth watch setup failed: ${(err as Error).message}`)
    }
  }

  override dispose(): void {
    if (this._authDebounce) clearTimeout(this._authDebounce)
    this._authWatcher?.close()
    super.dispose()
  }

  async read(): Promise<CodexSettings> {
    let raw: string
    try {
      raw = await fs.readFile(this._configPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      this._logger.warn(`read failed: ${(err as Error).message}`)
      return {}
    }
    try {
      const parsed = parseToml(raw) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as CodexSettings) : {}
    } catch {
      // A malformed file must not crash the panel. Surface empty; the next
      // patch() rewrites it from the current (empty) base.
      this._logger.warn(`config.toml is not valid TOML at ${this._configPath}`)
      return {}
    }
  }

  async patch(patch: CodexSettingsPatch): Promise<void> {
    const current = await this.read()
    const next = mergePatch(current, patch)
    await this._writeTomlAtomic(this._configPath, next)
    this._logger.info(`patched ${this._configPath}`)
  }

  configPath(): Promise<string> {
    return Promise.resolve(this._configPath)
  }

  async readAuthStatus(): Promise<CodexAuthStatus> {
    const auth = await this._readAuth()
    if (!auth) return { active: 'none', hasApiKey: false }

    // Report both dimensions independently: which credential codex would use
    // (its `resolved_mode`), plus whether a ChatGPT login / API key exist at
    // all. This keeps "Signed in" visible even while an API key takes
    // precedence, so switching to an API key does not look like a logout.
    const active = this._resolveAuthMode(auth)
    const hasApiKey =
      typeof auth['OPENAI_API_KEY'] === 'string' && (auth['OPENAI_API_KEY'] as string) !== ''
    const status: CodexAuthStatus = { active, hasApiKey }
    if (this._hasChatgptTokens(auth)) {
      status.chatgpt = this._chatgptInfo(auth)
    }
    this._logger.info(
      `auth status: active=${active} hasApiKey=${hasApiKey} chatgptExpired=${status.chatgpt?.expired ?? 'n/a'}`,
    )
    return status
  }

  async setApiKey(apiKey: string | null): Promise<void> {
    const auth = (await this._readAuth()) ?? {}
    const key = apiKey?.trim()
    if (key) {
      auth['OPENAI_API_KEY'] = key
      // Pin the mode so codex uses this key even if a ChatGPT token block is
      // still present (its `resolved_mode` checks `auth_mode` first).
      auth['auth_mode'] = 'apikey'
    } else {
      delete auth['OPENAI_API_KEY']
      // Hand control back to a ChatGPT login when its tokens remain; otherwise
      // there is no active credential, so drop the mode entirely.
      if (this._hasChatgptTokens(auth)) auth['auth_mode'] = 'chatgpt'
      else delete auth['auth_mode']
    }
    await this._writeJsonAtomic(this._authPath(), auth)
    this._logger.info(
      `updated OPENAI_API_KEY in ${this._authPath()} (mode=${auth['auth_mode'] ?? 'none'})`,
    )
  }

  async readProfiles(): Promise<CodexCredentialProfile[]> {
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
      return Array.isArray(parsed.profiles) ? (parsed.profiles as CodexCredentialProfile[]) : []
    } catch {
      this._logger.warn(`credential-profiles.json is not valid JSON at ${path}`)
      return []
    }
  }

  async writeProfiles(profiles: CodexCredentialProfile[]): Promise<void> {
    const path = this._profilesPath()
    await this._writeJsonAtomic(path, { profiles })
    this._logger.info(`wrote ${profiles.length} credential profile(s) to ${path}`)
  }

  /**
   * Which credential codex would actually use, mirroring `resolved_mode()` in
   * codex-rs (login/src/auth/manager.rs): explicit `auth_mode` first, then
   * OPENAI_API_KEY *before* a ChatGPT token block, then chatgpt tokens.
   */
  private _resolveAuthMode(auth: Record<string, unknown>): 'apiKey' | 'chatgpt' | 'none' {
    const declared = auth['auth_mode']
    if (declared === 'apikey') return 'apiKey'
    if (declared === 'chatgpt' || declared === 'chatgptAuthTokens') return 'chatgpt'
    // `personalAccessToken` / `bedrockApiKey` / `agentIdentity` are not surfaced
    // by this panel; fall through to the field-presence heuristic codex uses.
    if (typeof auth['OPENAI_API_KEY'] === 'string' && auth['OPENAI_API_KEY'] !== '') return 'apiKey'
    if (this._hasChatgptTokens(auth)) return 'chatgpt'
    return 'none'
  }

  private _hasChatgptTokens(auth: Record<string, unknown>): boolean {
    const tokens = auth['tokens']
    if (!tokens || typeof tokens !== 'object') return false
    const access = (tokens as Record<string, unknown>)['access_token']
    return typeof access === 'string' && access !== ''
  }

  private _token(
    auth: Record<string, unknown>,
    name: 'id_token' | 'access_token',
  ): string | undefined {
    const tokens = auth['tokens']
    if (!tokens || typeof tokens !== 'object') return undefined
    const value = (tokens as Record<string, unknown>)[name]
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  private _refreshToken(auth: Record<string, unknown>): string | undefined {
    const tokens = auth['tokens']
    if (!tokens || typeof tokens !== 'object') return undefined
    const value = (tokens as Record<string, unknown>)['refresh_token']
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  /**
   * ChatGPT login status. Expiry mirrors codex-rs: the session stays usable as
   * long as the *access* token is unexpired, and even an expired access token is
   * transparently refreshed when a refresh token is present — so we only report
   * `expired` when the access token is past its `exp` AND no refresh token can
   * renew it. The short-lived `id_token` (≈1h) is identity-only and used solely
   * to read the plan type; judging expiry by it falsely flags a live session.
   */
  private _chatgptInfo(auth: Record<string, unknown>): NonNullable<CodexAuthStatus['chatgpt']> {
    const info: NonNullable<CodexAuthStatus['chatgpt']> = { expired: false }

    const accessExp = this._tokenExpiry(this._token(auth, 'access_token'))
    if (accessExp !== undefined) {
      info.expiresAt = accessExp
      // A refresh token lets codex renew silently, so it is never "expired" then.
      info.expired = accessExp <= Date.now() && !this._refreshToken(auth)
    }

    const claims = decodeJwtPayload(this._token(auth, 'id_token') ?? '')
    if (claims) {
      const auth0 = claims['https://api.openai.com/auth']
      if (auth0 && typeof auth0 === 'object') {
        const plan = (auth0 as Record<string, unknown>)['chatgpt_plan_type']
        if (typeof plan === 'string' && plan !== '') info.planType = plan
      }
    }
    return info
  }

  /** Epoch ms of a JWT's `exp` claim, or undefined when not derivable. */
  private _tokenExpiry(jwt: string | undefined): number | undefined {
    if (!jwt) return undefined
    const claims = decodeJwtPayload(jwt)
    const exp = claims?.['exp']
    return typeof exp === 'number' ? exp * 1000 : undefined
  }

  private async _readAuth(): Promise<Record<string, unknown> | undefined> {
    const path = this._authPath()
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this._logger.warn(`readAuth failed: ${(err as Error).message}`)
      }
      return undefined
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      this._logger.warn(`auth.json is not valid JSON at ${path}`)
      return undefined
    }
  }

  private _authPath(): string {
    return join(dirname(this._configPath), 'auth.json')
  }

  private _profilesPath(): string {
    return join(dirname(this._configPath), '.universe-editor', 'credential-profiles.json')
  }

  private async _writeTomlAtomic(path: string, value: CodexSettings): Promise<void> {
    await this._writeAtomic(path, stringifyToml(value as Record<string, unknown>))
  }

  private async _writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await this._writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
  }

  private async _writeAtomic(path: string, text: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, path)
  }
}

/**
 * Merge a patch into the current settings: top-level keys are replaced; `null`
 * deletes the key. Every unmanaged key in `current` is preserved. (config.toml
 * is flat for the keys we manage, so there is no nested env-style merge.)
 */
function mergePatch(current: CodexSettings, patch: CodexSettingsPatch): CodexSettings {
  const out: CodexSettings = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = value
  }
  return out
}
