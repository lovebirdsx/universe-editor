/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for reading/writing the shared Codex config the local Codex CLI
 *  and the built-in codex-acp agent both consult. Codex spreads its state across
 *  two files under `$CODEX_HOME` (defaults to `~/.codex`):
 *
 *    - `config.toml`  — model / reasoning / approval / sandbox / provider settings
 *    - `auth.json`    — credentials written by `codex login` (a ChatGPT OAuth token
 *                       block) or an `OPENAI_API_KEY` for API-key auth
 *
 *  Only the main process touches the user's home directory; the renderer drives
 *  the visual settings panel entirely through this proxy. As with the Claude
 *  contract, only auth *status* crosses the boundary — never the tokens.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

/** Reasoning effort levels Codex accepts (`model_reasoning_effort`). */
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Command-approval policies (`approval_policy`). Granular form is left to the raw editor. */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'on-failure' | 'never'

/** Filesystem/network sandbox policies (`sandbox_mode`). */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Where the CLI keeps credentials (`cli_auth_credentials_store`). */
export type CodexCredentialStore = 'file' | 'keyring' | 'auto'

/**
 * Login status derived from `~/.codex/auth.json`. Unlike a single "method", this
 * exposes two independent dimensions — mirroring how Codex actually stores
 * credentials: a ChatGPT token block and an `OPENAI_API_KEY` can coexist in the
 * same file, and an `auth_mode` field decides which one is *used*. Reporting both
 * lets the panel keep showing "Signed in" even while an API key takes precedence
 * (so switching to an API key no longer looks like a logout). Only *status*
 * crosses the boundary — the access / refresh tokens and the API key value never
 * do.
 */
export interface CodexAuthStatus {
  /** Which credential Codex would actually use (its `resolved_mode`). */
  active: 'apiKey' | 'chatgpt' | 'none'
  /** Present whenever a ChatGPT token block exists, regardless of `active`. */
  chatgpt?: {
    /** The ChatGPT token's expiry (id-token `exp`) is in the past. */
    expired: boolean
    /** ChatGPT plan, e.g. `'plus'` / `'pro'`, when reported by the id token. */
    planType?: string
    /** Epoch ms the ChatGPT access token expires at, when derivable. */
    expiresAt?: number
  }
  /** An `OPENAI_API_KEY` exists in auth.json, regardless of `active`. */
  hasApiKey: boolean
}

/**
 * The subset of `~/.codex/config.toml` the editor surfaces. Codex tolerates
 * unknown keys and `patch` preserves any field not listed here, so this stays a
 * curated view — not the full schema. Gateway credentials are modelled as a
 * self-contained `[model_providers.codex-gateway]` (see {@link CodexCredentialIntent}),
 * NOT via the global `openai_base_url` (which would also redirect the built-in
 * `openai` provider used by ChatGPT / official-key auth).
 */
export interface CodexSettings {
  model?: string
  model_provider?: string
  model_providers?: Record<string, unknown>
  model_reasoning_effort?: CodexReasoningEffort
  approval_policy?: CodexApprovalPolicy
  sandbox_mode?: CodexSandboxMode
  openai_base_url?: string
  cli_auth_credentials_store?: CodexCredentialStore
  hide_agent_reasoning?: boolean
  // -- preserve anything else already in the file --
  [key: string]: unknown
}

/**
 * A patch to merge into config.toml. Top-level keys are replaced; setting any
 * value to `null` deletes that key — the only way to remove e.g. a stale
 * `openai_base_url`.
 */
export type CodexSettingsPatch = {
  [key: string]: unknown
}

/**
 * A saved credential profile in the editor's own library
 * (`<codexHome>/.universe-editor/credential-profiles.json`). The user *applies* a
 * profile to make it the active credential via `applyCredential`: an API-key
 * profile writes `OPENAI_API_KEY` into `auth.json`; a gateway profile writes a
 * self-contained `[model_providers.codex-gateway]` into `config.toml`.
 *
 * ChatGPT login (OAuth) is deliberately not a profile — it is a single shared
 * login managed by `codex login`.
 */
export type CodexCredentialKind = 'apiKey' | 'gateway'

export interface CodexCredentialProfile {
  id: string
  label: string
  kind: CodexCredentialKind
  /** Present for both kinds — the OpenAI (or compatible) API key. */
  apiKey?: string
  /** Present when `kind === 'gateway'` — the compatible endpoint base URL. */
  baseUrl?: string
}

/**
 * The credential the user wants Codex to use next, applied atomically by the
 * main process. This mirrors how Codex actually separates the three login modes:
 *
 *  - `gateway`  — a *self-contained* custom provider (like a hand-written
 *    `[model_providers.X]`): the key lives in the provider's
 *    `experimental_bearer_token`, `model_provider` points at it, and **neither
 *    `auth.json` nor the global `openai_base_url` is touched**. A ChatGPT login
 *    stays intact (and unused) alongside it.
 *  - `apiKey`   — the official OpenAI API key in `auth.json` (built-in `openai`
 *    provider). Any gateway provider/pointer is torn down.
 *  - `chatgpt`  — hand control back to the ChatGPT OAuth tokens: clear the API
 *    key and any gateway provider/pointer so the built-in `openai` provider runs
 *    on the login tokens.
 */
export type CodexCredentialIntent =
  | { kind: 'gateway'; baseUrl: string; apiKey: string; providerName?: string }
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'chatgpt' }

export interface ICodexConfigService {
  readonly _serviceBrand: undefined
  /**
   * Fires when `auth.json` changes on disk (e.g. after `codex login` writes its
   * token block, or another window edits credentials). Lets the panel refresh
   * its login status live instead of polling.
   */
  readonly onDidChangeAuth: Event<void>
  /** Read the parsed config.toml. Returns `{}` when the file is absent. */
  read(): Promise<CodexSettings>
  /**
   * Merge `patch` into config.toml and write it back atomically, preserving
   * every key the editor does not manage. `null` values delete.
   */
  patch(patch: CodexSettingsPatch): Promise<void>
  /**
   * Apply a credential atomically: rewrites `auth.json` and/or config.toml's
   * `[model_providers.codex-gateway]` + `model_provider` in one main-process step
   * so the three login modes stay mutually consistent (see {@link CodexCredentialIntent}).
   * Returns the resulting auth status. Call this for every credential switch
   * instead of poking `setApiKey` / providers individually.
   */
  applyCredential(intent: CodexCredentialIntent): Promise<CodexAuthStatus>
  /** Absolute path of config.toml (for display / "reveal in folder"). */
  configPath(): Promise<string>
  /**
   * Read login status from the sibling `auth.json`. Returns
   * `{ active: 'none', hasApiKey: false }` when the file is absent or malformed.
   * Never returns the credentials themselves.
   */
  readAuthStatus(): Promise<CodexAuthStatus>
  /**
   * Read the editor's saved credential library. Returns `[]` when the file is
   * absent or malformed. This library is separate from auth.json / config.toml.
   */
  readProfiles(): Promise<CodexCredentialProfile[]>
  /** Replace the saved credential library on disk (atomic write). */
  writeProfiles(profiles: CodexCredentialProfile[]): Promise<void>
}

export const ICodexConfigService = createDecorator<ICodexConfigService>('codexConfigService')
