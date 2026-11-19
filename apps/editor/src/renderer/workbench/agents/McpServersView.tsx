/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  McpServersView — the "MCP Servers" view in the Sessions container. Shows the
 *  active session's configured + connected MCP servers: name, transport, live
 *  connection status (claude: SDK system-init snapshot; codex: the fork's
 *  _universe/mcp_server_status startup notification) and per-server tool-call
 *  counts derived from the timeline. Empty when no session is active
 *  or no MCP servers are involved; offers a shortcut to the settings.
 *--------------------------------------------------------------------------------------------*/

import { useRef, useState } from 'react'
import { ICommandService, localize, runWithInvocationModifiers } from '@universe-editor/platform'
import { useFlatListNavigation } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
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
  const commands = useService(ICommandService)
  const listRef = useRef<HTMLUListElement | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const activeIndex = Math.min(focusedIndex, Math.max(0, servers.length - 1))

  // Rows carry no per-server action; Enter mirrors the empty-state shortcut and
  // opens the MCP settings form. j/k still works on a configured-but-inert list.
  const nav = useFlatListNavigation({
    count: servers.length,
    focusedIndex: activeIndex,
    onFocusChange: setFocusedIndex,
    getItemKey: (index) => servers[index]?.name ?? '',
    getContainer: () => listRef.current,
    ariaLabel: localize('acp.mcp.list', 'MCP servers'),
    onActivate: () => {
      void commands.executeCommand('workbench.action.agent.openMcpSettings')
    },
    vimSurfaceId: 'mcp-servers',
  })

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
      <ul ref={listRef} className={styles['mcpList']} {...nav.containerProps}>
        {servers.map((s, index) => {
          const c = counts.get(s.name)
          return (
            <li
              key={s.name}
              {...nav.getRowProps(index)}
              className={styles['mcpRow']}
              data-status={s.status}
              data-testid="acp-mcp-row"
              style={
                index === activeIndex
                  ? { background: 'var(--vscode-list-activeSelectionBackground, #094771)' }
                  : undefined
              }
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
        onClick={(e) =>
          void runWithInvocationModifiers(e, () =>
            commands.executeCommand('workbench.action.agent.openMcpSettings'),
          )
        }
      >
        {localize('acp.mcp.openSettings', 'Configure MCP servers')}
      </button>
    </div>
  )
}
