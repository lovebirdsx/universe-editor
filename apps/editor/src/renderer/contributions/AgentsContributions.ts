/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentsContributions — Configuration schema, ViewContainer/View, EditorProvider,
 *  and StatusBar wiring for the ACP integration. Grouped into one module to keep
 *  the per-feature footprint small.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  EditorRegistry,
  IEditorService,
  ILayoutService,
  IStatusBarService,
  IViewsService,
  IWorkbenchContribution,
  PartId,
  StatusBarAlignment,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  autorun,
  localize,
} from '@universe-editor/platform'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'

export class AgentsConfigurationContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'acp',
        title: localize('settings.agents', 'Agents'),
        properties: {
          'acp.agents': {
            type: 'array',
            default: [],
            description: localize(
              'settings.acp.agents',
              'Custom ACP-compatible agent commands. Each entry needs `id`, `command`; `args`, `env`, `cwd` are optional. Env values are stored in plain text — keep API keys in real environment variables.',
            ),
          },
          'acp.defaultAgentId': {
            type: 'string',
            default: 'claude-code',
            description: localize(
              'settings.acp.defaultAgentId',
              'Default agent used by "New Agent Session".',
            ),
          },
          'acp.permissions.autoApprove': {
            type: 'array',
            default: [],
            description: localize(
              'settings.acp.permissions',
              'Tool-call kinds that are auto-approved without prompting (e.g. "fs.read").',
            ),
          },
          'acp.startupTimeoutMs': {
            type: 'number',
            description: localize(
              'settings.acp.startupTimeoutMs',
              'How long to wait (milliseconds) for an agent to answer `initialize` + `session/new` before giving up. Lower this only if you trust your agent to start quickly.',
            ),
          },
          'acp.mcpServers': {
            type: 'array',
            default: [],
            description: localize(
              'settings.acp.mcpServers',
              "MCP servers forwarded to the agent on session/new. Each entry must follow the agent's expected shape.",
            ),
          },
        },
      }),
    )
  }
}

export class AgentsViewContainerContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.agents',
        label: localize('viewContainer.agents', 'Agents'),
        icon: 'sparkle',
        order: 2,
        location: ViewContainerLocation.SecondarySideBar,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.agents.chat',
        name: localize('view.agents.chat', 'Chat'),
        containerId: 'workbench.view.agents',
        componentKey: 'agents.chat',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.agents.sessions',
        name: localize('view.agents.sessions', 'Sessions'),
        containerId: 'workbench.view.agents',
        componentKey: 'agents.sessions',
        order: 2,
      }),
    )
  }
}

export class AgentsEditorProviderContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: AcpSessionEditorInput.TYPE_ID,
        componentKey: 'agents.session',
        deserialize: (data) =>
          typeof data === 'string' ? AcpSessionEditorInput.deserialize(data) : null,
      }),
    )
  }
}

export class AgentsStatusBarContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IAcpSessionService sessions: IAcpSessionService,
    @IStatusBarService statusBar: IStatusBarService,
    @IEditorService _editor: IEditorService,
  ) {
    super()
    const entry = statusBar.addEntry({
      text: 'Agents',
      icon: 'sparkle',
      tooltip: localize('acp.statusbar.tooltip', 'ACP agent sessions'),
      alignment: StatusBarAlignment.Right,
      priority: 50,
      command: 'workbench.action.agent.newSession',
    })
    this._register({ dispose: () => entry.dispose() })

    this._register(
      autorun((r) => {
        const active = sessions.activeSession.read(r)
        const total = sessions.sessions.read(r).length
        if (!active) {
          entry.update({
            text: total > 0 ? `Agents (${total})` : 'Agents',
            icon: 'sparkle',
            tooltip: localize('acp.statusbar.tooltip', 'ACP agent sessions'),
            alignment: StatusBarAlignment.Right,
            priority: 50,
            command: 'workbench.action.agent.newSession',
          })
        } else {
          const status = active.status.read(r)
          entry.update({
            text: `${active.title} · ${status}`,
            icon: 'sparkle',
            tooltip: active.title,
            alignment: StatusBarAlignment.Right,
            priority: 50,
            command: 'workbench.action.agent.openInEditor',
          })
        }
      }),
    )
  }
}

/**
 * Lazy-restores the previously-active ACP session when the AGENTS view first
 * becomes visible after an editor restart. Mirrors LogTailContribution's
 * autorun-driven restore for the Output panel: persisting the historyId is
 * AcpSessionService's job, this contribution only owns the visibility trigger.
 */
export class AgentsSessionRestoreContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @ILayoutService layout: ILayoutService,
    @IViewsService views: IViewsService,
    @IAcpSessionService sessions: IAcpSessionService,
  ) {
    super()
    this._register(
      autorun((r) => {
        if (!layout.visible.read(r)[PartId.SecondarySideBar]) return
        const active =
          views.activeContainerByLocation.read(r)[ViewContainerLocation.SecondarySideBar]
        if (active !== 'workbench.view.agents') return
        void sessions.tryRestoreActiveSession()
      }),
    )
  }
}
