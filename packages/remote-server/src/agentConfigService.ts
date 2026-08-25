/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteAgentConfigService — the server's AgentConfig channel surface. Implements
 *  the shared IRemoteAgentConfigService on top of the Electron-free Claude/Codex
 *  file stores, so the local editor's settings panels configure the remote host's
 *  `~/.claude` / `~/.codex` (never touching local credentials). The codex
 *  `auth.json`/`config.toml` watch and the claude `settings.json`/
 *  `.credentials.json` watch are re-surfaced as `onDidChangeCodexAuth` /
 *  `onDidChangeClaudeConfig` over the channel.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  type Event,
  type ILogChannel,
  type ILogger,
} from '@universe-editor/platform'
import {
  ClaudeConfigStore,
  CodexConfigStore,
  probeGatewayConnectivity,
  resolveCodexAuthMode,
  type IRemoteAgentConfigService,
} from '@universe-editor/node-services'
import type {
  ClaudeAuthStatus,
  ClaudeSettings,
  ClaudeSettingsPatch,
  CodexAuthStatus,
  CodexCredentialIntent,
  CodexSettings,
  CodexSettingsPatch,
} from '@universe-editor/node-services'

export interface RemoteAgentConfigServiceOptions {
  readonly claudeConfigPath?: string
  readonly codexConfigPath?: string
}

export class RemoteAgentConfigService extends Disposable implements IRemoteAgentConfigService {
  declare readonly _serviceBrand: undefined

  private readonly _claude: ClaudeConfigStore
  private readonly _codex: CodexConfigStore
  private readonly _logger: { createLogger(channel: ILogChannel): ILogger } | undefined

  private readonly _onDidChangeCodexAuth = this._register(new Emitter<void>())
  readonly onDidChangeCodexAuth: Event<void> = this._onDidChangeCodexAuth.event

  private readonly _onDidChangeClaudeConfig = this._register(new Emitter<void>())
  readonly onDidChangeClaudeConfig: Event<void> = this._onDidChangeClaudeConfig.event

  constructor(
    logger?: { createLogger(channel: ILogChannel): ILogger },
    options: RemoteAgentConfigServiceOptions = {},
  ) {
    super()
    this._logger = logger
    this._claude = this._register(
      new ClaudeConfigStore({
        ...(options.claudeConfigPath !== undefined
          ? { settingsPath: options.claudeConfigPath }
          : {}),
        ...(logger !== undefined ? { logger } : {}),
      }),
    )
    this._codex = this._register(
      new CodexConfigStore({
        ...(options.codexConfigPath !== undefined ? { configPath: options.codexConfigPath } : {}),
        ...(logger !== undefined ? { logger } : {}),
      }),
    )
    this._register(this._codex.onDidChangeAuth(() => this._onDidChangeCodexAuth.fire()))
    this._register(this._claude.onDidChangeConfig(() => this._onDidChangeClaudeConfig.fire()))
  }

  /** Whether each store's watch is armed. For tests to await arming without sleeping. */
  get watchingClaude(): boolean {
    return this._claude.watching
  }
  get watchingCodex(): boolean {
    return this._codex.watching
  }

  claudeRead(): Promise<ClaudeSettings> {
    return this._claude.read()
  }
  claudePatch(patch: ClaudeSettingsPatch): Promise<void> {
    return this._claude.patch(patch)
  }
  claudeConfigPath(): Promise<string> {
    return this._claude.configPath()
  }
  claudeReadAuthStatus(): Promise<ClaudeAuthStatus> {
    return this._claude.readAuthStatus()
  }

  codexRead(): Promise<CodexSettings> {
    return this._codex.read()
  }
  codexPatch(patch: CodexSettingsPatch): Promise<void> {
    return this._codex.patch(patch)
  }
  codexApplyCredential(intent: CodexCredentialIntent): Promise<CodexAuthStatus> {
    return this._codex.applyCredential(intent)
  }
  codexConfigPath(): Promise<string> {
    return this._codex.configPath()
  }
  codexReadAuthStatus(): Promise<CodexAuthStatus> {
    return this._codex.readAuthStatus()
  }

  checkGatewayConnectivity(baseUrl: string): Promise<boolean> {
    return probeGatewayConnectivity(baseUrl)
  }

  async codexMatchActiveApiKey(candidates: readonly string[]): Promise<number> {
    const auth = await this._codex.readAuthRaw()
    if (!auth || resolveCodexAuthMode(auth) !== 'apiKey') return -1
    const key = auth['OPENAI_API_KEY']
    return typeof key === 'string' ? candidates.indexOf(key) : -1
  }
}
