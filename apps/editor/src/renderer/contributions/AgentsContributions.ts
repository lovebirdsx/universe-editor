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
  IEditorService,
  ILayoutService,
  IViewsService,
  IWorkbenchContribution,
  PartId,
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
import { AGENT_FONT_SIZE_DEFAULT } from '../services/configuration/fontDefaults.js'

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
          'acp.codex.source': {
            type: 'string',
            enum: ['download', 'system', 'custom'],
            default: 'download',
            description: localize(
              'settings.acp.codex.source',
              'How to obtain the codex-acp adapter binary for the built-in Codex agent: "download" fetches it on first use into the user data folder, "system" reuses a `codex-acp` install found on PATH, "custom" uses the path in `acp.codex.executablePath`.',
            ),
          },
          'acp.codex.executablePath': {
            type: 'string',
            default: '',
            description: localize(
              'settings.acp.codex.executablePath',
              'Absolute path to a codex-acp executable. Used only when `acp.codex.source` is "custom".',
            ),
          },
          'acp.codex.apiKey': {
            type: 'string',
            default: '',
            description: localize(
              'settings.acp.codex.apiKey',
              'OpenAI API key passed to Codex as OPENAI_API_KEY. Stored in plain text — prefer setting a real OPENAI_API_KEY / CODEX_API_KEY environment variable, which the agent inherits automatically when this is left empty.',
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
          'acp.notifications.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.acp.notifications.enabled',
              'Show an OS desktop notification when an agent needs attention (permission request, question, task completed, or error) while the editor window is not focused. Clicking the notification focuses the window and jumps to that session.',
            ),
          },
          'acp.defaultCollapseModes': {
            type: 'object',
            default: {
              'claude-code': 'default',
              codex: 'collapsed',
            },
            description: localize(
              'settings.acp.defaultCollapseModes',
              'Default timeline collapse mode for new sessions per agent ID. Possible values: "default" (smart per-kind folding), "collapsed" (all folded), "expanded" (all unfolded). Example: { "claude-code": "default", "codex": "collapsed" }.',
            ),
          },
          'acp.fontSize': {
            type: 'number',
            default: AGENT_FONT_SIZE_DEFAULT,
            minimum: 8,
            maximum: 24,
            description: localize(
              'settings.acp.fontSize',
              'Controls the base font size (in pixels) of the Agent chat panel. Code blocks and other content scale relative to this.',
            ),
          },
          'acp.fontFamily': {
            type: 'string',
            default: '',
            description: localize(
              'settings.acp.fontFamily',
              'Controls the font family of the Agent chat panel. Leave empty to inherit the workbench UI font.',
            ),
          },
          'acp.usage.refreshIntervalMs': {
            type: 'number',
            default: 10000,
            minimum: 1000,
            description: localize(
              'settings.acp.usage.refreshIntervalMs',
              'How often (milliseconds) the API usage indicator below the Agent prompt refreshes. Polling pauses while the window is hidden.',
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

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.agents.mcp',
        name: localize('view.agents.mcp', 'MCP Servers'),
        containerId: 'workbench.view.agents',
        componentKey: 'agents.mcp',
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
        deserialize: (data, accessor) =>
          typeof data === 'string' ? AcpSessionEditorInput.deserialize(data, accessor) : null,
      }),
    )
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
    this._register(
      this._sessions.onDidCloseSession((closedId) => {
        for (const group of this._editorGroups.groups) {
          for (const editor of [...group.editors]) {
            if (editor instanceof AcpSessionEditorInput && editor.sessionId === closedId) {
              group.closeEditor(editor)
            }
          }
        }
      }),
    )
  }

  private _subscribeGroup(group: IEditorGroup): void {
    this._register(
      group.onDidChangeModel((e) => {
        if (e.kind !== 'close') return
        const closed = e.editor
        if (!(closed instanceof AcpSessionEditorInput)) return
        if (this._location.isMigrating) return
        // `moveEditor` 实现为 detach(触发 'close')→ open,二者同步。detach 触发的
        // 'close' 与真正关闭无法区分,且发生在 editor 进入目标组之前。把判断推到
        // 微任务,等同步的 detach+open 结束后再看 editor 是否还在某个组——拖动分屏
        // 时它已落在目标组,stillOpen 为 true → 不误杀 session。
        queueMicrotask(() => {
          const stillOpen = this._editorGroups.groups.some((g) =>
            g.editors.some((ed) => ed instanceof AcpSessionEditorInput && ed.id === closed.id),
          )
          if (stillOpen) return
          const session = this._sessions.getById(closed.sessionId)
          if (!session) return
          void this._sessions.closeSession(session.id)
        })
      }),
    )
  }
}

/**
 * Keeps `IAcpSessionService.activeSession` in sync with the focused session
 * editor. Multiple session editors can be open at once; whichever tab the user
 * focuses should become the active session so session-scoped UI (the Session
 * Changes view, the status-bar MCP summary, …) tracks the editor in front of
 * them. Without this, `activeSession` only moves on explicit list/new actions
 * and stale-looks when the user clicks between session tabs.
 */
export class AgentsActiveSessionSyncContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IEditorService private readonly _editor: IEditorService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
  ) {
    super()
    this._register(
      autorun((r) => {
        const active = this._editor.activeEditor.read(r)
        if (!(active instanceof AcpSessionEditorInput)) return
        if (this._sessions.activeSessionId.get() === active.sessionId) return
        // Only retarget to a live session; a not-yet-resumed editor leaves the
        // pointer alone until AcpSessionResumer brings it up (which itself calls
        // setActive on success).
        if (this._sessions.getById(active.sessionId)) this._sessions.setActive(active.sessionId)
      }),
    )
  }
}
