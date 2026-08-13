/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexConfigStore — the Electron-free file store behind the shared Codex
 *  config the Codex CLI and the built-in codex-acp agent both consult, under
 *  `$CODEX_HOME` (defaults to `~/.codex`):
 *
 *    - `config.toml`  — parsed/serialized with smol-toml; edited in place so any
 *                       key the editor does not manage is preserved.
 *    - `auth.json`    — JSON credentials from `codex login` (a ChatGPT token
 *                       block) or an `OPENAI_API_KEY`; only status is surfaced.
 *
 *  Shared by the local editor main and the remote server daemon. Writes are
 *  atomic (temp file + rename) so the CLI's / agent's reads never observe a
 *  half-written file. Every read tolerates a missing or malformed file by
 *  returning empty rather than throwing.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  type Event,
  type ILogChannel,
  type ILogger,
} from '@universe-editor/platform'
import type {
  CodexAuthStatus,
  CodexCredentialIntent,
  CodexSettings,
  CodexSettingsPatch,
} from './types.js'
import { writeFileAtomic } from './atomicFile.js'

/** Mirrors Codex's own resolution of `$CODEX_HOME` (defaults to `~/.codex`). */
export function defaultCodexConfigPath(): string {
  const dir = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
  return join(dir, 'config.toml')
}

/**
 * Provider id for the editor-managed gateway. Modelled as a *self-contained*
 * custom provider (key in `experimental_bearer_token`, `wire_api = "responses"`,
 * `supports_websockets = false` to stop codex 0.141+ probing
 * `wss://<gateway>/responses`). See `applyCredential` / `reconcileGatewayProvider`.
 */
export const GATEWAY_PROVIDER_ID = 'codex-gateway'

/** Decode a JWT payload (base64url) without verifying the signature. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
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

export interface CodexConfigStoreOptions {
  readonly configPath?: string
  readonly logger?: { createLogger(channel: ILogChannel): ILogger }
}

export class CodexConfigStore extends Disposable {
  private readonly _logger: ILogger
  private readonly _configPath: string

  private readonly _onDidChangeAuth = this._register(new Emitter<void>())
  readonly onDidChangeAuth: Event<void> = this._onDidChangeAuth.event

  private _authWatcher: FSWatcher | undefined
  private _authDebounce: ReturnType<typeof setTimeout> | undefined

  constructor(options: CodexConfigStoreOptions = {}) {
    super()
    this._configPath = options.configPath ?? defaultCodexConfigPath()
    this._logger = createNamedLogger(options.logger, { id: 'codexConfig', name: 'Codex Config' })
    this._startAuthWatch()
  }

  /**
   * Watch the directory that holds auth.json (watching the dir survives the
   * temp-file + rename codex login uses to write atomically). Debounced so a
   * rename's create/delete pair fires once.
   */
  private _startAuthWatch(): void {
    const dir = dirname(this._authPath())
    const authFile = basename(this._authPath())
    try {
      void fs.mkdir(dir, { recursive: true }).then(
        () => {
          try {
            this._authWatcher = watch(dir, (_event, filename) => {
              if (filename && basename(filename.toString()) !== authFile) return
              if (this._authDebounce) clearTimeout(this._authDebounce)
              this._authDebounce = setTimeout(() => {
                this._logger.info('auth.json changed; notifying')
                this._onDidChangeAuth.fire()
              }, 150)
            })
            this._authWatcher.on('error', (err) =>
              this._logger.warn(`auth watcher error: ${err.message}`),
            )
          } catch (err) {
            this._logger.warn(`auth watch failed: ${(err as Error).message}`)
          }
        },
        (err) => this._logger.warn(`auth watch mkdir failed: ${(err as Error).message}`),
      )
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
    const next = mergeCodexPatch(current, patch)
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
      if (hasCodexChatgptTokens(auth)) auth['auth_mode'] = 'chatgpt'
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

    // Report both dimensions independently: which credential codex would use,
    // plus whether a ChatGPT login / API key exist at all.
    const active = resolveCodexAuthMode(auth)
    const hasApiKey =
      typeof auth['OPENAI_API_KEY'] === 'string' && (auth['OPENAI_API_KEY'] as string) !== ''
    const status: CodexAuthStatus = { active, hasApiKey }
    if (hasCodexChatgptTokens(auth)) {
      status.chatgpt = this._chatgptInfo(auth)
    }
    this._logger.info(
      `auth status: active=${active} hasApiKey=${hasApiKey} chatgptExpired=${status.chatgpt?.expired ?? 'n/a'}`,
    )
    return status
  }

  /**
   * Raw auth.json contents (secrets included). Main-process-only — the caller
   * (profile matching) needs the actual token/key to compare against saved
   * profiles, and must never forward this across an IPC boundary.
   */
  async readAuthRaw(): Promise<Record<string, unknown> | undefined> {
    return this._readAuth()
  }

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

  private async _writeTomlAtomic(path: string, value: CodexSettings): Promise<void> {
    await writeFileAtomic(path, stringifyToml(value as Record<string, unknown>))
  }

  private async _writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
  }
}

/**
 * Merge a patch into the current settings: top-level keys are replaced; `null`
 * deletes the key. Every unmanaged key in `current` is preserved. (config.toml
 * is flat for the keys we manage, so there is no nested env-style merge.)
 */
export function mergeCodexPatch(current: CodexSettings, patch: CodexSettingsPatch): CodexSettings {
  const out: CodexSettings = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = value
  }
  return out
}

/**
 * Which credential codex would actually use, mirroring `resolved_mode()` in
 * codex-rs: explicit `auth_mode` first, then OPENAI_API_KEY *before* a ChatGPT
 * token block, then chatgpt tokens.
 */
export function resolveCodexAuthMode(auth: Record<string, unknown>): 'apiKey' | 'chatgpt' | 'none' {
  const declared = auth['auth_mode']
  if (declared === 'apikey') return 'apiKey'
  if (declared === 'chatgpt' || declared === 'chatgptAuthTokens') return 'chatgpt'
  if (typeof auth['OPENAI_API_KEY'] === 'string' && auth['OPENAI_API_KEY'] !== '') return 'apiKey'
  if (hasCodexChatgptTokens(auth)) return 'chatgpt'
  return 'none'
}

export function hasCodexChatgptTokens(auth: Record<string, unknown>): boolean {
  const tokens = auth['tokens']
  if (!tokens || typeof tokens !== 'object') return false
  const access = (tokens as Record<string, unknown>)['access_token']
  return typeof access === 'string' && access !== ''
}

/**
 * Reconcile the `codex-gateway` provider in config.toml with the chosen
 * credential. Returns the next settings to write, or `null` when nothing needs
 * to change. Idempotent; preserves every unmanaged key (e.g. a hand-written
 * `[model_providers.kuro]`).
 *
 * - gateway intent: write/update the provider + pointer.
 * - apiKey / chatgpt intent: tear the provider + pointer down so codex uses the
 *   built-in `openai` provider. Also clears any stale top-level `openai_base_url`
 *   the previous implementation may have left behind.
 */
export function reconcileGatewayProvider(
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
