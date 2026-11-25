import { describe, expect, it } from 'vitest'
import {
  isShellControlStroke,
  isTerminalSkipShellCommand,
  TERMINAL_SKIP_SHELL_COMMANDS,
  type ITerminalKeyStroke,
} from '../terminalKeyRouting.js'

function makeStroke(
  key: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>> = {},
): ITerminalKeyStroke {
  return {
    key,
    ctrlKey: mods.ctrlKey ?? true,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  }
}

describe('isShellControlStroke', () => {
  it.each(['j', 'k', 's', 'f', 'b', 'z'])('treats Ctrl+%s as a shell control stroke', (key) => {
    expect(isShellControlStroke(makeStroke(key))).toBe(true)
  })

  it('rejects strokes with Shift, Alt or Meta', () => {
    expect(isShellControlStroke(makeStroke('p', { shiftKey: true }))).toBe(false)
    expect(isShellControlStroke(makeStroke('j', { altKey: true }))).toBe(false)
    expect(isShellControlStroke(makeStroke('j', { metaKey: true }))).toBe(false)
  })

  it('rejects strokes without Ctrl', () => {
    expect(isShellControlStroke(makeStroke('j', { ctrlKey: false }))).toBe(false)
  })

  it.each(['=', '-', '0', ',', '`', ' ', 'space', 'Tab', 'Enter', ''])(
    'rejects non-letter key %j',
    (key) => {
      expect(isShellControlStroke(makeStroke(key))).toBe(false)
    },
  )
})

describe('isTerminalSkipShellCommand', () => {
  it('keeps terminal commands in the workbench', () => {
    expect(isTerminalSkipShellCommand('workbench.action.terminal.focus')).toBe(true)
    expect(isTerminalSkipShellCommand('workbench.action.terminal.new')).toBe(true)
  })

  it('keeps explicitly allowlisted commands in the workbench', () => {
    expect(isTerminalSkipShellCommand('workbench.action.showCommands')).toBe(true)
    expect(isTerminalSkipShellCommand('workbench.action.openSettings')).toBe(true)
    expect(isTerminalSkipShellCommand('workbench.action.createTerminalEditor')).toBe(true)
  })

  it('routes ordinary workbench commands to the shell', () => {
    expect(isTerminalSkipShellCommand('workbench.action.togglePanel')).toBe(false)
    expect(isTerminalSkipShellCommand('workbench.action.files.save')).toBe(false)
    expect(isTerminalSkipShellCommand('')).toBe(false)
  })

  it('exposes the allowlist as the single source of truth', () => {
    expect(TERMINAL_SKIP_SHELL_COMMANDS.has('workbench.action.showCommands')).toBe(true)
    expect(TERMINAL_SKIP_SHELL_COMMANDS.has('workbench.action.togglePanel')).toBe(false)
  })
})
