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
 *  and adds the service contract. Only auth *status* crosses a process boundary —
 *  never the tokens.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'
import type { AgentActiveAuth } from '../ai/agentActiveAuth.js'

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

export interface ICodexConfigService {
  readonly _serviceBrand: undefined
  /**
   * Fires when `auth.json` or `config.toml` changes on disk (e.g. after
   * `codex login` writes its token block, or another window edits credentials) —
   * on either the local host or any remote authority. Lets the panel refresh its
   * login status live.
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
  /**
   * Which credential is actually in effect on the effective host — reverse-looked
   * up from that host's config.toml / auth.json against the configured provider
   * entries. Computed in the main process so the comparison can see the gateway
   * token. `authority` selects a remote host; absent → the local host.
   */
  resolveActiveAuth(authority?: string): Promise<AgentActiveAuth>
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
