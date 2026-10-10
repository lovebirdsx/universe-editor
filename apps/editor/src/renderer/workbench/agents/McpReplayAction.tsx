/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  McpReplayAction — the "replay this MCP tool call" affordance on a tool-call card.
 *
 *  Sits in the card header, left of the elapsed-time badge. Hidden unless the call
 *  carries everything the debugger needs (an MCP server + tool + the recorded
 *  arguments); shown-but-disabled when the session cannot support a replay, so the
 *  feature does not look broken. The header is already a <button>, so this is a
 *  span acting as one — nesting a real button would be invalid HTML the browser
 *  silently re-parents.
 *--------------------------------------------------------------------------------------------*/

import { Play } from 'lucide-react'
import { INotificationService, Severity, localize } from '@universe-editor/platform'
import { useOptionalService } from '../useService.js'
import { IMcpDebugService } from '../../services/acp/mcp/mcpDebugService.js'
import type { AcpToolCall, IAcpSession } from '../../services/acp/session/acpSessionModel.js'
import styles from './agents.module.css'

export function McpReplayAction({
  call,
  session,
}: {
  call: AcpToolCall
  session?: IAcpSession | undefined
}) {
  // Optional on purpose: this is a per-card affordance, and a container without
  // the debugger (or without notifications) must render the chat normally with
  // the button simply absent, not throw from the hooks below.
  const service = useOptionalService(IMcpDebugService)
  const notifications = useOptionalService(INotificationService)

  if (service === undefined) return null
  if (call.mcpServer === undefined || call.mcpTool === undefined) return null
  // The memory budget releases `rawInput` with the rest of the heavy content;
  // there is nothing to replay without the recorded arguments.
  if (call.rawInput === undefined || call.memoryTrimmed === true) return null
  if (session === undefined) return null

  const blocked =
    session.authority !== undefined
      ? localize('mcpDebug.replay.remote', 'MCP replay is not available for remote workspaces yet.')
      : session.readOnly
        ? localize(
            'mcpDebug.replay.readOnly',
            'MCP replay is disabled on a read-only session preview.',
          )
        : undefined
  const label = localize('mcpDebug.replay.button', 'Replay this MCP tool call')

  const trigger = (): void => {
    if (blocked !== undefined) {
      notifications?.notify({ severity: Severity.Warning, message: blocked })
      return
    }
    void service.openFromToolCall(session, call)
  }

  return (
    <span
      className={styles['mcpReplayAction']}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-disabled={blocked !== undefined || undefined}
      data-tooltip={blocked ?? label}
      data-testid="acp-toolcall-mcp-replay"
      data-disabled={blocked !== undefined}
      onClick={(event) => {
        event.stopPropagation()
        trigger()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        trigger()
      }}
    >
      <Play size={14} strokeWidth={1.6} />
    </span>
  )
}
