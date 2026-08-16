/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote agent-config channel surface. The local main process proxies this over
 *  the Management connection's `agentConfig` channel when the active workspace is
 *  remote; the remote server implements it with the shared Claude/Codex file
 *  stores so the settings panels configure the remote host's `~/.claude` /
 *  `~/.codex` — never touching local credentials.
 *
 *  Only auth *status* crosses the wire (via `readAuthStatus`); the `applyCredential`
 *  intent carries the API key the user typed into the remote host, which is the
 *  one place a secret legitimately travels (user-initiated, host-local write).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '@universe-editor/platform'
import type {
  ClaudeAuthStatus,
  ClaudeSettings,
  ClaudeSettingsPatch,
  CodexAuthStatus,
  CodexCredentialIntent,
  CodexSettings,
  CodexSettingsPatch,
  UsageResult,
} from './types.js'

export interface IRemoteAgentConfigService {
  readonly _serviceBrand: undefined

  /** Fires when the remote codex `auth.json` changes on disk. */
  readonly onDidChangeCodexAuth: Event<void>

  // -- Claude (`~/.claude/settings.json`) --
  claudeRead(): Promise<ClaudeSettings>
  claudePatch(patch: ClaudeSettingsPatch): Promise<void>
  claudeConfigPath(): Promise<string>
  claudeReadAuthStatus(): Promise<ClaudeAuthStatus>
  /**
   * Fetch today's Claude API usage from the remote host — reads the remote
   * `~/.claude/settings.json` and queries the provider from the remote network,
   * so a remote workspace reports the remote account's usage.
   */
  claudeFetchUsage(): Promise<UsageResult>

  // -- Codex (`~/.codex/config.toml` + `auth.json`) --
  codexRead(): Promise<CodexSettings>
  codexPatch(patch: CodexSettingsPatch): Promise<void>
  codexApplyCredential(intent: CodexCredentialIntent): Promise<CodexAuthStatus>
  codexConfigPath(): Promise<string>
  codexReadAuthStatus(): Promise<CodexAuthStatus>

  /**
   * Probe `baseUrl` over HTTP from the remote host. Same semantics as the local
   * probe (any HTTP status proves reachability); remote-side probing matters for
   * gateways only reachable from the remote network.
   */
  checkGatewayConnectivity(baseUrl: string): Promise<boolean>

  /**
   * Match the remote host's active codex API key against `candidates`, returning
   * the matching index or -1. Narrow by design: the editor sends its saved
   * candidate keys (same client→server direction as `applyCredential`) and only
   * an index travels back — the remote auth.json secrets never cross the wire.
   * -1 when auth.json is absent or resolves to a non-apiKey mode.
   */
  codexMatchActiveApiKey(candidates: readonly string[]): Promise<number>
}
