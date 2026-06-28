/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent settings + chat font size commands: open MCP / agent settings, and the
 *  increase / decrease / reset chat font-size trio.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  ICommandService,
  IConfigurationService,
  IEditorService,
  IStorageService,
  MenuId,
  StorageScope,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { AiSettingsEditorInput } from '../services/editor/AiSettingsEditorInput.js'
import { AGENT_FONT_SIZE_DEFAULT } from '../services/configuration/fontDefaults.js'
import { ACP_NAV_WHEN, CATEGORY } from './_agentShared.js'

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

const FONT_SIZE_KEY = 'acp.fontSize'
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 24

function currentFontSize(config: IConfigurationService): number {
  const size = config.get<number>(FONT_SIZE_KEY)
  return typeof size === 'number' && size > 0 ? size : AGENT_FONT_SIZE_DEFAULT
}

export class IncreaseAgentFontSizeAction extends Action2 {
  static readonly ID = 'workbench.action.agent.increaseFontSize'
  constructor() {
    super({
      id: IncreaseAgentFontSizeAction.ID,
      title: localize2('action.agent.increaseFontSize', 'Increase Chat Font Size'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+=', when: ACP_NAV_WHEN },
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const next = Math.min(FONT_SIZE_MAX, currentFontSize(config) + 1)
    config.update(FONT_SIZE_KEY, next, ConfigurationTarget.User)
  }
}

export class DecreaseAgentFontSizeAction extends Action2 {
  static readonly ID = 'workbench.action.agent.decreaseFontSize'
  constructor() {
    super({
      id: DecreaseAgentFontSizeAction.ID,
      title: localize2('action.agent.decreaseFontSize', 'Decrease Chat Font Size'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+-', when: ACP_NAV_WHEN },
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const next = Math.max(FONT_SIZE_MIN, currentFontSize(config) - 1)
    config.update(FONT_SIZE_KEY, next, ConfigurationTarget.User)
  }
}

export class ResetAgentFontSizeAction extends Action2 {
  static readonly ID = 'workbench.action.agent.resetFontSize'
  constructor() {
    super({
      id: ResetAgentFontSizeAction.ID,
      title: localize2('action.agent.resetFontSize', 'Reset Chat Font Size'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+0', when: ACP_NAV_WHEN },
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor
      .get(IConfigurationService)
      .update(FONT_SIZE_KEY, AGENT_FONT_SIZE_DEFAULT, ConfigurationTarget.User)
  }
}
