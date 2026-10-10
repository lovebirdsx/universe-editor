/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side orchestration for the MCP tool replay debugger.
 *
 *  It owns the *policy* half of the feature — which session/tool may be replayed,
 *  what the user confirms, and what each open tab remembers — and delegates every
 *  side-effecting act to `IMcpClientService` in main. Configuration comes from the
 *  session service's layered resolver, so what gets dialled is exactly what the
 *  next `session/new` would have sent, minus the session whitelist and the
 *  default-disable overrides: replaying a server this session has switched off is
 *  the point of a debugger.
 *
 *  One connection per tab, held for the tab's lifetime and closed when it goes
 *  away. A server that dies mid-session is re-dialled by the next Run, once.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  ILoggerService,
  INotificationService,
  Severity,
  createDecorator,
  createNamedLogger,
  localize,
  observableValue,
  type ILogger,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { IMcpClientService } from '../../../../shared/ipc/mcpClientService.js'
import type {
  McpConnectTargetDto,
  McpConnectionClosedDto,
} from '../../../../shared/ipc/mcpClientService.js'
import { mcpServerToTarget, mcpServerTransport } from '../acpMcpServers.js'
import { IAcpSessionService } from '../session/acpSessionService.js'
import type { AcpToolCall, IAcpSession } from '../session/acpSessionModel.js'
import { revealMcpDebugEditor } from './mcpDebugEditorInput.js'
import {
  buildConfirmDetail,
  buildParamsSkeleton,
  describeCallError,
  describeTarget,
  parseParamsText,
  prettyJson,
  type McpDebugCallEntry,
  type McpDebugPanelState,
  type McpTransportName,
} from './mcpDebugModel.js'

export interface IMcpDebugService {
  readonly _serviceBrand: undefined
  /**
   * The card-button entry point: resolve the call's MCP server, confirm with the
   * user, open (or focus) the debugger tab and run the call once.
   */
  openFromToolCall(session: IAcpSession, call: AcpToolCall): Promise<void>
  /** State for one debugger tab, or `undefined` if that tab has no live state. */
  getState(key: string): IObservable<McpDebugPanelState> | undefined
  selectTool(key: string, toolName: string): void
  setParamsText(key: string, text: string): void
  runTool(key: string): Promise<void>
  refreshTools(key: string): Promise<void>
  /** Tear the connection down but keep the tab (and its history) open. */
  disconnect(key: string): Promise<void>
  /** Put a past call back in the box: its tool back in the list, its params in the editor. */
  restore(key: string, entryId: string): void
  clearHistory(key: string): void
  /** Drop a tab's state and connection — the tab itself is gone. */
  releaseKey(key: string): void
}

export const IMcpDebugService = createDecorator<IMcpDebugService>('mcpDebugService')

/** Newest-first cap; the panel shows a scrollable list, not an archive. */
const MAX_HISTORY = 50

interface TabEntry {
  readonly state: ISettableObservable<McpDebugPanelState>
  /**
   * Subscriptions tied to this tab's lifetime (currently: the editor input's
   * `onWillDispose`). A store rather than a bare disposable so it stays parented
   * under the service — an unparented one is reported as a teardown leak, since
   * nothing else would ever dispose it if the tab outlives the React tree.
   */
  readonly subs: DisposableStore
  target: McpConnectTargetDto
  connectionId: string | undefined
  /**
   * The handshake in flight, shared by every caller that asks while it runs. Without
   * it the panel's Run (live the moment the tab opens) and the tab's own first call
   * would each dial the server, orphaning one process per extra caller.
   */
  connecting: Promise<void> | undefined
}

export class McpDebugService extends Disposable implements IMcpDebugService {
  declare readonly _serviceBrand: undefined

