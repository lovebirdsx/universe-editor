/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent settings commands: open MCP / agent settings.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
  IEditorResolverService,
  IEditorService,
  IStorageService,
  MenuId,
  StorageScope,
  URI,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IClaudeConfigService } from '../../shared/ipc/claudeConfigService.js'
import { ICodexConfigService } from '../../shared/ipc/codexConfigService.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { AiSettingsEditorInput } from '../services/editor/AiSettingsEditorInput.js'
import { CATEGORY } from './_agentShared.js'

export class OpenAcpMcpSettingsAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openMcpSettings'
  constructor() {
    super({
      id: OpenAcpMcpSettingsAction.ID,
      title: localize2('action.agent.openMcpSettings', 'Open MCP Settings'),
      category: CATEGORY,
      icon: 'settings-gear',
      menu: [
        {
          id: MenuId.ViewTitle,
          when: 'view == workbench.view.agents.mcp',
          group: 'navigation',
          order: 1,
        },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // Settings UI can't deep-link to a single key yet; opening the editor lands
    // the user on the searchable settings list where `acp.mcpServers` lives.
    await accessor.get(ICommandService).executeCommand('workbench.action.openSettings')
  }
}

export class OpenAgentSettingsAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openSettings'
  constructor() {
    super({
      id: OpenAgentSettingsAction.ID,
      title: localize2('action.agent.openSettings', 'Open Agent Settings'),
      category: CATEGORY,
      icon: 'settings-gear',
    })
  }
  override async run(accessor: ServicesAccessor, agentId?: unknown): Promise<void> {
    // Agent settings now live inside the unified settings editor under the
    // "Agents" group. Land the user there by pre-selecting an agent: callers may
    // request a specific one (e.g. the auth-failure toast targets the failing
    // session's agent); otherwise fall back to the default.
    const registry = accessor.get(IAcpAgentRegistry)
    const storage = accessor.get(IStorageService)
    const target =
      typeof agentId === 'string' && registry.allAgentIds().includes(agentId)
        ? agentId
        : registry.defaultAgentId()
    await storage.set('settings.activeItem', `agent:${target}`, StorageScope.GLOBAL)
    await accessor.get(IEditorService).openEditor(new AiSettingsEditorInput(), { activate: true })
  }
}

export class OpenCodexConfigAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openCodexConfig'

  constructor() {
    super({
      id: OpenCodexConfigAction.ID,
      title: localize2('action.agent.openCodexConfig', 'Open Codex Configuration (TOML)'),
      category: CATEGORY,
      icon: 'settings-gear',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const configService = accessor.get(ICodexConfigService)
    const editorResolver = accessor.get(IEditorResolverService)
    const path = await configService.configPath()
    await editorResolver.openEditor(URI.file(path), { pinned: true })
  }
}

export class OpenClaudeConfigAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openClaudeConfig'

  constructor() {
    super({
      id: OpenClaudeConfigAction.ID,
      title: localize2('action.agent.openClaudeConfig', 'Open Claude Configuration (JSON)'),
      category: CATEGORY,
      icon: 'settings-gear',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const configService = accessor.get(IClaudeConfigService)
    const editorResolver = accessor.get(IEditorResolverService)
    const path = await configService.configPath()
    await editorResolver.openEditor(URI.file(path), { pinned: true })
  }
}
