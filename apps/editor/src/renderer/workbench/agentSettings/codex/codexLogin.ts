/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  runCodexLogin — opens the integrated terminal and runs `codex login`, the
 *  official Codex CLI's ChatGPT OAuth flow. That flow writes `~/.codex/auth.json`,
 *  which the built-in codex-acp adapter then reads.
 *
 *  Note: unlike Claude, the binary we download for the agent (the `codex-acp`
 *  adapter) has no `login` subcommand — OAuth login is owned by the official
 *  `codex` CLI. So this resolves `codex` from PATH rather than from
 *  ICodexBinaryService; the panel tells the user they need it installed.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { INotificationService, Severity, localize } from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
import { useService } from '../../useService.js'

export function runCodexLogin(): () => Promise<void> {
  const terminals = useService(ITerminalManagerService)
  const notification = useService(INotificationService)

  return useCallback(async () => {
    const id = await terminals.newTerminal({ target: 'panel' })
    if (!id) {
      notification.notify({
        severity: Severity.Error,
        message: localize('codexSettings.login.noTerminal', 'Could not open a terminal.'),
      })
      return
    }
    terminals.setActiveTerminal(id)
    terminals.focus()
    // Give the shell a beat to print its prompt before injecting the command.
    setTimeout(() => terminals.input(id, 'codex login\r'), 600)
  }, [terminals, notification])
}
