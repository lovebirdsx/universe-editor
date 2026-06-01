/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  McpServersView — the "MCP Servers" view in the AGENTS container. Shows the
 *  active session's configured + connected MCP servers: name, transport, live
 *  connection status (from the Claude SDK system-init snapshot) and per-server
 *  tool-call counts derived from the timeline. Empty when no session is active
 *  or no MCP servers are involved; offers a shortcut to the settings.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { IAcpSessionService, type IAcpSession } from '../../services/acp/acpSessionService.js'
import styles from './agents.module.css'

export function McpServersView() {
  const service = useService(IAcpSessionService)
  const session = useObservable(service.activeSession)
  if (!session) {
    return <McpEmpty hint={localize('acp.mcp.noSession', 'No active agent session.')} />
  }
  return <McpServerList session={session} />
}

function McpServerList({ session }: { session: IAcpSession }) {
  const servers = useObservable(session.mcpServers)
  const toolCalls = useObservable(session.toolCalls)
  if (servers.length === 0) {
    return (
      <McpEmpty hint={localize('acp.mcp.none', 'No MCP servers configured for this session.')} />
    )
  }
  const counts = new Map<string, { total: number; failed: number }>()
  for (const t of toolCalls) {
    if (t.mcpServer === undefined) continue
    const c = counts.get(t.mcpServer) ?? { total: 0, failed: 0 }
    c.total += 1
    if (t.status === 'failed') c.failed += 1
    counts.set(t.mcpServer, c)
  }
  return (
    <div className={styles['mcpView']} data-testid="acp-mcp-view">
      <ul className={styles['mcpList']}>
        {servers.map((s) => {
          const c = counts.get(s.name)
          return (
            <li
              key={s.name}
              className={styles['mcpRow']}
              data-status={s.status}
              data-testid="acp-mcp-row"
            >
              <span className={styles['mcpStatusDot']} aria-hidden="true" />
              <span className={styles['mcpRowMain']}>
                <span className={styles['mcpName']}>{s.name}</span>
                <span className={styles['mcpMeta']}>
                  {s.transport && <span className={styles['mcpTransport']}>{s.transport}</span>}
                  {c && (
                    <span className={styles['mcpCount']}>
                      {c.failed > 0 ? `${c.total} calls · ${c.failed} failed` : `${c.total} calls`}
                    </span>
                  )}
                </span>
              </span>
              <span className={styles['mcpStatusLabel']}>{s.status}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function McpEmpty({ hint }: { hint: string }) {
  const commands = useService(ICommandService)
  return (
    <div className={styles['emptyChat']} data-testid="acp-mcp-empty">
      <span>{hint}</span>
      <button
        type="button"
        className={styles['sessionRetryButton']}
        onClick={() => void commands.executeCommand('workbench.action.agent.openMcpSettings')}
      >
        {localize('acp.mcp.openSettings', 'Configure MCP servers')}
      </button>
    </div>
  )
}
