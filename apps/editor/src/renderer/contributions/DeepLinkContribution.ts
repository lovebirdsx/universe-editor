/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Opens a `universe-editor://` deep link routed here by the main process — at
 *  cold-launch (argv) or pushed over IPC to a live window. The main process has
 *  already reduced the link to an opener target (`path:line:col`, `command:…`,
 *  or `agent:new?...`). File and command links go through IOpenerService with
 *  the deep-link command whitelist; agent prompt links are handled explicitly so
 *  the command whitelist never becomes a generic agent-launch surface.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IInstantiationService,
  ILayoutService,
  IOpenerService,
  IViewsService,
  ICommandService,
  PartId,
} from '@universe-editor/platform'
import type { IWorkbenchContribution } from '@universe-editor/platform'
import {
  DEEP_LINK_ALLOWED_COMMANDS,
  parseAgentPromptOpenerTarget,
  type DeepLinkAgentPromptTarget,
} from '../../shared/deepLink.js'
import type { IpcBridge } from '../../preload/index.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { IAcpChatLocationService } from '../services/acp/acpChatLocationService.js'
import { IAcpChatWidgetService } from '../services/acp/acpChatWidgetService.js'
import { AcpPromptTextInbox } from '../services/acp/acpPromptTextInbox.js'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'

export class DeepLinkContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IOpenerService private readonly _opener: IOpenerService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpAgentRegistry private readonly _agents: IAcpAgentRegistry,
    @IAcpChatLocationService private readonly _location: IAcpChatLocationService,
    @IAcpChatWidgetService private readonly _widgets: IAcpChatWidgetService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @ILayoutService private readonly _layout: ILayoutService,
    @IViewsService private readonly _views: IViewsService,
    @ICommandService private readonly _commands: ICommandService,
  ) {
    super()
    const ipc = (window as { ipc?: IpcBridge }).ipc
    if (!ipc) return

    if (ipc.openUriTarget) this._open(ipc.openUriTarget)
    this._register({ dispose: ipc.onOpenUri((target) => this._open(target)) })
  }

  private _open(target: string): void {
    const agentPrompt = parseAgentPromptOpenerTarget(target)
    if (agentPrompt) {
      void this._openAgentPrompt(agentPrompt)
      return
    }

    console.log(`[DeepLinkContribution] opening deep link: ${target}`)
    void this._opener.open(target, {
      allowCommands: DEEP_LINK_ALLOWED_COMMANDS,
      fromUserGesture: true,
    })
  }

  private async _openAgentPrompt(target: DeepLinkAgentPromptTarget): Promise<void> {
    const agentId = target.agent ?? this._agents.defaultAgentId()
    try {
      this._agents.get(agentId)
    } catch (err) {
      console.warn(`[DeepLinkContribution] unknown agent in deep link: ${(err as Error).message}`)
      return
    }

    console.log(
      `[DeepLinkContribution] opening agent deep link: agent=${agentId} autoSubmit=${target.autoSubmit}`,
    )
    if (target.pid !== undefined) {
      await this._commands.executeCommand('universeEditorMcp.usePidOnce', target.pid)
    }
    const session = await this._sessions.createSession(agentId)
    await this._revealAgentSession(session.id)
    if (target.autoSubmit) {
      await session.sendPrompt(target.prompt)
    } else {
      AcpPromptTextInbox.deposit(session.id, target.prompt)
      this._widgets.focusSessionInput(session.id)
    }
  }

  private async _revealAgentSession(sessionId: string): Promise<void> {
    if (this._location.location.get() === 'editor') {
      const found = this._findSessionEditor(sessionId)
      if (found) {
        this._groups.activateGroup(found.group)
        found.group.setActive(found.editor)
      } else {
        const session = this._sessions.getById(sessionId)
        if (session) {
          const target = this._groups.activeGroupForOpen
          target.openEditor(
            this._instantiation.createInstance(
              AcpSessionEditorInput,
              session.id,
              session.agentId,
              undefined,
            ),
            { activate: true, pinned: true },
          )
          if (target !== this._groups.activeGroup) this._groups.activateGroup(target)
        }
      }
    } else {
      if (!this._layout.getVisible(PartId.SecondarySideBar)) {
        this._layout.toggleVisible(PartId.SecondarySideBar)
      }
      await this._views.openViewContainer('workbench.view.agents')
    }
    this._widgets.focusSessionInput(sessionId)
  }

  private _findSessionEditor(sessionId: string) {
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof AcpSessionEditorInput && editor.sessionId === sessionId) {
          return { group, editor }
        }
      }
    }
    return undefined
  }
}
