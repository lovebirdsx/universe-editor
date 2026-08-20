/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Unit tests for the bootstrap install seam and the Windows tree-kill seam.
 *  `installBundle` is driven with an injected NpmRunner (no real npm spawns) over
 *  a fake package-dir layout under tmp; `killProcessTree` is driven with an
 *  injected spawner so nothing real is killed.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWindowsDaemonLaunch, killProcessTree } from '../bootstrap.js'
import { installBundle, resolveNpmCliPath, type NpmRunner } from '../install.js'

const NPM_INSTALL_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund']
const VENDOR_INSTALL_ARGS = ['ci', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund']

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  )
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ue-install-'))
  tempDirs.push(dir)
  return dir
}

interface NpmCall {
  readonly args: string[]
  readonly cwd: string
}

function recordingRunner(results: Array<{ code: number | null; spawnError?: string }>): {
  runner: NpmRunner
  calls: NpmCall[]
} {
  const calls: NpmCall[] = []
  const runner: NpmRunner = async (args, options) => {
    calls.push({ args: [...args], cwd: options.cwd })
    return results.shift() ?? { code: 0 }
  }
  return { runner, calls }
}

describe('installBundle', () => {
  it('installs the package and existing vendor dirs, then writes bundle.hash verbatim', async () => {
    const pkgDir = await makeTempDir()
    // Only claude-agent-acp is staged; codex-acp must not be touched.
    await mkdir(path.join(pkgDir, 'vendor', 'claude-agent-acp'), { recursive: true })

    const { runner, calls } = recordingRunner([{ code: 0 }, { code: 0 }])
    await installBundle(pkgDir, 'deadbeef', runner)

    expect(calls).toEqual([
      { args: NPM_INSTALL_ARGS, cwd: pkgDir },
      {
        args: VENDOR_INSTALL_ARGS,
        cwd: path.join(pkgDir, 'vendor', 'claude-agent-acp'),
      },
    ])
    // printf %s semantics: no trailing newline, value untouched.
    expect(await readFile(path.join(pkgDir, 'bundle.hash'), 'utf8')).toBe('deadbeef')
  })

  it('writes no bundle.hash and reports the dir when npm install fails', async () => {
    const pkgDir = await makeTempDir()
    const { runner } = recordingRunner([{ code: 1 }])

    await expect(installBundle(pkgDir, 'deadbeef', runner)).rejects.toThrow(pkgDir)
    await expect(readFile(path.join(pkgDir, 'bundle.hash'), 'utf8')).rejects.toThrow()
  })

  it('writes no bundle.hash when a vendor ci fails', async () => {
    const pkgDir = await makeTempDir()
    await mkdir(path.join(pkgDir, 'vendor', 'claude-agent-acp'), { recursive: true })
    const { runner } = recordingRunner([{ code: 0 }, { code: 1 }])

    await expect(installBundle(pkgDir, 'deadbeef', runner)).rejects.toThrow(
      'vendor/claude-agent-acp',
    )
    await expect(readFile(path.join(pkgDir, 'bundle.hash'), 'utf8')).rejects.toThrow()
  })

  it('treats a spawn error as a failed install and writes no bundle.hash', async () => {
    const pkgDir = await makeTempDir()
    const { runner } = recordingRunner([{ code: null, spawnError: 'ENOENT' }])

    await expect(installBundle(pkgDir, 'deadbeef', runner)).rejects.toThrow('ENOENT')
    await expect(readFile(path.join(pkgDir, 'bundle.hash'), 'utf8')).rejects.toThrow()
  })
})

describe('resolveNpmCliPath', () => {
  it('resolves the node_modules/npm/bin layout on Windows', () => {
    const execPath = path.join('C:', 'Program Files', 'nodejs', 'node.exe')
    expect(resolveNpmCliPath(execPath, 'win32')).toBe(
      path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    )
  })

  it('resolves the ../lib/node_modules/npm/bin layout on POSIX', () => {
    const execPath = '/usr/local/bin/node'
    expect(resolveNpmCliPath(execPath, 'linux')).toBe(
      path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    )
  })
})

describe('killProcessTree', () => {
  it('invokes taskkill with /pid /t /f', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const spawner = async (command: string, args: readonly string[]): Promise<void> => {
      calls.push({ command, args: [...args] })
    }

    await killProcessTree(4242, spawner)

    expect(calls).toEqual([{ command: 'taskkill', args: ['/pid', '4242', '/t', '/f'] }])
  })
})

describe('buildWindowsDaemonLaunch', () => {
  function decodeScript(args: string[]): string {
    const encoded = args[args.indexOf('-EncodedCommand') + 1]!
    return Buffer.from(encoded, 'base64').toString('utf16le')
  }

  it('launches powershell with an encoded Win32_Process.Create script', () => {
    const launch = buildWindowsDaemonLaunch([
      'C:\\Users\\dev\\node\\node.exe',
      'C:\\Users\\dev\\srv\\bootstrap.js',
      'serve',
      '--data-dir',
      'C:\\Users\\dev\\.universe-editor-server',
    ])

    expect(launch.file.toLowerCase()).toContain('windowspowershell')
    expect(launch.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    const script = decodeScript(launch.args)
    expect(script).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create')
    expect(script).toContain(
      "CommandLine = 'C:\\Users\\dev\\node\\node.exe C:\\Users\\dev\\srv\\bootstrap.js serve --data-dir C:\\Users\\dev\\.universe-editor-server'",
    )
    expect(script).toContain('exit $r.ReturnValue')
  })

  it('double-quotes argv entries containing spaces', () => {
    const launch = buildWindowsDaemonLaunch([
      'C:\\Users\\a b\\node.exe',
      'C:\\Users\\a b\\bootstrap.js',
      'serve',
      '--data-dir',
      'C:\\Users\\a b\\.universe-editor-server',
    ])

    const script = decodeScript(launch.args)
    expect(script).toContain(
      'CommandLine = \'"C:\\Users\\a b\\node.exe" "C:\\Users\\a b\\bootstrap.js" serve --data-dir "C:\\Users\\a b\\.universe-editor-server"\'',
    )
  })
})
