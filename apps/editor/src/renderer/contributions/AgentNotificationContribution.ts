/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Raises OS-level desktop notifications when an Agent session needs the user's
 *  attention (permission request, question, turn completed, or error) while the
 *  editor window is blurred. Clicking a notification focuses the window and jumps
 *  to the originating session. Focus gating lives in the main-side host service.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IEditorGroupsService,
  IHostService,
  IInstantiationService,
  IWorkbenchContribution,
  IWorkspaceService,
  autorun,
  localize,
  type SystemNotificationOrigin,
} from '@universe-editor/platform'
import { IAcpSessionService, type IAcpSession } from '../services/acp/session/acpSessionService.js'
import {
  createAgentAttentionSignal,
  type AgentAttentionEvent,
  type AgentAttentionSignal,
} from '../services/acp/session/agentAttentionSignal.js'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { revealSessionChat } from '../services/acp/session/revealSessionChat.js'
import type { FoundSessionEditor } from '../services/acp/session/revealSessionEditorTab.js'
import { AcpSessionEditorInput } from '../services/acp/session/acpSessionEditorInput.js'
import { IWindowFocusService } from '../services/windows/windowFocusService.js'
import { IWorkbenchWindowService } from '../services/windows/workbenchWindowService.js'
import { truncateTitle } from '../services/acp/session/sessionTitleFormat.js'
import {
  getAgentNotificationIcon,
  primeAgentNotificationIcon,
} from '../services/acp/agentNotificationIcon.js'

type NotifyKind = AgentAttentionEvent['kind']

export class AgentNotificationContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IHostService private readonly _host: IHostService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _inst: IInstantiationService,
    @IAcpChatWidgetService private readonly _widgets: IAcpChatWidgetService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IWindowFocusService private readonly _windowFocus: IWindowFocusService,
    @IWorkbenchWindowService private readonly _windows: IWorkbenchWindowService,
  ) {
    super()

    // Icons rasterize asynchronously; warm them as sessions appear so the
    // cache is ready when an edge fires.
    this._register(
      autorun((r) => {
        for (const session of this._sessions.sessions.read(r)) {
          primeAgentNotificationIcon(session.agentId)
        }
      }),
    )

    const signal: AgentAttentionSignal = createAgentAttentionSignal(this._sessions.sessions)
    this._register(signal)
    this._register(signal.onDidAttention((event) => this._fire(event)))
  }

  private _enabled(): boolean {
    return this._config.get<boolean>('acp.notifications.enabled') ?? true
  }

  private _fire(event: AgentAttentionEvent): void {
    if (!this._enabled()) return
    const { kind, session } = event
    const title = titleFor(kind)
    const lines = [truncateTitle(session.title)]
    const workspaceName = this._workspace.current?.name
    if (workspaceName !== undefined && workspaceName.length > 0) lines.push(workspaceName)
    void this._notifyAndMaybeFocus(
      session.id,
      session.agentId,
      title,
      lines.join('\n'),
      this._originWindowFor(session),
    )
  }

  /**
   * Auxiliary windows share this renderer and therefore this host service, so
   * the notification must name the window that holds the session's tab — the
   * main-side host gates, flashes and focuses that window instead of the
   * parent workspace window. A session with no open tab is background work:
   * pin it to the workspace window rather than to whatever window happens to
   * be focused.
   */
  private _originWindowFor(session: IAcpSession): SystemNotificationOrigin {
    const found = this._findSessionEditor(session)
    if (found === undefined || found.group.part.isMain) return { kind: 'workspace' }
    const token = this._windows.getWindowForPart(found.group.part)?.token
    return token !== undefined ? { kind: 'auxiliary', token } : { kind: 'workspace' }
  }

  private _findSessionEditor(session: IAcpSession): FoundSessionEditor | undefined {
    // A tab's id may be the local uuid, the current durable id, or an id kept
    // across a reconnect (hot reconnect issues a new session id). Resolving the
    // tab's session through getById covers all aliases, so compare identities
    // instead of running exact-id lookups.
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (
          editor instanceof AcpSessionEditorInput &&
          this._sessions.getById(editor.sessionId)?.id === session.id
        ) {
          return { group, editor }
        }
      }
    }
    return undefined
  }

  private async _notifyAndMaybeFocus(
    sessionId: string,
    agentId: string | undefined,
    title: string,
    body: string,
    origin: SystemNotificationOrigin,
  ): Promise<void> {
    const icon = getAgentNotificationIcon(agentId)
    const res = await this._host.notify({
      title,
      body,
      originWindow: origin,
      ...(icon ? { icon } : {}),
    })
    if (!res.clicked) return
    this._sessions.setActive(sessionId)
    revealSessionChat(
      {
        groups: this._groups,
        inst: this._inst,
        widgets: this._widgets,
        windowFocus: this._windowFocus,
      },
      sessionId,
      this._sessions.getById(sessionId),
    )
  }
}

function titleFor(kind: NotifyKind): string {
  switch (kind) {
    case 'permission':
      return localize('acp.notify.permission.title', 'Agent needs your permission')
    case 'question':
      return localize('acp.notify.question.title', 'Agent has a question')
    case 'completed':
      return localize('acp.notify.completed.title', 'Agent finished its task')
    case 'errored':
      return localize('acp.notify.errored.title', 'Agent run failed')
  }
}
