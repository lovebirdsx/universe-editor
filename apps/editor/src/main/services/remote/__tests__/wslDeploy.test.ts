/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/remote/wslDeploy.ts and the shared
 *  check-result classification in remoteDeploy.ts. The upload path pipes a real
 *  file (written by the fake tar runner) into a fake wsl.exe process's stdin.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NODE_RUNTIME_VERSION,
  buildCheckCommand,
  buildDeployRemoteScript,
  buildDeployScriptBody,
  buildNodeInstallScriptBody,
  buildStartCommand,
  buildStopCommand,
  buildUnameCommand,
  classifyCheckResult,
  computeBundleHash,
  type NodeArchiveFetcher,
  type RemoteRunner,
  type RemoteSpawner,
} from '../remoteDeploy.js'
import { WslDeployer, stripWslNuls, wslCommandArgs } from '../wslDeploy.js'

const WSL_EXE = 'C:\\Windows\\System32\\wsl.exe'
const NODE_PATH_PRELUDE = `PATH="$PATH:$HOME/.universe-editor-server/node/v24.19.0/bin"; `

function utf16Nulled(text: string): string {
  return [...text].map((c) => `${c}\0`).join('')
}

describe('wslCommandArgs', () => {
  it('builds -d <distro> -e bash -lc <command> (argv passthrough, no shell wrap)', () => {
    expect(wslCommandArgs('Ubuntu', buildCheckCommand('0.0.0'))).toEqual([
      '-d',
      'Ubuntu',
      '-e',
      'bash',
      '-lc',
      `${NODE_PATH_PRELUDE}command -v node >/dev/null 2>&1 || exit 40; node ~/.universe-editor-server/0.0.0/bootstrap.js check`,
    ])
    expect(wslCommandArgs('Ubuntu', buildStartCommand('1.2.3'))[5]).toBe(
      `${NODE_PATH_PRELUDE}node ~/.universe-editor-server/1.2.3/bootstrap.js start`,
    )
    expect(wslCommandArgs('Ubuntu', buildStopCommand('1.2.3'))[5]).toBe(
      `${NODE_PATH_PRELUDE}node ~/.universe-editor-server/1.2.3/bootstrap.js stop`,
    )
  })
})

describe('buildDeployScriptBody', () => {
  it('is the unwrapped body of the ssh deploy script', () => {
    const body = buildDeployScriptBody('0.0.0', 'u.tgz', 'deadbeef')
    expect(body.startsWith(NODE_PATH_PRELUDE + 'mkdir -p ~/.universe-editor-server/0.0.0')).toBe(
      true,
    )
    expect(body).not.toContain('sh -c')
    expect(buildDeployRemoteScript('0.0.0', 'u.tgz', 'deadbeef')).toBe(`sh -c '${body}'`)
  })

  it('delegates dependency install to install.js without breaking the outer single quotes', () => {
    const body = buildDeployScriptBody('0.0.0', 'u.tgz', 'deadbeef')
    expect(body).toContain('node ~/.universe-editor-server/0.0.0/install.js --bundle-hash deadbeef')
    expect(body).not.toContain("'")
  })
})

describe('classifyCheckResult', () => {
  it('classifies an info line as running', () => {
    const stdout = `UNIVERSE_REMOTE_DAEMON_INFO={"serverVersion":"0.0.0","protocolVersion":2,"port":9,"token":"t","pid":1}\n`
    const result = classifyCheckResult({ code: 0, stdout, stderr: '' }, 'wsl')
    expect(result.state).toBe('running')
  })

  it('classifies exit 3 as not-running', () => {
    expect(classifyCheckResult({ code: 3, stdout: '', stderr: '' }, 'wsl')).toEqual({
      state: 'not-running',
    })
  })

  it('classifies spawn errors, exit 127 and not-found stderr as not-deployed', () => {
    expect(
      classifyCheckResult({ code: null, spawnError: 'ENOENT ssh', stdout: '', stderr: '' }, 'ssh')
        .state,
    ).toBe('not-deployed')
    expect(classifyCheckResult({ code: 127, stdout: '', stderr: '' }, 'wsl').state).toBe(
      'not-deployed',
    )
    expect(
      classifyCheckResult({ code: 1, stdout: '', stderr: 'bash: node: command not found' }, 'wsl')
        .state,
    ).toBe('not-deployed')
  })

  it('labels the fallback error message with the transport', () => {
    expect(classifyCheckResult({ code: 1, stdout: '', stderr: '' }, 'ssh')).toEqual({
      state: 'error',
      message: 'ssh check failed (exit 1)',
    })
    expect(classifyCheckResult({ code: 1, stdout: '', stderr: '' }, 'wsl')).toEqual({
      state: 'error',
      message: 'wsl check failed (exit 1)',
    })
  })
})

