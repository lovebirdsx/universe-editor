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
 *  The file-store data shapes live in @universe-editor/node-services so the local
 *  main and a remote server operate on the same types; this module re-exports them
 *  and adds the editor-local agent settings + drift detection. Only auth *status*
 *  crosses a process boundary — never the tokens.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export type {
  CodexApprovalPolicy,
  CodexAuthStatus,
  CodexCredentialIntent,
  CodexCredentialStore,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSettings,
  CodexSettingsPatch,
} from '@universe-editor/node-services'
import type {
  CodexAuthStatus,
  CodexCredentialIntent,
  CodexSettings,
  CodexSettingsPatch,
} from '@universe-editor/node-services'
import { AGENT_SUBSCRIPTION_AUTH } from './claudeConfigService.js'

export { AGENT_SUBSCRIPTION_AUTH }

/**
 * Editor-local Codex agent state (`aiSettings.json` under `agentSettings.codex`).
 * `authentication` is a single provider id (a gateway), the
 * {@link AGENT_SUBSCRIPTION_AUTH} sentinel (ChatGPT login), or absent.
 */
export interface CodexAgentSettings {
  /** Gateway provider id, `@subscription`, or absent. */
  authentication?: string
  /** Bare model requested (written to config.toml `model` on apply). */
  model?: string
}

/**
 * What the effective host currently runs as codex auth, relative to the editor's
 * declared `authentication`. `drift` is true when the on-disk config.toml /
 * auth.json disagrees with the declared value (the user hand-edited them).
 */
export interface CodexActiveAuth {
  /** `subscription` = ChatGPT login in effect; `provider` = a gateway provider. */
  kind: 'subscription' | 'provider' | 'none'
  /** The provider id matching the on-disk gateway, when `kind === 'provider'`. */
  providerId?: string
  /** On-disk state disagrees with the editor's declared `authentication`. */
  drift: boolean
}

export interface ICodexConfigService {
  readonly _serviceBrand: undefined
  /**
   * Fires when `auth.json` changes on disk (e.g. after `codex login` writes its
   * token block, or another window edits credentials) — on either the local host
   * or any remote authority. Lets the panel refresh its login status live.
   */
  readonly onDidChangeAuth: Event<void>
  /**
   * Read the parsed config.toml. Returns `{}` when the file is absent.
   * `authority` selects a remote host; absent → the local host.
   */
  read(authority?: string): Promise<CodexSettings>
  /**
   * Merge `patch` into config.toml and write it back atomically, preserving
   * every key the editor does not manage. `null` values delete.
   * `authority` selects a remote host; absent → the local host.
   */
  patch(patch: CodexSettingsPatch, authority?: string): Promise<void>
  /**
   * Apply a credential atomically: rewrites `auth.json` and/or config.toml's
   * `[model_providers.codex-gateway]` + `model_provider` in one step so the three
   * login modes stay mutually consistent (see {@link CodexCredentialIntent}).
   * Returns the resulting auth status. `authority` selects a remote host.
   */
  applyCredential(intent: CodexCredentialIntent, authority?: string): Promise<CodexAuthStatus>
  /**
   * Absolute path of config.toml (for display / "reveal in folder").
   * `authority` selects a remote host; absent → the local host.
   */
  configPath(authority?: string): Promise<string>
  /**
   * Read login status from the sibling `auth.json`. Returns
   * `{ active: 'none', hasApiKey: false }` when the file is absent or malformed.
   * Never returns the credentials themselves. `authority` selects a remote host.
   */
  readAuthStatus(authority?: string): Promise<CodexAuthStatus>
  /** Read the editor's saved Codex agent state from aiSettings.json (always editor-local). */
  readAgentSettings(): Promise<CodexAgentSettings>
  /** Replace the saved Codex agent state in aiSettings.json (atomic merge; editor-local). */
  writeAgentSettings(settings: CodexAgentSettings): Promise<void>
  /**
   * Drift detection: which auth is currently in effect on the effective host
   * (the `authority` remote host, or local when absent) versus the editor's
   * declared `authentication`. `drift` is true when they disagree. Computed in
   * the main process so the comparison can see the gateway token.
   */
  resolveActiveAuth(authority?: string): Promise<CodexActiveAuth>
  /**
   * Probe a gateway `baseUrl` over HTTP. Resolves `true` when the server answers
   * with any status (a 401/404 still proves reachability); `false` on network
   * errors / timeouts / malformed URLs. Powers the status dot in the UI.
   * `authority` selects a remote host — the probe then runs from the remote
   * network (for gateways only reachable there); absent → the local host.
   */
  checkGatewayConnectivity(baseUrl: string, authority?: string): Promise<boolean>
}

export const ICodexConfigService = createDecorator<ICodexConfigService>('codexConfigService')
