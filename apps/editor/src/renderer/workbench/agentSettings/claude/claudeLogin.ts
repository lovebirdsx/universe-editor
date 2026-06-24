/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  runClaudeLogin — opens the integrated terminal and runs the Claude CLI login
 *  flow there. The native binary is resolved (downloaded on first use) through
 *  IClaudeBinaryService, the same one the agent uses, so login and the agent
 *  share one binary and one `~/.claude` credential store.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import {
  IConfigurationService,
  INotificationService,
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

/** Quote a path for the platform shell so spaces in userData paths survive. */
function quoteArg(value: string): string {
  if (!/\s/.test(value)) return value
  // Both PowerShell and POSIX shells accept double quotes; embedded quotes are rare here.
  return `"${value}"`
}

export function runClaudeLogin(): (kind: ClaudeLoginKind) => Promise<void> {
  const binary = useService(IClaudeBinaryService)
  const terminals = useService(ITerminalManagerService)
  const notification = useService(INotificationService)
  const config = useService(IConfigurationService)

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
      const id = await terminals.newTerminal({ target: 'panel' })
      if (!id) {
        notification.notify({
          severity: Severity.Error,
          message: localize('agentSettings.login.noTerminal', 'Could not open a terminal.'),
        })
        return
      }
      terminals.setActiveTerminal(id)
      terminals.focus()
      // Give the shell a beat to print its prompt before injecting the command.
      const command = `${quoteArg(binPath)} auth login ${flag}\r`
      setTimeout(() => terminals.input(id, command), 600)
    },
    [binary, terminals, notification, config],
  )
}
