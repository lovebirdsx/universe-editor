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
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { revealSessionEditorTab } from '../services/acp/session/revealSessionEditorTab.js'

// Services revealChat / resolveTargetSession need, snapshotted while the accessor
// is still valid (i.e. before run's first await).
export interface RevealServices {
  readonly sessions: IAcpSessionService
  readonly registry: IAcpAgentRegistry
  readonly widgets: IAcpChatWidgetService
  readonly groups: IEditorGroupsService
  readonly inst: IInstantiationService
}

export function captureRevealServices(accessor: ServicesAccessor): RevealServices {
  return {
    sessions: accessor.get(IAcpSessionService),
    registry: accessor.get(IAcpAgentRegistry),
    widgets: accessor.get(IAcpChatWidgetService),
    groups: accessor.get(IEditorGroupsService),
    inst: accessor.get(IInstantiationService),
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
// the freshly-attached chips and can keep typing. Focus is best-effort (the
// widget may still be mounting; the inbox drain covers that case).
export async function revealChat(services: RevealServices, sessionId: string): Promise<void> {
  const { widgets, groups, inst, sessions } = services
  revealSessionEditorTab(groups, inst, sessionId, sessions.getById(sessionId))
  widgets.focusSessionInput(sessionId)
}
