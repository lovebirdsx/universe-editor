/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared "resolve the target agent chat and reveal it" helpers for
 *  agent-facing entry points (Action2 runs, monaco code-action commands, ...).
 *  Action2 callers snapshot the accessor via captureRevealServices before
 *  their first await; non-action callers (contributions) hand-build the same
 *  RevealServices from constructor-injected services.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroupsService,
  IInstantiationService,
  ILayoutService,
  IViewsService,
  PartId,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { IAcpChatLocationService } from '../services/acp/session/acpChatLocationService.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { revealSessionEditorTab } from '../services/acp/session/revealSessionEditorTab.js'

// Services revealChat / resolveTargetSession need, snapshotted while the accessor
// is still valid (i.e. before run's first await).
export interface RevealServices {
  readonly sessions: IAcpSessionService
  readonly registry: IAcpAgentRegistry
  readonly location: IAcpChatLocationService
  readonly widgets: IAcpChatWidgetService
  readonly groups: IEditorGroupsService
  readonly inst: IInstantiationService
  readonly layout: ILayoutService
  readonly views: IViewsService
}

export function captureRevealServices(accessor: ServicesAccessor): RevealServices {
  return {
    sessions: accessor.get(IAcpSessionService),
    registry: accessor.get(IAcpAgentRegistry),
    location: accessor.get(IAcpChatLocationService),
    widgets: accessor.get(IAcpChatWidgetService),
    groups: accessor.get(IEditorGroupsService),
    inst: accessor.get(IInstantiationService),
    layout: accessor.get(ILayoutService),
    views: accessor.get(IViewsService),
  }
}

// Resolve the target session up front: the active one, else create a fresh
// session so the context always has a home even from a cold start.
export async function resolveTargetSession(services: RevealServices) {
  const active = services.sessions.activeSession.get()
  if (active) return active
  return services.sessions.createSession(services.registry.defaultAgentId())
}

// Make the target session's chat visible and focus its input so the user sees
// the freshly-attached chips and can keep typing. Editor mode → open the session
// as a tab; sidebar mode → surface the Sessions view. Focus is best-effort (the
// widget may still be mounting; the inbox drain covers that case).
export async function revealChat(services: RevealServices, sessionId: string): Promise<void> {
  const { location, widgets, groups, inst, layout, views, sessions } = services
  if (location.location.get() === 'editor') {
    revealSessionEditorTab(groups, inst, sessionId, sessions.getById(sessionId))
  } else {
    if (!layout.getVisible(PartId.SecondarySideBar)) layout.toggleVisible(PartId.SecondarySideBar)
    await views.openViewContainer('workbench.view.sessions')
  }
  widgets.focusSessionInput(sessionId)
}
