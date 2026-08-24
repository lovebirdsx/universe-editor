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
 *  agent settings (which provider / model the editor applies) + service contract.
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
 * The special `authentication` value meaning "use this agent's official
 * subscription login" — Claude OAuth (`claude auth login`) / Codex ChatGPT
 * login (`codex login`) — instead of a configured provider entry.
 */
export const AGENT_SUBSCRIPTION_AUTH = '@subscription'

/**
 * Editor-local Claude agent state (`aiSettings.json` under `agentSettings.claude`).
 * `authentication` is a single provider id, the {@link AGENT_SUBSCRIPTION_AUTH}
 * sentinel, or absent. `model` / `subagentModel` are the user's model picks,
 * normally bare — an id whose own name carries `[1m]` is stored verbatim and
 * hides the toggle. Each is paired with a `1m` toggle, and only the composed
 * value (`settings.model` / `env.CLAUDE_CODE_SUBAGENT_MODEL`) is written into
 * `settings.json` on apply. The CLI/agent never read this block — it is the
 * editor's own menu.
 */
export interface ClaudeAgentSettings {
  /** Provider id serving `anthropic-messages`, `@subscription`, or absent. */
  authentication?: string
  /** Bare model requested from the provider (written to `settings.model` on apply). */
  model?: string
  /** Append `[1m]` to `model` when composing `settings.model`. */
  model1m?: boolean
  /** Bare sub-agent model (`env.CLAUDE_CODE_SUBAGENT_MODEL` on apply). */
  subagentModel?: string
  /** Append `[1m]` to `subagentModel` when composing the env value. */
  subagentModel1m?: boolean
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
  /** Read the editor's saved Claude agent state from aiSettings.json (always editor-local). */
  readAgentSettings(): Promise<ClaudeAgentSettings>
  /** Replace the saved Claude agent state in aiSettings.json (atomic merge; editor-local). */
  writeAgentSettings(settings: ClaudeAgentSettings): Promise<void>
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
