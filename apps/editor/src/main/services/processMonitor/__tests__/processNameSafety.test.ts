/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/processMonitor/processNameSafety.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { redactProcessName } from '../processNameSafety.js'

describe('redactProcessName', () => {
  it('keeps the role names the registry produces', () => {
    expect(redactProcessName('window (window-4)')).toBe('window (window-4)')
    expect(redactProcessName('acp-agent (claude)')).toBe('acp-agent (claude)')
    expect(redactProcessName('electron-nodejs (bootstrap.js watcher.js)')).toBe(
      'electron-nodejs (bootstrap.js watcher.js)',
    )
    expect(redactProcessName('tsserver')).toBe('tsserver')
  })

  it('reduces command lines to their executable stem', () => {
    expect(redactProcessName('C:\\windows\\system32\\cmd.exe /d /s /c echo hi')).toBe('cmd.exe')
    expect(redactProcessName('"D:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo')).toBe(
      'pwsh.exe',
    )
    expect(redactProcessName('/usr/bin/zsh -l')).toBe('zsh')
  })

  it('never lets a credential survive in any argument shape', () => {
    for (const command of [
      'claude.exe -p token=ak-1',
      'cmd.exe /c set TOKEN=ak-1',
      'git.exe -c http.extraHeader=AUTH:ak-1',
      '--api-key=ak-1',
      'node.exe --mcp-config \'{"env":{"API_KEY":"ak-1"}}\'',
    ]) {
      expect(redactProcessName(command) ?? '').not.toContain('ak-1')
    }
  })

  it('drops the name rather than guessing when no executable is recoverable', () => {
    expect(redactProcessName('--api-key=ak-1')).toBeUndefined()
    expect(redactProcessName('')).toBeUndefined()
  })
})
