/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteAgentConfigService — the server's AgentConfig channel surface. Implements
 *  the shared IRemoteAgentConfigService on top of the Electron-free Claude/Codex
 *  file stores, so the local editor's settings panels configure the remote host's
 *  `~/.claude` / `~/.codex` (never touching local credentials). The codex
 *  `auth.json` watch is re-surfaced as `onDidChangeCodexAuth` over the channel.
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

  private readonly _onDidChangeCodexAuth = this._register(new Emitter<void>())
  readonly onDidChangeCodexAuth: Event<void> = this._onDidChangeCodexAuth.event

  constructor(
    logger?: { createLogger(channel: ILogChannel): ILogger },
    options: RemoteAgentConfigServiceOptions = {},
  ) {
    super()
    this._claude = new ClaudeConfigStore({
      ...(options.claudeConfigPath !== undefined ? { settingsPath: options.claudeConfigPath } : {}),
      ...(logger !== undefined ? { logger } : {}),
    })
    this._codex = this._register(
      new CodexConfigStore({
        ...(options.codexConfigPath !== undefined ? { configPath: options.codexConfigPath } : {}),
        ...(logger !== undefined ? { logger } : {}),
      }),
    )
    this._register(this._codex.onDidChangeAuth(() => this._onDidChangeCodexAuth.fire()))
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
}
