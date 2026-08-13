/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for reading/writing the shared Claude config file
 *  (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`). The
 *  built-in agent and the local Claude CLI both read this same file, so the
 *  editor and the CLI stay in lock-step on auth + model preferences.
 *
 *  The file-store data shapes (ClaudeSettings / ClaudeSettingsPatch /
 *  ClaudeAuthStatus / ClaudeEffortLevel) live in @universe-editor/node-services
 *  so the local main and a remote server operate on the same types; this module
 *  re-exports them for renderer/main import stability and adds the editor-local
 *  credential library + service contract.
 *
 *  Only the main process (or the remote server) touches the user's home
 *  directory; the renderer drives the visual settings panel entirely through
 *  this proxy. An optional `authority` selects the remote host for a remote
 *  workspace — absent it reads/writes the local host, exactly as before.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

export type {
  ClaudeAuthStatus,
  ClaudeEffortLevel,
  ClaudeSettings,
  ClaudeSettingsPatch,
} from '@universe-editor/node-services'
import type {
  ClaudeAuthStatus,
  ClaudeSettings,
  ClaudeSettingsPatch,
} from '@universe-editor/node-services'

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
  /**
   * Read the merged settings file. Returns `{}` when the file is absent.
   * `authority` selects a remote host; absent → the local host.
   */
  read(authority?: string): Promise<ClaudeSettings>
  /**
   * Deep-merge `patch` into the on-disk file and write it back atomically,
   * preserving every key the editor does not manage. `null` values delete.
   * `authority` selects a remote host; absent → the local host.
   */
  patch(patch: ClaudeSettingsPatch, authority?: string): Promise<void>
  /**
   * Absolute path of the settings file (for display / "reveal in folder").
   * `authority` selects a remote host; absent → the local host.
   */
  configPath(authority?: string): Promise<string>
  /**
   * Read login status from the sibling `.credentials.json`. Returns
   * `{ loggedIn: false, expired: false }` when the file is absent or malformed.
   * Never returns the tokens themselves. `authority` selects a remote host.
   */
  readAuthStatus(authority?: string): Promise<ClaudeAuthStatus>
  /**
   * Read the editor's saved credential library from aiSettings.json. Returns `[]`
   * when absent or malformed. This library is separate from `settings.json` and
   * is always editor-local (never routed).
   */
  readProfiles(): Promise<ClaudeCredentialProfile[]>
  /** Replace the saved credential library in aiSettings.json (atomic merge). */
  writeProfiles(profiles: ClaudeCredentialProfile[]): Promise<void>
  /**
   * Probe a gateway `baseUrl` over HTTP. Resolves `true` when the server answers
   * with any status (a 401/404 still proves reachability); `false` on network
   * errors / timeouts / malformed URLs. Powers the status dot in the UI.
   */
  checkGatewayConnectivity(baseUrl: string): Promise<boolean>
}

export const IClaudeConfigService = createDecorator<IClaudeConfigService>('claudeConfigService')
