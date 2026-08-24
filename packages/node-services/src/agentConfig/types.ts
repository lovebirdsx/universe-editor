/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared file-store data shapes for the Claude / Codex agent config. These are
 *  the on-disk surfaces (`~/.claude/settings.json`, `~/.codex/config.toml` +
 *  `auth.json`) the editor edits in place; the local main process and a remote
 *  server daemon both operate on them, so the types live here in node-services.
 *
 *  Only auth *status* ever crosses a process boundary — never the tokens / keys.
 *--------------------------------------------------------------------------------------------*/

/** Effort levels supported by the Claude Agent SDK (`Settings.effortLevel`). */
export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh'

/**
 * Login status derived from `~/.claude/.credentials.json` (the OAuth credentials
 * the Claude CLI / agent write after `claude auth login`). Only the *status* is
 * surfaced — the access/refresh tokens never cross a process boundary.
 */
export interface ClaudeAuthStatus {
  /** A `claudeAiOauth` block with an access token exists in the credentials file. */
  loggedIn: boolean
  /** `loggedIn` but `expiresAt` is in the past (a re-login is needed). */
  expired: boolean
  /** e.g. `'pro'` / `'max'`, when reported by the OAuth payload. */
  subscriptionType?: string
  /** Epoch ms the access token expires at, when present. */
  expiresAt?: number
}

/**
 * The subset of `~/.claude/settings.json` the editor surfaces in its UI. The
 * SDK is tolerant of unknown keys, and `patch` preserves any field not listed
 * here, so this stays a curated view — not the full schema.
 */
export interface ClaudeSettings {
  // -- top-level model / thinking preferences --
  model?: string
  language?: string
  alwaysThinkingEnabled?: boolean
  effortLevel?: ClaudeEffortLevel
  showThinkingSummaries?: boolean
  availableModels?: string[]
  // -- environment block (auth + runtime toggles) --
  env?: Record<string, string>
  // -- preserve anything else already in the file --
  [key: string]: unknown
}

/**
 * A patch to merge into the file. Top-level keys are replaced; the `env` block
 * is merged key-by-key. Setting any value (top-level or inside `env`) to `null`
 * deletes that key — the only way to remove e.g. a stale `ANTHROPIC_API_KEY`.
 */
export type ClaudeSettingsPatch = {
  env?: Record<string, string | null>
} & {
  [key: string]: unknown
}

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
 * credentials. Only *status* crosses a process boundary — the tokens and the API
 * key value never do.
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
 * unknown keys and `patch` preserves any field not listed here.
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
 * The credential the user wants Codex to use next, applied atomically by the
 * main process / remote server. Mirrors how Codex separates the three login
 * modes (gateway / apiKey / chatgpt).
 */
export type CodexCredentialIntent =
  | { kind: 'gateway'; baseUrl: string; apiKey: string; providerName?: string }
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'chatgpt' }
