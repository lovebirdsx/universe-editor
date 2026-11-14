/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Brings a just-started trigger session in front of the user when that trigger
 *  opted in (`showSession`). Runs only in a window the user can actually see:
 *  background / minimized windows must never be revealed or focused, because the
 *  run was started unattended.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IInstantiationService,
  ILoggerService,
  InstantiationType,
  createDecorator,
  registerSingleton,
  type ILogger,
} from '@universe-editor/platform'
import { IAcpChatWidgetService } from '../acp/session/acpChatWidgetService.js'
import { IAcpSessionService } from '../acp/session/acpSessionService.js'
import { revealSessionChat } from '../acp/session/revealSessionChat.js'
import { currentWorkbenchDocumentOrUndefined } from '../windows/workbenchDocuments.js'
import { IWindowFocusService } from '../windows/windowFocusService.js'

/**
 * "The user can see this window": Electron reports a hidden background window
 * and a minimized window as `visibilityState === 'hidden'`.
 */
export function isWorkbenchWindowVisible(doc: Document | undefined): boolean {
  return doc !== undefined && doc.visibilityState !== 'hidden'
}

export interface ITriggerSessionRevealService {
  readonly _serviceBrand: undefined
  /**
   * Reveal a just-started automated session's chat when its trigger set
   * `showSession` and this window is visible. `sessionId` is the agent-issued
   * durable id; the chat widget registry is keyed by the live session's local
   * id, so it is resolved here. Best effort by design — callers still guard
   * against throws.
   */
  revealOnRunStart(sessionId: string, showSession: boolean): void
}

export const ITriggerSessionRevealService = createDecorator<ITriggerSessionRevealService>(
  'triggerSessionRevealService',
)

export class TriggerSessionRevealService
  extends Disposable
  implements ITriggerSessionRevealService
{
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _inst: IInstantiationService,
    @IAcpChatWidgetService private readonly _widgets: IAcpChatWidgetService,
    @IWindowFocusService private readonly _windowFocus: IWindowFocusService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'triggerReveal', name: 'Triggers' })
  }

  revealOnRunStart(sessionId: string, showSession: boolean): void {
    if (!showSession) return
    if (!this.isWindowVisible()) {
      this._logger.debug(
        `showSession: window is hidden or minimized; leaving session ${sessionId} in the background`,
      )
      return
    }
    const session = this._sessions.getById(sessionId)
    const localId = session?.id ?? sessionId
    this._logger.debug(`showSession: revealing session ${localId}`)
    revealSessionChat(
      {
        groups: this._groups,
        inst: this._inst,
        widgets: this._widgets,
        windowFocus: this._windowFocus,
      },
      localId,
      session !== undefined ? { agentId: session.agentId } : undefined,
    )
  }

  /** Test seam: node tests have no workbench document to inspect. */
  protected isWindowVisible(): boolean {
    return isWorkbenchWindowVisible(currentWorkbenchDocumentOrUndefined())
  }
}

registerSingleton(
  ITriggerSessionRevealService,
  TriggerSessionRevealService,
  InstantiationType.Delayed,
)
