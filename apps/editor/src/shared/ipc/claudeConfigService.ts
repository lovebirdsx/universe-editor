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
 *  re-exports them for renderer/main import stability and adds the service
 *  contract.
 *
 *  Only the main process (or the remote server) touches the user's home
 *  directory; the renderer drives the visual settings panel entirely through
 *  this proxy. An optional `authority` selects the remote host for a remote
 *  workspace — absent it reads/writes the local host, exactly as before.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'
import type { AgentActiveAuth } from '../ai/agentActiveAuth.js'

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
 * The UI value meaning "use this agent's official subscription login" — Claude
 * OAuth (`claude auth login`) / Codex ChatGPT login (`codex login`) — instead of a
 * configured provider entry. It is a menu value only: nothing persists it, since
 * the agent's own config files say which credential is live.
 */
export const AGENT_SUBSCRIPTION_AUTH = '@subscription'

export interface IClaudeConfigService {
  readonly _serviceBrand: undefined
  /**
   * Fires when `settings.json` or `.credentials.json` changes on disk (the CLI's
   * `claude auth login`, another window, or a hand edit) — on either the local
   * host or any remote authority. Lets the panel and the cost attribution refresh
   * live instead of trusting a stale snapshot.
   */
  readonly onDidChangeConfig: Event<void>
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
   * Which credential is actually in effect on the effective host — reverse-looked
   * up from that host's `settings.json` / `.credentials.json` against the
   * configured provider entries. Computed in the main process so the comparison
   * can see the gateway token. `authority` selects a remote host; absent → local.
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

export const IClaudeConfigService = createDecorator<IClaudeConfigService>('claudeConfigService')
