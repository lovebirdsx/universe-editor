/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Subcommand tests for the daemon CLI. Each case spawns the real bundled
 *  bootstrap.js as a node child (data-dir under tmp) and drives it the way the
 *  editor's deploy path would: serve → check/start → stop. Teardown force-kills
 *  any process that survived so no daemon leaks past the suite.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { REMOTE_PROTOCOL_VERSION, type IRemoteDaemonInfo } from '@universe-editor/platform'
import { buildBootstrapBundle, type BuiltBootstrap } from './helpers/buildBootstrap.js'

const INFO_PREFIX = 'UNIVERSE_REMOTE_DAEMON_INFO='

let built: BuiltBootstrap
const trackedChildren: ChildProcess[] = []
const tempDirs: string[] = []

beforeAll(async () => {
  built = await buildBootstrapBundle()
}, 60_000)

afterAll(async () => {
  await built.dispose()
})

afterEach(async () => {
  for (const child of trackedChildren.splice(0)) {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  )
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ue-bootstrap-'))
  tempDirs.push(dir)
  return dir
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

interface RunResult {
  stdout: string
  stderr: string
  code: number
}

function runBootstrap(args: string[], dataDir: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [built.bootstrapPath, ...args, '--data-dir', dataDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    trackedChildren.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }))
  })
}

async function spawnServe(
  dataDir: string,
): Promise<{ child: ChildProcess; info: IRemoteDaemonInfo }> {
  const child = spawn(process.execPath, [built.bootstrapPath, 'serve', '--data-dir', dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  trackedChildren.push(child)

  const info = await new Promise<IRemoteDaemonInfo>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('serve did not emit info line')), 15_000)
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const line = buf.split('\n').find((l) => l.startsWith(INFO_PREFIX))
      if (line) {
        clearTimeout(timer)
        resolve(JSON.parse(line.slice(INFO_PREFIX.length)) as IRemoteDaemonInfo)
      }
    })
    child.stderr.on('data', () => {
      // diagnostics go to stderr; swallowed for test cleanliness
    })
    child.once('exit', (code) => reject(new Error(`serve exited early (${code})`)))
  })

  return { child, info }
}

function parseInfo(stdout: string): IRemoteDaemonInfo {
  const line = stdout.split('\n').find((l) => l.startsWith(INFO_PREFIX))
  if (!line) throw new Error(`no info line in stdout: ${stdout}`)
  return JSON.parse(line.slice(INFO_PREFIX.length)) as IRemoteDaemonInfo
}

describe('bootstrap subcommands', () => {
  it('serve writes server.json and prints the info line', async () => {
    const dataDir = await makeTempDir()
    const { child, info } = await spawnServe(dataDir)

    expect(info.protocolVersion).toBe(REMOTE_PROTOCOL_VERSION)
    expect(info.port).toBeGreaterThan(0)
    expect(info.token).toBeTruthy()
    expect(info.pid).toBe(child.pid)

    const serverJson = JSON.parse(
      await readFile(path.join(dataDir, 'server.json'), 'utf8'),
    ) as IRemoteDaemonInfo
    expect(serverJson.port).toBe(info.port)
    expect(serverJson.token).toBe(info.token)

    child.kill('SIGTERM')
    await waitForExit(child)
  }, 30_000)

  it('check succeeds against a running daemon and fails with exit 3 otherwise', async () => {
    const dataDir = await makeTempDir()

    const missing = await runBootstrap(['check'], dataDir)
    expect(missing.code).toBe(3)
    expect(missing.stderr).toContain('not-running')

    const { child } = await spawnServe(dataDir)
    const hit = await runBootstrap(['check'], dataDir)
    expect(hit.code).toBe(0)
    expect(parseInfo(hit.stdout).port).toBeGreaterThan(0)

    child.kill('SIGTERM')
    await waitForExit(child)
  }, 30_000)

  it('check prints the bundle hash line even when the daemon is not running', async () => {
    const dataDir = await makeTempDir()
    const missing = await runBootstrap(['check'], dataDir)
    expect(missing.code).toBe(3)
    expect(missing.stdout).toContain('UNIVERSE_REMOTE_BUNDLE_HASH=\n')
  }, 30_000)

  it('check reports the bundle hash recorded next to bootstrap.js', async () => {
    const bundleDir = path.dirname(built.bootstrapPath)
    const hashPath = path.join(bundleDir, 'bundle.hash')
    await writeFile(hashPath, '  deadbeef  \n')
    try {
      const dataDir = await makeTempDir()
      const result = await runBootstrap(['check'], dataDir)
      expect(result.code).toBe(3)
      expect(result.stdout).toContain('UNIVERSE_REMOTE_BUNDLE_HASH=deadbeef\n')
    } finally {
      await rm(hashPath, { force: true })
    }
  }, 30_000)

  it('stop stops a running daemon and cleans server.json/lock', async () => {
    const dataDir = await makeTempDir()
    const { child, info } = await spawnServe(dataDir)

    const result = await runBootstrap(['stop'], dataDir)
    expect(result.code).toBe(0)
    await waitForExit(child)

    await expect(readFile(path.join(dataDir, 'server.json'), 'utf8')).rejects.toThrow()
    await expect(readFile(path.join(dataDir, 'daemon.lock'), 'utf8')).rejects.toThrow()
    expect(isAlive(info.pid)).toBe(false)

    // Stopping an already-stopped daemon is a success no-op.
    const again = await runBootstrap(['stop'], dataDir)
    expect(again.code).toBe(0)
  }, 30_000)

  it('start detached-spawns serve and check then reports a live pid', async () => {
    const dataDir = await makeTempDir()

    const started = await runBootstrap(['start'], dataDir)
    expect(started.code).toBe(0)
    const info = parseInfo(started.stdout)
    expect(info.port).toBeGreaterThan(0)

    // Give the detached child a moment to be reachable, then verify + stop.
    const hit = await runBootstrap(['check'], dataDir)
    expect(hit.code).toBe(0)
    expect(parseInfo(hit.stdout).pid).toBe(info.pid)

    const stopped = await runBootstrap(['stop'], dataDir)
    expect(stopped.code).toBe(0)
    expect(isAlive(info.pid)).toBe(false)
  }, 30_000)
})
