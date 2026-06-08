/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/claudeBinary/claudeBinaryMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectClaudeExecutable } from '../claudeBinaryMainService.js'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app', getPath: () => tmpdir() },
}))

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'universe-editor-claude-bin-'))
  tempDirs.push(dir)
  return dir
}

async function createNpmClaudeInstall(): Promise<{
  readonly prefix: string
  readonly shellShim: string
  readonly cmdShim: string
  readonly native: string
}> {
  const prefix = await makeTempDir()
  const nativeDir = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
  await mkdir(nativeDir, { recursive: true })

  const shellShim = path.join(prefix, 'claude')
  const cmdShim = path.join(prefix, 'claude.cmd')
  const native = path.join(nativeDir, 'claude.exe')

  await writeFile(
    shellShim,
    '#!/bin/sh\nexec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"\n',
  )
  await writeFile(
    cmdShim,
    '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
  )
  await writeFile(native, 'MZ')

  return { prefix, shellShim, cmdShim, native }
}

describe('selectClaudeExecutable', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('resolves a Windows npm shell shim to the package native claude.exe', async () => {
    const install = await createNpmClaudeInstall()

    await expect(
      selectClaudeExecutable([install.shellShim, install.cmdShim], 'win32'),
    ).resolves.toBe(install.native)
  })

  it('returns a Windows native executable candidate directly', async () => {
    const install = await createNpmClaudeInstall()

    await expect(
      selectClaudeExecutable([install.native, install.shellShim], 'win32'),
    ).resolves.toBe(install.native)
  })

  it('rejects Windows shims when the package native binary is missing', async () => {
    const dir = await makeTempDir()
    const shellShim = path.join(dir, 'claude')
    const cmdShim = path.join(dir, 'claude.cmd')
    await writeFile(shellShim, '#!/bin/sh\n')
    await writeFile(cmdShim, '@ECHO off\r\n')

    await expect(selectClaudeExecutable([shellShim, cmdShim], 'win32')).resolves.toBeNull()
  })

  it('returns the first candidate on non-Windows platforms', async () => {
    await expect(
      selectClaudeExecutable([' /usr/local/bin/claude ', '/other'], 'linux'),
    ).resolves.toBe('/usr/local/bin/claude')
  })
})