  private readonly _tabs = new Map<string, TabEntry>()
  /** Parent of every {@link TabEntry.subs}; disposing the service drops them all. */
  private readonly _tabSubs = this._register(new DisposableStore())
  private readonly _logger: ILogger
  /** Makes history-entry ids unique even for two calls in the same millisecond. */
  private _seq = 0

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IMcpClientService private readonly _client: IMcpClientService,
    @IDialogService private readonly _dialogs: IDialogService,
    @INotificationService private readonly _notifications: INotificationService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _inst: IInstantiationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'mcpDebug', name: 'MCP Debug' })
    this._register(this._client.onDidCloseConnection((event) => this._onConnectionClosed(event)))
  }

  async openFromToolCall(session: IAcpSession, call: AcpToolCall): Promise<void> {
    const serverName = call.mcpServer
    const toolName = call.mcpTool
    if (serverName === undefined || toolName === undefined) return
    if (call.rawInput === undefined || call.memoryTrimmed === true) {
      // The card hides its button in this case; this path is reachable from the
      // command palette, so say why rather than doing nothing.
      this._warn(
        localize(
          'mcpDebug.unavailable.params',
          'This call’s parameters were released to save memory, so it cannot be replayed.',
        ),
      )
      return
    }
    if (session.authority !== undefined) {
      this._warn(
        localize(
          'mcpDebug.unavailable.remote',
          'Remote workspaces are not supported by the MCP debugger yet.',
        ),
      )
      return
    }
    if (session.readOnly) {
      // The card button is disabled for this case; the command palette still gets
      // here, and a replay would run a process inside someone else's worktree.
      this._warn(
        localize(
          'mcpDebug.unavailable.readOnly',
          'This session is a read-only preview, so MCP replay is disabled.',
        ),
      )
      return
    }

    const resolution = await this._sessions.resolveMcpServerConnection({
      agentId: session.agentId,
      serverName,
      ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
    })
    if (resolution.kind !== 'ok') {
      this._warn(
        localize(
          'mcpDebug.unavailable.notFound',
          'MCP server "{server}" is not in the current configuration.',
          { server: serverName },
        ),
      )
      return
    }
    const target = mcpServerToTarget(resolution.server, session.cwd)
    if (target === undefined) {
      this._warn(
        localize(
          'mcpDebug.unavailable.transport',
          'MCP server "{server}" is served over the ACP connection and cannot be dialled directly.',
          { server: serverName },
        ),
      )
      return
    }

    const transport = mcpServerTransport(resolution.server)
    const answer = await this._dialogs.confirm({
      message: localize('mcpDebug.confirm.message', 'Run MCP tool "{tool}" on "{server}"?', {
        tool: toolName,
        server: serverName,
      }),
      detail: [
        localize(
          'mcpDebug.confirm.detail',
          'This calls the MCP server directly, bypassing the agent’s permission checks.',
        ),
        '',
        buildConfirmDetail({ serverName, transport, tool: toolName, params: call.rawInput }),
      ].join('\n'),
      primaryButton: localize('mcpDebug.confirm.run', 'Run Tool'),
      cancelButton: localize('dialog.default.cancel', 'Cancel'),
      type: 'warning',
    })
    if (!answer.confirmed) return

    const key = debugKey(session.id, serverName)
    const tab = this._ensureTab(key, {
      sessionId: session.id,
      serverName,
      transport,
      target,
      summary: describeTarget(stdioOrUrl(target)),
      tool: toolName,
      params: call.rawInput,
      warning: localize(
        'mcpDebug.warning',
        'Calls made here go straight to the MCP server and skip the agent’s permission prompts.',
      ),
    })
    const input = revealMcpDebugEditor(this._groups, this._inst, key, serverName)
    // State lives exactly as long as the tab does. `clear()` first: re-opening the
    // same debugger from another card hands back the same input, and its old
    // subscription would otherwise fire alongside the new one.
    tab.subs.clear()
    tab.subs.add(input.onWillDispose(() => this.releaseKey(key)))

    await this._connect(key)
    // A failed connect already said why (connection: 'failed'); letting `runTool`
    // try again would just double the wait before the same message.
    if (tab.connectionId === undefined) return
    await this.runTool(key)
  }

  getState(key: string): IObservable<McpDebugPanelState> | undefined {
    return this._tabs.get(key)?.state
  }

  selectTool(key: string, toolName: string): void {
    const tab = this._tabs.get(key)
    if (!tab) return
    const state = tab.state.get()
    const tool = state.tools.find((t) => t.name === toolName)
    this._patch(tab, {
      selectedTool: toolName,
      // Never clobber what the user typed; only seed an untouched box.
      ...(state.paramsDirty ? {} : { paramsText: buildParamsSkeleton(tool?.inputSchema) }),
    })
  }

  setParamsText(key: string, text: string): void {
    const tab = this._tabs.get(key)
    if (tab) this._patch(tab, { paramsText: text, paramsDirty: true })
  }

  async runTool(key: string): Promise<void> {
    const tab = this._tabs.get(key)
    if (!tab || tab.state.get().running) return
    const state = tab.state.get()
    const tool = state.selectedTool ?? state.tools[0]?.name
    if (tool === undefined) {
      this._patch(tab, { lastError: localize('mcpDebug.noTool', 'Pick a tool first.') })
      return
    }
    const parsed = parseParamsText(state.paramsText)
    if (!parsed.ok) {
      this._patch(tab, {
        lastError: localize('mcpDebug.badJson', 'Invalid JSON: {message}', {
          message: parsed.message,
        }),
      })
      return
    }
    const startedAt = Date.now()
    const entryId = `${startedAt}-${this._seq++}-${tool}`
    // Claimed before the await, not after: a reconnect can take seconds, and two
    // Runs overlapping there would each send the call.
    this._patch(tab, { running: true, lastError: undefined, lastResult: undefined })
    if (tab.connectionId === undefined) {
      // The server died, was reaped, or was never reached. One reconnect attempt
      // is what makes "fix the server, press Run again" work.
      await this._connect(key)
      if (tab.connectionId === undefined) {
        this._patch(tab, { running: false })
        return
      }
    }

    try {
      const result = await this._client.callTool(tab.connectionId, tool, parsed.value)
      this._pushHistory(tab, {
        id: entryId,
        tool,
        paramsText: state.paramsText,
        startedAt,
        durationMs: result.durationMs,
        isError: result.isError,
        result,
        error: undefined,
      })
      this._patch(tab, { running: false, lastResult: result })
    } catch (err) {
      const message = describeCallError(err)
      this._logger.warn(`call failed key=${key} tool=${tool}: ${message}`)
      if ((err as { code?: unknown }).code === 'MCP_UNKNOWN_CONNECTION') {
        tab.connectionId = undefined
        this._patch(tab, { connection: 'idle' })
      }
      this._pushHistory(tab, {
        id: entryId,
        tool,
        paramsText: state.paramsText,
        startedAt,
        durationMs: Date.now() - startedAt,
        isError: true,
        result: undefined,
        error: message,
      })
      this._patch(tab, { running: false, lastError: message })
    }
  }

  async refreshTools(key: string): Promise<void> {
    const tab = this._tabs.get(key)
    if (!tab || tab.connectionId === undefined) return
    this._patch(tab, { toolsError: undefined })
    try {
      this._patch(tab, { tools: await this._client.listTools(tab.connectionId) })
    } catch (err) {
      this._patch(tab, { toolsError: describeCallError(err) })
    }
  }

  async disconnect(key: string): Promise<void> {
    const tab = this._tabs.get(key)
    if (!tab) return
    const connectionId = tab.connectionId
    tab.connectionId = undefined
    this._patch(tab, { connection: 'idle', connectionError: undefined, running: false })
    if (connectionId !== undefined) await this._client.disconnect(connectionId)
  }

  clearHistory(key: string): void {
    const tab = this._tabs.get(key)
    if (tab) this._patch(tab, { history: [] })
  }

  restore(key: string, entryId: string): void {
    const tab = this._tabs.get(key)
    if (!tab) return
    const entry = tab.state.get().history.find((e) => e.id === entryId)
    if (!entry) return
    // selectTool first: it may reseed the box from the tool's schema, and the
    // remembered text has to win over that. Then mark it dirty — what is in the
    // box now is a past call, not this tab's pristine seed.
    this.selectTool(key, entry.tool)
    this.setParamsText(key, entry.paramsText)
  }

  releaseKey(key: string): void {
    const tab = this._tabs.get(key)
    if (!tab) return
    this._tabs.delete(key)
    const connectionId = tab.connectionId
    this._tabSubs.delete(tab.subs)
    // The state observable is intentionally left to GC, like every other bare
    // observableValue in a session view-model: nothing global is registered on it.
    if (connectionId !== undefined) void this._client.disconnect(connectionId)
  }

  override dispose(): void {
    for (const key of [...this._tabs.keys()]) this.releaseKey(key)
    super.dispose()
  }

  private _ensureTab(
    key: string,
    seed: {
      readonly sessionId: string
      readonly serverName: string
      readonly transport: McpTransportName
      readonly target: McpConnectTargetDto
      readonly summary: string
      readonly tool: string
      readonly params: unknown
      readonly warning: string
    },
  ): TabEntry {
    const existing = this._tabs.get(key)
    if (existing) {
      // Re-opening the same debugger from another card: keep the connection and
      // history, just re-aim the params at the call the user clicked.
      if (!sameTarget(existing.target, seed.target)) {
        // The server definition changed between replays (the settings were edited).
        // The held connection still points at the old one, so drop it — the Run that
        // follows dials the new target, and the panel's target line stops lying.
        const stale = existing.connectionId
        existing.connectionId = undefined
        if (stale !== undefined) void this._client.disconnect(stale)
      }
      existing.target = seed.target
      this._patch(existing, {
        transport: seed.transport,
        targetSummary: seed.summary,
        selectedTool: seed.tool,
        paramsText: prettyJson(seed.params),
        // Re-aimed at the card's recorded call, so the box is pristine again —
        // selecting another tool may now reseed it.
        paramsDirty: false,
        lastError: undefined,
      })
      return existing
    }
    const state = observableValue<McpDebugPanelState>(`mcpDebug.${key}`, {
      key,
      sessionId: seed.sessionId,
      serverName: seed.serverName,
      transport: seed.transport,
      targetSummary: seed.summary,
      connection: 'idle',
      connectionError: undefined,
      serverVersion: undefined,
      instructions: undefined,
      tools: [],
      toolsError: undefined,
      selectedTool: seed.tool,
      // Seeded from the card's recorded call, not typed by the user.
      paramsDirty: false,
      paramsText: prettyJson(seed.params),
      running: false,
      lastResult: undefined,
      lastError: undefined,
      history: [],
      warning: seed.warning,
    })
    const tab: TabEntry = {
      state,
      subs: this._tabSubs.add(new DisposableStore()),
      target: seed.target,
      connectionId: undefined,
      connecting: undefined,
    }
    this._tabs.set(key, tab)
    return tab
  }

  private _connect(key: string): Promise<void> {
    const tab = this._tabs.get(key)
    if (!tab) return Promise.resolve()
    // One connection per tab: re-opening the debugger from another card must not
    // spawn a second server and orphan the first. Dead connections clear
    // `connectionId` first, so the reconnect paths still get through.
    if (tab.connectionId !== undefined) return Promise.resolve()
    if (tab.connecting === undefined) {
      const pending = this._doConnect(key, tab)
      tab.connecting = pending.finally(() => {
        tab.connecting = undefined
      })
    }
    return tab.connecting
  }

  private async _doConnect(key: string, tab: TabEntry): Promise<void> {
    const target = tab.target
    this._patch(tab, {
      connection: 'connecting',
      connectionError: undefined,
      toolsError: undefined,
    })
    try {
      const result = await this._client.connect(target)
      if (this._tabs.get(key) !== tab || !sameTarget(tab.target, target)) {
        // The tab closed (or was re-aimed at another server) while we were
        // handshaking: nothing else would ever release this connection.
        void this._client.disconnect(result.connectionId)
        return
      }
      tab.connectionId = result.connectionId
      this._patch(tab, {
        connection: 'connected',
        connectionError: undefined,
        tools: result.tools,
        serverVersion: result.serverVersion,
        instructions: result.instructions ?? undefined,
      })
    } catch (err) {
      const message = describeCallError(err)
      this._logger.warn(`connect failed key=${key}: ${message}`)
      if (this._tabs.get(key) === tab) {
        this._patch(tab, { connection: 'failed', connectionError: message })
      }
    }
  }

  private _onConnectionClosed(event: McpConnectionClosedDto): void {
    for (const tab of this._tabs.values()) {
      if (tab.connectionId !== event.connectionId) continue
      tab.connectionId = undefined
      const server = tab.state.get().serverName
      this._patch(tab, {
        connection: 'idle',
        running: false,
        warning:
          event.reason === 'idle'
            ? localize('mcpDebug.closed.idle', 'The idle connection to "{server}" was closed.', {
                server,
              })
            : localize('mcpDebug.closed', 'The connection to "{server}" ended ({reason}).', {
                server,
                reason:
                  event.reason === 'server-exit'
                    ? localize('mcpDebug.closed.serverExit', 'the server exited')
                    : localize('mcpDebug.closed.transportError', 'the connection failed'),
              }),
      })
      return
    }
  }

  private _pushHistory(tab: TabEntry, entry: McpDebugCallEntry): void {
    this._patch(tab, { history: [entry, ...tab.state.get().history].slice(0, MAX_HISTORY) })
  }

  private _patch(tab: TabEntry, patch: Partial<McpDebugPanelState>): void {
    tab.state.set({ ...tab.state.get(), ...patch }, undefined)
  }

  private _warn(message: string): void {
    this._notifications.notify({ severity: Severity.Warning, message })
  }
}

/** Tab identity: one debugger per (session, server) pair. */
export function debugKey(sessionId: string, serverName: string): string {
  return `${sessionId}::${serverName}`
}

/**
 * The connect target is a plain JSON DTO and every re-open hands over a fresh
 * object, so identity says nothing — compare structurally.
 */
function sameTarget(a: McpConnectTargetDto, b: McpConnectTargetDto): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Narrow a connect target to the fields `describeTarget` renders. */
function stdioOrUrl(target: McpConnectTargetDto): {
  kind: McpTransportName
  command?: string
  args?: readonly string[]
  url?: string
} {
  return target.kind === 'stdio'
    ? { kind: 'stdio', command: target.command, args: target.args }
    : { kind: target.kind, url: target.url }
}
