/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for packages/node-services/src/process/cmdSpawn.ts
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { effectiveTempRoot, flushTempDirs, mkTempDir } from '@universe-editor/temp-root'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCmdCommandLine, quoteCmdArg, spawnViaCmd } from '../cmdSpawn.js'

describe('quoteCmdArg', () => {
  it('wraps plain tokens in quotes', () => {
    expect(quoteCmdArg('code')).toBe('"code"')
  })

  it('keeps spaces literal inside quotes', () => {
    expect(quoteCmdArg('C:\\Program Files\\app\\tool.cmd')).toBe(
      '"C:\\Program Files\\app\\tool.cmd"',
    )
  })

  it('doubles embedded quotes', () => {
    expect(quoteCmdArg('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes the empty string so it survives as an argument', () => {
    expect(quoteCmdArg('')).toBe('""')
  })

  it('treats shell metacharacters as literal inside quotes', () => {
    expect(quoteCmdArg('a&b|c>d^e')).toBe('"a&b|c>d^e"')
  })
})

describe('buildCmdCommandLine', () => {
  it('leaves a bare command name unquoted so the line cannot hit /s stripping', () => {
    expect(buildCmdCommandLine('code', ['file.txt'])).toBe('code "file.txt"')
  })

  it('quotes each arg independently', () => {
    expect(buildCmdCommandLine('npx', ['-y', 'some agent', 'say "hi"'])).toBe(
      'npx "-y" "some agent" "say ""hi"""',
    )
  })

  it('handles a command without args', () => {
    expect(buildCmdCommandLine('code', [])).toBe('code')
  })

  it('keeps the outer-quoted form when the command name contains spaces', () => {
    expect(buildCmdCommandLine('C:\\Program Files\\app\\tool.exe', ['a b'])).toBe(
      '""C:\\Program Files\\app\\tool.exe" "a b""',
    )
  })
})

/**
 * The string assertions above cannot catch the failure these tests cover.
 * When the assembled line takes the outer-quoted `/s` form, cmd strips those
 * quotes and then resolves a *bare* command name from PATH with `%0` set to
 * that bare name — no directory part, so the shim's `%~dp0` expands to the
 * *cwd* instead of its own directory. The shim then fails to find the sibling
 * file it launches: `code.cmd` → `Code.exe` exits 9009, silently, because the
 * wrapper's own spawn already succeeded.
 *
 * An absolute command path is immune (its `%0` carries the directory), so the
 * bare-name form — the one every call site uses — is what has to be exercised.
 */
const tempRootIsSpaceless = !/\s/.test(effectiveTempRoot())

describe('spawnViaCmd (.cmd shim resolution)', () => {
  afterEach(() => {
    flushTempDirs()
  })

  const runCapture = (
    command: string,
    cwd: string,
    shimDir: string,
  ): Promise<{ code: number | null; stdout: string }> =>
    new Promise((resolve, reject) => {
      const child = spawnViaCmd(command, [], {
        cwd,
        env: { ...process.env, PATH: `${shimDir};${process.env['PATH'] ?? ''}` },
      })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout }))
    })

  it.runIf(tempRootIsSpaceless)(
    'resolves a bare name with %~dp0 at the shim directory',
    async () => {
      const shimDir = mkTempDir('cmdspawn-shim-')
      const otherCwd = mkTempDir('cmdspawn-cwd-')
      writeFileSync(join(shimDir, 'probe.cmd'), '@echo off\r\necho %~dp0\r\n')

      const { code, stdout } = await runCapture('probe.cmd', otherCwd, shimDir)

      expect(code).toBe(0)
      expect(stdout.trim().replace(/[\\/]+$/, '')).toBe(shimDir)
    },
  )

  it.runIf(tempRootIsSpaceless)('lets a bare-name shim reach a file next to it', async () => {
    const shimDir = mkTempDir('cmdspawn-sibling-')
    const otherCwd = mkTempDir('cmdspawn-sibling-cwd-')
    writeFileSync(join(shimDir, 'sibling.txt'), 'ok')
    writeFileSync(
      join(shimDir, 'probe.cmd'),
      '@echo off\r\nif exist "%~dp0sibling.txt" (echo FOUND) else (echo MISSING)\r\n',
    )

    const { code, stdout } = await runCapture('probe.cmd', otherCwd, shimDir)

    expect(code).toBe(0)
    expect(stdout.trim()).toBe('FOUND')
  })

  it.runIf(tempRootIsSpaceless)('still resolves an absolute shim path', async () => {
    const shimDir = mkTempDir('cmdspawn-abs-')
    const otherCwd = mkTempDir('cmdspawn-abs-cwd-')
    writeFileSync(join(shimDir, 'probe.cmd'), '@echo off\r\necho %~dp0\r\n')

    const { code, stdout } = await runCapture(join(shimDir, 'probe.cmd'), otherCwd, shimDir)

    expect(code).toBe(0)
    expect(stdout.trim().replace(/[\\/]+$/, '')).toBe(shimDir)
  })
})
