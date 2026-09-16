/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Put a session's chat in front of the user: reveal its editor tab (wherever it
 *  already lives) and hand the chat input the keyboard focus.
 *
 *  Why not just IEditorService.openEditor: its dedup covers only the active
 *  group, so a session tab sitting in another group would be duplicated; and
 *  with the tab already active it re-activates in place but never pulls focus
 *  into the chat input. Both jobs belong to whoever means "bring me here",
 *  so they live together here. See revealSessionEditorTab for the tab half.
 *
 *  `sessionId` is the LOCAL id (AcpSession.id): tabs opened in this run and the
 *  chat widget registry (ChatBody) are both keyed by it. A tab restored from a
 *  previous run carries the durable id instead, and AcpSessionEditorInput.focus
 *  resolves that back to the local id on its own.
 *--------------------------------------------------------------------------------------------*/

import { IEditorGroupsService, IInstantiationService } from '@universe-editor/platform'
import { revealSessionEditorTab } from './revealSessionEditorTab.js'
import { IAcpChatWidgetService } from './acpChatWidgetService.js'

export interface RevealSessionChatTarget {
  readonly groups: IEditorGroupsService
  readonly inst: IInstantiationService
  readonly widgets: IAcpChatWidgetService
}

export function revealSessionChat(
  target: RevealSessionChatTarget,
  sessionId: string,
  live: { readonly agentId: string | undefined } | undefined,
): void {
  revealSessionEditorTab(target.groups, target.inst, sessionId, live)
  target.widgets.focusSessionInput(sessionId)
  // Second pass on the next frame: activating a group or opening the tab makes
  // the chat mount on this frame, so the first call can find no widget yet.
  requestAnimationFrame(() => target.widgets.focusSessionInput(sessionId))
}
