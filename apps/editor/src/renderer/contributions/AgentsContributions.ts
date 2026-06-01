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
  IEditorGroupsService,
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
  type IEditorGroup,
} from '@universe-editor/platform'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'
import { IAcpChatLocationService } from '../services/acp/acpChatLocationService.js'

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
          'acp.claude.source': {
            type: 'string',
            enum: ['download', 'system', 'custom'],
            default: 'download',
            description: localize(
              'settings.acp.claude.source',
              'How to obtain the native Claude binary for the built-in agent: "download" fetches it on first use into the user data folder, "system" reuses a `claude` install found on PATH, "custom" uses the path in `acp.claude.executablePath`.',
            ),
          },
          'acp.claude.executablePath': {
            type: 'string',
            default: '',
            description: localize(
              'settings.acp.claude.executablePath',
              'Absolute path to a Claude executable. Used only when `acp.claude.source` is "custom".',
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
            type: 'object',
            default: {},
            description: localize(
              'settings.acp.mcpServers',
              'MCP servers forwarded to the agent on session/new, keyed by server name. stdio: `{ "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "env": {} } }`. http/sse: `{ "docs": { "type": "http", "url": "https://…", "headers": {} } }`. Transports the agent does not support (http/sse) are skipped with a warning; env/header values are stored in plain text — keep secrets in real environment variables.',
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
        id: 'workbench.view.agents.main',
        name: localize('view.agents.main', 'Agents'),
        containerId: 'workbench.view.agents',
        componentKey: 'agents.main',
        order: 1,
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
        deserialize: (data, accessor) =>
          typeof data === 'string' ? AcpSessionEditorInput.deserialize(data, accessor) : null,
      }),
    )
  }
}

export class AgentsStatusBarContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IStatusBarService statusBar: IStatusBarService) {
    super()
    const entry = statusBar.addEntry({
      text: '',
      icon: 'sparkle',
      tooltip: localize('acp.statusbar.tooltip', 'Agents'),
      alignment: StatusBarAlignment.Right,
      priority: 50,
      command: 'workbench.action.agent.openView',
    })
    this._register({ dispose: () => entry.dispose() })
  }
}

/**
 * Lazy-restores the previously-active ACP session AND kicks off the
 * cross-agent `session/list` hydrate when the AGENTS view first becomes
 * visible after an editor restart (or after a workspace swap). Both calls
 * are idempotent on the service side — the contribution only owns the
 * visibility trigger so we never spawn agent subprocesses inside the
 * workspace cwd until the user actually looks at the Agents UI.
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
        sessions.requestHydrateIfNeeded()
        void sessions.tryRestoreActiveSession()
      }),
    )
  }
}

/**
 * Stops the live agent subprocess whenever the user closes an
 * AcpSessionEditorInput tab. The session history entry is preserved so a later
 * click in the session list can re-resume it.
 *
 * Two close paths are filtered out so we don't kill sessions the user still
 * cares about:
 *   - `AcpChatLocationService.isMigrating` — `setLocation('sidebar')` closes
 *     editor tabs as a relocation, not a termination.
 *   - The same `AcpSessionEditorInput` still open in another group (future
 *     split-view) — treat that as "still showing" and skip.
 */
export class AgentsSessionEditorLifecycleContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IEditorGroupsService private readonly _editorGroups: IEditorGroupsService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpChatLocationService private readonly _location: IAcpChatLocationService,
  ) {
    super()
    for (const group of this._editorGroups.groups) {
      this._subscribeGroup(group)
    }
    this._register(this._editorGroups.onDidAddGroup((group) => this._subscribeGroup(group)))
  }

  private _subscribeGroup(group: IEditorGroup): void {
    this._register(
      group.onDidChangeModel((e) => {
        if (e.kind !== 'close') return
        const closed = e.editor
        if (!(closed instanceof AcpSessionEditorInput)) return
        if (this._location.isMigrating) return
        const stillOpen = this._editorGroups.groups.some((g) =>
          g.editors.some((ed) => ed instanceof AcpSessionEditorInput && ed.id === closed.id),
        )
        if (stillOpen) return
        const session = this._sessions.getById(closed.sessionId)
        if (!session) return
        void this._sessions.closeSession(session.id)
      }),
    )
  }
}
