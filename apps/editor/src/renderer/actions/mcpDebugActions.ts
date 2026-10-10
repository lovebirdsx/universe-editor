/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MCP debugger commands: the command-palette entry into the tool replay debugger.
 *  The card button is the primary entry — this one exists for keyboard users and
 *  for the case the card is out of reach (collapsed, scrolled away).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  INotificationService,
  Severity,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { IMcpDebugService } from '../services/acp/mcp/mcpDebugService.js'
import { CATEGORY } from './_agentShared.js'

export class OpenMcpDebuggerAction extends Action2 {
  static readonly ID = 'workbench.action.mcp.openDebugger'

  constructor() {
    super({
      id: OpenMcpDebuggerAction.ID,
      title: localize2('action.mcp.openDebugger', 'MCP: Debug Tool Call…'),
      category: CATEGORY,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    // Everything the async half needs is pulled synchronously: the accessor dies
    // at the first await.
    const sessions = accessor.get(IAcpSessionService)
    const debug = accessor.get(IMcpDebugService)
    const notifications = accessor.get(INotificationService)

    const session = sessions.activeSession.get()
    // Newest first: a debugging session almost always targets the call the user
    // just watched, not the session's earliest one.
    const call =
      session === undefined
        ? undefined
        : [...session.toolCalls.get()]
            .reverse()
            .find(
              (candidate) => candidate.mcpServer !== undefined && candidate.mcpTool !== undefined,
            )
    if (session === undefined || call === undefined) {
      notifications.notify({
        severity: Severity.Info,
        message: localize(
          'mcpDebug.noReplayableCall',
          'This session has no MCP tool call to replay.',
        ),
      })
      return
    }
    void debug.openFromToolCall(session, call)
  }
}
