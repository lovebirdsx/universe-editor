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
  CodexCredentialDraft,
  CodexCredentialIntent,
  CodexCredentialProfile,
  CodexSettings,
  CodexSettingsPatch,
  ICodexConfigService,
} from '../../../shared/ipc/codexConfigService.js'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { readAiSettingsAgentState, updateAiSettingsAgentState } from '../ai/aiSettingsAgentState.js'

interface CodexAgentSettingsState {
  authentication?: {
    profiles?: CodexCredentialProfile[]
    draft?: CodexCredentialDraft
  }
}

/** Mirrors Codex's own resolution of `$CODEX_HOME` (defaults to `~/.codex`). */
function defaultConfigPath(): string {
  const dir = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
  return join(dir, 'config.toml')
}

/**
 * Provider id for the editor-managed gateway. Modelled as a *self-contained*
 * custom provider (key in `experimental_bearer_token`, `wire_api = "responses"`,
 * `supports_websockets = false` to stop codex 0.141+ probing
 * `wss://<gateway>/responses`). It deliberately avoids the reserved built-in
 * `openai` id, `requires_openai_auth`, and the global `openai_base_url` — all of
 * which would entangle it with the ChatGPT / official-key auth path. See
 * `applyCredential` / `reconcileGatewayProvider`.
 */
