/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiStatusContribution — the single AI status-bar entry. Registers a `componentKey`
 *  entry resolved by the renderer to AiStatusBarItem (a sparkle button + quick-settings
 *  popover). Replaces the former AiModel / InlineCompletion / Agents status entries.
 *  The tooltip still surfaces the ACP MCP server summary, mirroring the old Agents entry.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStatusBarService,
  IWorkbenchContribution,
  StatusBarAlignment,
  autorun,
  localize,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'

export class AiStatusContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IStatusBarService statusBar: IStatusBarService,
    @IAcpSessionService sessions: IAcpSessionService,
  ) {
    super()
    const baseTooltip = localize('ai.statusbar.tooltip', 'AI')
    const base: Parameters<IStatusBarService['addEntry']>[0] = {
      text: '',
      icon: 'sparkle',
      componentKey: 'statusbar.ai',
      tooltip: baseTooltip,
      alignment: StatusBarAlignment.Right,
      priority: 50,
    }
    const entry = statusBar.addEntry(base)
    this._register({ dispose: () => entry.dispose() })
    this._register(
      autorun((r) => {
        const active = sessions.activeSession.read(r)
        const servers = active ? active.mcpServers.read(r) : []
        entry.update({ ...base, tooltip: mcpTooltip(baseTooltip, servers) })
      }),
    )
  }
}

/** Single-line MCP status summary appended to the AI status-bar tooltip. */
function mcpTooltip(base: string, servers: readonly { status: string }[]): string {
  if (servers.length === 0) return base
  const connected = servers.filter((s) => s.status === 'connected').length
  const summary = `MCP ${connected}/${servers.length} connected`
  const failed = servers.filter((s) => s.status !== 'connected' && s.status !== 'pending').length
  return failed > 0 ? `${base} · ${summary}, ${failed} failed` : `${base} · ${summary}`
}
