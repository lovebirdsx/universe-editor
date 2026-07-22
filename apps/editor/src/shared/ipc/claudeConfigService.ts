/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for reading/writing the shared Claude config file
 *  (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`). The
 *  built-in agent and the local Claude CLI both read this same file, so the
 *  editor and the CLI stay in lock-step on auth + model preferences.
 *
 *  Only the main process touches the user's home directory; the renderer drives
 *  the visual settings panel entirely through this proxy.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

/** Effort levels supported by the Claude Agent SDK (`Settings.effortLevel`). */
export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh'

/**
 * Login status derived from `~/.claude/.credentials.json` (the OAuth credentials
 * the Claude CLI / agent write after `claude auth login`). Only the *status* is
 * surfaced — the access/refresh tokens never cross the IPC boundary.
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
 *
 * `env` carries the auth credentials + a couple of runtime toggles. Everything
 * else is a top-level Claude Code setting.
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

/**
 * A saved credential profile in the editor's own library
 * (`aiSettings.json` under `agentSettings.claude`). This library
 * is the editor's "menu" of credentials; it is NOT read by the CLI/agent. The
 * user *applies* a profile to make it the active one in `settings.json`, which
 * is the file the CLI/agent actually read.
 *
 * `login` (OAuth) is deliberately not a profile — it is a single shared login.
 * Profiles only cover the two env-based credential shapes.
 */
export type ClaudeCredentialKind = 'apiKey' | 'gateway'

export interface ClaudeCredentialProfile {
  id: string
  label: string
  kind: ClaudeCredentialKind
  /** Present when `kind === 'apiKey'`. */
  apiKey?: string
  /** Present when `kind === 'gateway'`. */
  authToken?: string
  /** Present when `kind === 'gateway'`. */
  baseUrl?: string
  /**
   * Optional model preset bundled with a `gateway` profile. A custom gateway
   * (Kimi's Anthropic-compatible endpoint, a LiteLLM proxy fronting GPT, …)
   * serves a different model catalog than Anthropic, so the model to request is
   * really part of the credential. When set, applying the profile also writes
   * `settings.model`; clearing it leaves the current model untouched.
   */
  model?: string
  /** Optional fast/background model for a `gateway` profile (`ANTHROPIC_SMALL_FAST_MODEL`). */
  smallFastModel?: string
}

/**
 * An unfinished credential form, retained when the settings page is left.
 * Persisted by the renderer in IStorageService (UI state, not configuration).
 */
export interface ClaudeCredentialDraft {
  editingProfileId?: string
  kind: ClaudeCredentialKind
  label: string
  apiKey: string
  authToken: string
  baseUrl: string
  model: string
  smallFastModel: string
}

export interface IClaudeConfigService {
  readonly _serviceBrand: undefined
  /** Read the merged settings file. Returns `{}` when the file is absent. */
  read(): Promise<ClaudeSettings>
  /**
   * Deep-merge `patch` into the on-disk file and write it back atomically,
   * preserving every key the editor does not manage. `null` values delete.
   */
  patch(patch: ClaudeSettingsPatch): Promise<void>
  /** Absolute path of the settings file (for display / "reveal in folder"). */
  configPath(): Promise<string>
  /**
   * Read login status from the sibling `.credentials.json`. Returns
   * `{ loggedIn: false, expired: false }` when the file is absent or malformed.
   * Never returns the tokens themselves.
   */
  readAuthStatus(): Promise<ClaudeAuthStatus>
  /**
   * Read the editor's saved credential library from aiSettings.json. Returns `[]`
   * when absent or malformed. This library is separate from `settings.json`.
   */
  readProfiles(): Promise<ClaudeCredentialProfile[]>
  /** Replace the saved credential library in aiSettings.json (atomic merge). */
  writeProfiles(profiles: ClaudeCredentialProfile[]): Promise<void>
}

export const IClaudeConfigService = createDecorator<IClaudeConfigService>('claudeConfigService')