const GATEWAY_PROVIDER_ID = 'codex-gateway'

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
    private readonly _configLocation?: IConfigLocationService,
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

  async applyCredential(intent: CodexCredentialIntent): Promise<CodexAuthStatus> {
    // 1) auth.json: only the API key is editor-managed; ChatGPT tokens are owned
    //    by `codex login` and must survive a switch to gateway/apiKey unchanged.
    const auth = (await this._readAuth()) ?? {}
    if (intent.kind === 'apiKey') {
      auth['OPENAI_API_KEY'] = intent.apiKey.trim()
      auth['auth_mode'] = 'apikey'
    } else {
      // gateway carries its own key in config.toml; chatgpt uses the tokens.
      delete auth['OPENAI_API_KEY']
      if (this._hasChatgptTokens(auth)) auth['auth_mode'] = 'chatgpt'
      else delete auth['auth_mode']
    }
    await this._writeJsonAtomic(this._authPath(), auth)

    // 2) config.toml: the gateway is a fully self-contained provider — set it up
    //    only for gateway intent, tear it down for apiKey/chatgpt. Never touch
    //    the global `openai_base_url` (it would also redirect the built-in
    //    `openai` provider used by ChatGPT/official-key auth).
    const current = await this.read()
    const next = reconcileGatewayProvider(current, intent)
    if (next != null) await this._writeTomlAtomic(this._configPath, next)

    this._logger.info(
      `applied credential kind=${intent.kind} ` +
        `(model_provider=${(next ?? current)['model_provider'] ?? 'none'}, ` +
        `auth_mode=${auth['auth_mode'] ?? 'none'})`,
    )
    return this.readAuthStatus()
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

  async readProfiles(): Promise<CodexCredentialProfile[]> {
    if (this._configLocation) {
      const state = await readAiSettingsAgentState<CodexAgentSettingsState>(
        this._configLocation,
        'codex',
      )
      const profiles = state?.authentication?.profiles
      if (Array.isArray(profiles)) return profiles
      const legacyProfiles = await this._readLegacyProfiles()
      if (legacyProfiles.length > 0) await this.writeProfiles(legacyProfiles)
      return legacyProfiles
    }
    return this._readLegacyProfiles()
  }

  async writeProfiles(profiles: CodexCredentialProfile[]): Promise<void> {
    if (this._configLocation) {
      await updateAiSettingsAgentState<CodexAgentSettingsState>(
        this._configLocation,
        'codex',
        (current) => ({
          ...current,
          authentication: { ...current?.authentication, profiles },
        }),
      )
      this._logger.info(`wrote ${profiles.length} Codex credential profile(s) to aiSettings.json`)
      return
    }
    const path = this._profilesPath()
    await this._writeJsonAtomic(path, { profiles })
    this._logger.info(`wrote ${profiles.length} credential profile(s) to ${path}`)
  }

  async readCredentialDraft(): Promise<CodexCredentialDraft | undefined> {
    if (!this._configLocation) return undefined
    const state = await readAiSettingsAgentState<CodexAgentSettingsState>(
      this._configLocation,
      'codex',
    )
    return state?.authentication?.draft
  }

  async writeCredentialDraft(draft: CodexCredentialDraft | undefined): Promise<void> {
    if (!this._configLocation) return
    await updateAiSettingsAgentState<CodexAgentSettingsState>(
      this._configLocation,
      'codex',
      (current) => {
        const authentication = { ...current?.authentication }
        if (draft === undefined) delete authentication.draft
        else authentication.draft = draft
        return { ...current, authentication }
      },
    )
  }

  private async _readLegacyProfiles(): Promise<CodexCredentialProfile[]> {
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

/**
 * Reconcile the `codex-gateway` provider in config.toml with the chosen
 * credential. Returns the next settings to write, or `null` when nothing needs
 * to change. Idempotent; preserves every unmanaged key (e.g. a hand-written
 * `[model_providers.kuro]`).
 *
 * The gateway is modelled as a *self-contained* custom provider, exactly like a
 * hand-written one: its key rides in `experimental_bearer_token`, it sets
 * `supports_websockets = false` (so codex 0.141+ stops probing
 * `wss://<gateway>/responses`), and `model_provider` points at it. Crucially it
 * does NOT use `requires_openai_auth` and does NOT set the global
 * `openai_base_url` — both would entangle it with the built-in `openai` provider
 * that ChatGPT / official-key auth rely on.
 *
 * - gateway intent: write/update the provider + pointer.
 * - apiKey / chatgpt intent: tear the provider + pointer down so codex uses the
 *   built-in `openai` provider. Also clears any stale top-level `openai_base_url`
 *   the previous implementation may have left behind.
 */
function reconcileGatewayProvider(
  current: CodexSettings,
  intent: CodexCredentialIntent,
): CodexSettings | null {
  const providers =
    current['model_providers'] && typeof current['model_providers'] === 'object'
      ? (current['model_providers'] as Record<string, unknown>)
      : {}
  const existing =
    providers[GATEWAY_PROVIDER_ID] && typeof providers[GATEWAY_PROVIDER_ID] === 'object'
      ? (providers[GATEWAY_PROVIDER_ID] as Record<string, unknown>)
      : undefined
  const hasStaleBaseUrl = typeof current['openai_base_url'] === 'string'

  if (intent.kind !== 'gateway') {
    // Tear down: remove our provider + pointer + any stale global base URL.
    const dirty =
      existing != null || current['model_provider'] === GATEWAY_PROVIDER_ID || hasStaleBaseUrl
    if (!dirty) return null
    const nextProviders = { ...providers }
    delete nextProviders[GATEWAY_PROVIDER_ID]
    const out: CodexSettings = { ...current }
    if (Object.keys(nextProviders).length > 0) out['model_providers'] = nextProviders
    else delete out['model_providers']
    if (out['model_provider'] === GATEWAY_PROVIDER_ID) delete out['model_provider']
    delete out['openai_base_url']
    return out
  }

  const desired = {
    name: intent.providerName?.trim() || 'Gateway',
    base_url: intent.baseUrl,
    wire_api: 'responses',
    supports_websockets: false,
    experimental_bearer_token: intent.apiKey,
  }
  const inSync =
    current['model_provider'] === GATEWAY_PROVIDER_ID &&
    !hasStaleBaseUrl &&
    existing != null &&
    existing['base_url'] === desired.base_url &&
    existing['wire_api'] === desired.wire_api &&
    existing['supports_websockets'] === false &&
    existing['experimental_bearer_token'] === desired.experimental_bearer_token &&
    existing['name'] === desired.name

  if (inSync) return null

  const out: CodexSettings = { ...current }
  out['model_providers'] = { ...providers, [GATEWAY_PROVIDER_ID]: desired }
  out['model_provider'] = GATEWAY_PROVIDER_ID
  // The self-contained provider supersedes any global redirect.
  delete out['openai_base_url']
  return out
}