describe('stripWslNuls', () => {
  it('removes interleaved NULs from utf16-as-utf8 output', () => {
    expect(stripWslNuls(utf16Nulled('no such distribution'))).toBe('no such distribution')
  })
})

class FakeUploadProc extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  received = Buffer.alloc(0)
  killCalls = 0

  constructor(exitCode: number) {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.received = Buffer.concat([this.received, chunk])
    })
    this.stdin.on('finish', () => queueMicrotask(() => this.emit('close', exitCode)))
  }

  kill(): boolean {
    this.killCalls++
    return true
  }
}

interface DeployHarness {
  deployer: WslDeployer
  bundleDir: string
  runnerCalls: { command: string; args: readonly string[]; cwd?: string; timeoutMs?: number }[]
  spawns: { command: string; args: readonly string[]; proc: FakeUploadProc }[]
}

const bundleDirs: string[] = []
afterEach(() => {
  for (const d of bundleDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ue-bundle-'))
  bundleDirs.push(dir)
  writeFileSync(join(dir, 'index.js'), 'export const a = 1\n')
  return dir
}

function makeDeployHarness(uploadExitCode = 0, installStderr = ''): DeployHarness {
  const bundleDir = makeBundle()
  const runnerCalls: DeployHarness['runnerCalls'] = []
  const runner: RemoteRunner = (command, args, options) => {
    runnerCalls.push({
      command,
      args,
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    })
    if (command === 'tar') {
      writeFileSync(join(tmpdir(), args[1]!), 'TGZ-BYTES')
    }
    if (installStderr && command !== 'tar') {
      return Promise.resolve({ code: 1, stdout: '', stderr: installStderr })
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }
  const spawns: DeployHarness['spawns'] = []
  const spawner: RemoteSpawner = (command, args) => {
    const proc = new FakeUploadProc(uploadExitCode)
    spawns.push({ command, args, proc })
    return proc as unknown as ChildProcessWithoutNullStreams
  }
  const deployer = new WslDeployer({
    runner,
    spawner,
    serverVersion: '0.0.0',
    bundleDir,
    wslExePath: WSL_EXE,
  })
  return { deployer, bundleDir, runnerCalls, spawns }
}

describe('WslDeployer', () => {
  it('check/start/stop run through wsl.exe with the shared bootstrap commands', async () => {
    const calls: { command: string; args: readonly string[] }[] = []
    const runner: RemoteRunner = (command, args) => {
      calls.push({ command, args })
      return Promise.resolve({ code: 3, stdout: '', stderr: '' })
    }
    const deployer = new WslDeployer({ runner, serverVersion: '0.0.0', wslExePath: WSL_EXE })

    const check = await deployer.checkRemoteServer('Ubuntu')
    expect(check).toEqual({ state: 'not-running' })
    await deployer.stopRemoteDaemon('Ubuntu')

    expect(calls.map((c) => c.command)).toEqual([WSL_EXE, WSL_EXE])
    expect(calls[0]!.args).toEqual(wslCommandArgs('Ubuntu', buildCheckCommand('0.0.0')))
    expect(calls[1]!.args).toEqual(wslCommandArgs('Ubuntu', buildStopCommand('0.0.0')))
  })

  it('startRemoteDaemon parses the info line and strips wsl.exe NULs from failures', async () => {
    const okRunner: RemoteRunner = () =>
      Promise.resolve({
        code: 0,
        stdout: `UNIVERSE_REMOTE_DAEMON_INFO={"serverVersion":"0.0.0","protocolVersion":2,"port":7,"token":"t","pid":1}\n`,
        stderr: '',
      })
    const ok = new WslDeployer({ runner: okRunner, serverVersion: '0.0.0', wslExePath: WSL_EXE })
    await expect(ok.startRemoteDaemon('Ubuntu')).resolves.toMatchObject({ port: 7, token: 't' })

    const failRunner: RemoteRunner = () =>
      Promise.resolve({ code: 1, stdout: '', stderr: utf16Nulled('no distro Ubuntu') })
    const fail = new WslDeployer({
      runner: failRunner,
      serverVersion: '0.0.0',
      wslExePath: WSL_EXE,
    })
    await expect(fail.startRemoteDaemon('Ubuntu')).rejects.toThrow('no distro Ubuntu')
  })

  it('checkRemoteServer strips NULs before the not-found classification regex', async () => {
    const runner: RemoteRunner = () =>
      Promise.resolve({ code: 1, stdout: '', stderr: utf16Nulled('node: command not found') })
    const deployer = new WslDeployer({ runner, serverVersion: '0.0.0', wslExePath: WSL_EXE })
    const result = await deployer.checkRemoteServer('Ubuntu')
    expect(result).toEqual({ state: 'not-deployed', reason: 'node: command not found' })
  })

  it('deploys via local tar → stdin upload → bash install, then cleans the local tgz', async () => {
    const { deployer, bundleDir, runnerCalls, spawns } = makeDeployHarness()
    await deployer.deployRemoteServer('Ubuntu')

    expect(runnerCalls.map((c) => c.command)).toEqual(['tar', WSL_EXE])
    const tar = runnerCalls[0]!
    const tgzName = tar.args[1]!
    expect(tgzName).toMatch(/^universe-server-[0-9a-f]+\.tgz$/)
    expect(tar.cwd).toBe(tmpdir())
    expect(tar.args.slice(2)).toEqual(['-C', bundleDir, '.'])

    expect(spawns).toHaveLength(1)
    const upload = spawns[0]!
    expect(upload.command).toBe(WSL_EXE)
    expect(upload.args).toEqual(wslCommandArgs('Ubuntu', `cat > /tmp/${tgzName}`))
    expect(upload.proc.received.toString('utf8')).toBe('TGZ-BYTES')

    const install = runnerCalls[1]!
    expect(install.args).toEqual(
      wslCommandArgs(
        'Ubuntu',
        buildDeployScriptBody('0.0.0', tgzName, computeBundleHash(bundleDir)),
      ),
    )
    expect(install.args[5]).toMatch(/install\.js --bundle-hash [0-9a-f]+/)
    expect(install.timeoutMs).toBe(1_800_000)

    expect(existsSync(join(tmpdir(), tgzName))).toBe(false)
  })

  it('surfaces an upload failure and still cleans up', async () => {
    const { deployer, runnerCalls } = makeDeployHarness(1)
    await expect(deployer.deployRemoteServer('Ubuntu')).rejects.toThrow(/wsl upload failed/)
    const tgzName = runnerCalls[0]!.args[1]!
    expect(existsSync(join(tmpdir(), tgzName))).toBe(false)
  })

  it('strips NULs from a failing install stderr', async () => {
    const { deployer } = makeDeployHarness(0, utf16Nulled('npm blew up'))
    await expect(deployer.deployRemoteServer('Ubuntu')).rejects.toThrow(
      'wsl install failed: npm blew up',
    )
  })

  it('reports uploading then installing phases to the onPhase callback', async () => {
    const { deployer } = makeDeployHarness()
    const phases: string[] = []
    await deployer.deployRemoteServer('Ubuntu', undefined, (phase) => phases.push(phase))
    expect(phases).toEqual(['uploading', 'installing'])
  })
})

describe('WslDeployer.provisionNodeRuntime', () => {
  it('probes via wsl.exe, streams the archive through stdin and installs', async () => {
    const runnerCalls: { command: string; args: readonly string[]; timeoutMs?: number }[] = []
    const runner: RemoteRunner = (command, args, options) => {
      runnerCalls.push({
        command,
        args,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
      if (args[args.length - 1] === buildUnameCommand()) {
        return Promise.resolve({ code: 0, stdout: 'Linux x86_64\n', stderr: '' })
      }
      return Promise.resolve({ code: 0, stdout: `v${NODE_RUNTIME_VERSION}\n`, stderr: '' })
    }
    const spawns: { command: string; args: readonly string[]; proc: FakeUploadProc }[] = []
    const spawner: RemoteSpawner = (command, args) => {
      const proc = new FakeUploadProc(0)
      spawns.push({ command, args, proc })
      return proc as unknown as ChildProcessWithoutNullStreams
    }
    const fetcher: NodeArchiveFetcher = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: Readable.toWeb(Readable.from(Buffer.from('NODE-TGZ-BYTES'))),
      })
    const deployer = new WslDeployer({
      runner,
      spawner,
      nodeArchiveFetcher: fetcher,
      serverVersion: '0.0.0',
      wslExePath: WSL_EXE,
    })
    await deployer.provisionNodeRuntime('Ubuntu')

    expect(runnerCalls.map((c) => c.command)).toEqual([WSL_EXE, WSL_EXE])
    expect(runnerCalls[0]!.args).toEqual(wslCommandArgs('Ubuntu', buildUnameCommand()))

    expect(spawns).toHaveLength(1)
    const upload = spawns[0]!
    const tgzName = upload.args[5]!.slice('cat > /tmp/'.length)
    expect(tgzName).toMatch(/^node-runtime-[0-9a-f]+\.tar\.gz$/)
    expect(upload.command).toBe(WSL_EXE)
    expect(upload.args).toEqual(wslCommandArgs('Ubuntu', `cat > /tmp/${tgzName}`))
    expect(upload.proc.received.toString('utf8')).toBe('NODE-TGZ-BYTES')

    expect(runnerCalls[1]!.args).toEqual(
      wslCommandArgs('Ubuntu', buildNodeInstallScriptBody(tgzName)),
    )
    expect(runnerCalls[1]!.timeoutMs).toBe(300_000)
  })
})
