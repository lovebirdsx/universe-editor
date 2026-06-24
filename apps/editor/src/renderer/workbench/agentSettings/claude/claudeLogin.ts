/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  runClaudeLogin — opens the integrated terminal and runs the Claude CLI login
 *  flow there. The native binary is resolved (downloaded on first use) through
 *  IClaudeBinaryService, the same one the agent uses, so login and the agent
 *  share one binary and one `~/.claude` credential store.
 *
 *  The binary is spawned directly as the terminal's PTY process (not via a shell
 *  with an injected command string). This sidesteps per-shell quoting rules —
 *  notably PowerShell, which rejects a bare quoted path ("…\claude.exe" auth …)
 *  and requires the `&` call operator — and means a spawn failure surfaces in the
 *  visible terminal instead of being swallowed by the shell.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import {
  IConfigurationService,
  ILayoutService,
  INotificationService,
  IViewsService,
  PartId,
  Severity,
  localize,
} from '@universe-editor/platform'
import {
  IClaudeBinaryService,
  type ClaudeBinarySource,
} from '../../../../shared/ipc/claudeBinaryService.js'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
import { useService } from '../../useService.js'

export type ClaudeLoginKind = 'claudeai' | 'console'

const TERMINAL_CONTAINER_ID = 'workbench.view.terminal'

export function runClaudeLogin(): (kind: ClaudeLoginKind) => Promise<void> {
  const binary = useService(IClaudeBinaryService)
  const terminals = useService(ITerminalManagerService)
  const notification = useService(INotificationService)
  const config = useService(IConfigurationService)
  const layout = useService(ILayoutService)
  const views = useService(IViewsService)

  return useCallback(
    async (kind: ClaudeLoginKind) => {
      let binPath: string
      try {
        const source = (config.get<string>('acp.claude.source') ?? 'download') as ClaudeBinarySource
        const customPath = config.get<string>('acp.claude.executablePath') ?? ''
        const opts = source === 'custom' ? { source, customPath } : { source }
        notification.notify({
          severity: Severity.Info,
          message: localize('agentSettings.login.preparing', 'Preparing Claude…'),
        })
        const result = await binary.resolve(opts)
        binPath = result.path
      } catch (err) {
        notification.notify({
          severity: Severity.Error,
          message: localize('agentSettings.login.binFailed', 'Failed to prepare Claude: {error}', {
            error: (err as Error).message,
          }),
        })
        return
      }

      const flag = kind === 'console' ? '--console' : '--claudeai'
      // Reveal the panel and switch to the Terminal container before spawning;
      // newTerminal alone creates the terminal but does not surface the panel.
      if (!layout.getVisible(PartId.Panel)) layout.setVisible(PartId.Panel, true)
      views.openViewContainer(TERMINAL_CONTAINER_ID)
      // Spawn the binary as the terminal process itself, so the integrated PTY
      // runs claude.exe directly with argv — no shell, no quoting pitfalls.
      const id = await terminals.newTerminal({
        target: 'panel',
        shell: binPath,
        shellArgs: ['auth', 'login', flag],
      })
      if (!id) {
        notification.notify({
          severity: Severity.Error,
          message: localize('agentSettings.login.noTerminal', 'Could not open a terminal.'),
        })
        return
      }
      terminals.setActiveTerminal(id)
      terminals.focus()
    },
    [binary, terminals, notification, config, layout, views],
  )
}
