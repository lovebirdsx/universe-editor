// Plain Ctrl+<letter> is a C0 control character for the shell (Ctrl+J = LF,
// Ctrl+K = VT, Ctrl+W = kill-word). The integrated terminal owns those strokes,
// matching VSCode. Ctrl+Shift/Alt/Meta and non-letter keys keep the workbench
// path, so the command palette, zoom, settings and terminal commands still work.
//
// TERMINAL_SKIP_SHELL_COMMANDS is the escape hatch for commands that must stay
// reachable inside the terminal (VSCode's commandsToSkipShell intent).

export interface ITerminalKeyStroke {
  readonly key: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

export const TERMINAL_SKIP_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'workbench.action.showCommands',
  'workbench.action.openSettings',
  'workbench.action.quickOpenRecentEditor',
  'workbench.action.quickOpenRecentEditorReverse',
  'workbench.action.createTerminalEditor',
])

export function isTerminalSkipShellCommand(command: string): boolean {
  return (
    command.startsWith('workbench.action.terminal.') || TERMINAL_SKIP_SHELL_COMMANDS.has(command)
  )
}

export function isShellControlStroke(stroke: ITerminalKeyStroke): boolean {
  return (
    stroke.ctrlKey &&
    !stroke.altKey &&
    !stroke.metaKey &&
    !stroke.shiftKey &&
    /^[a-z]$/i.test(stroke.key)
  )
}
