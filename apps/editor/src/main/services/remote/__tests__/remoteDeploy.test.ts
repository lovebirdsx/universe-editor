import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { ILogger } from '@universe-editor/platform'
import {
  buildCheckCommand,
  buildDeployRemoteScript,
  buildStartCommand,
  buildStopCommand,
  classifyCheckResult,
  computeBundleHash,
  forwardArgs,
  parseAuthority,
  parseBundleHashLine,
  parseDaemonInfoLine,
  RemoteDeployer,
  scpArgs,
  sshCommandArgs,
  validateAuthority,
  type RemoteRunner,
  type RemoteSpawner,
} from '../remoteDeploy.js'

describe('validateAuthority', () => {
  it('accepts a bare host, user@host, host:port and user@host:port', () => {
    expect(() => validateAuthority('host')).not.toThrow()
    expect(() => validateAuthority('user@host')).not.toThrow()
    expect(() => validateAuthority('host:22')).not.toThrow()
    expect(() => validateAuthority('user@host:22')).not.toThrow()
    expect(() => validateAuthority('e2e-local')).not.toThrow()
    expect(() => validateAuthority('user.name_1@host-2.example.com:2222')).not.toThrow()
  })

  it('rejects empty, leading dash and malformed authorities', () => {
    expect(() => validateAuthority('')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('-oProxyCommand=evil')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('user@')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('@host')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('host:')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('host:abc')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('a b')).toThrow(/invalid remote authority/)
    expect(() => validateAuthority('host:22:33')).toThrow(/invalid remote authority/)
  })
})

describe('parseAuthority', () => {
  it('splits user, host and port', () => {
    expect(parseAuthority('user@host:22')).toEqual({ host: 'host', user: 'user', port: 22 })
    expect(parseAuthority('host')).toEqual({ host: 'host' })
    expect(parseAuthority('host:22')).toEqual({ host: 'host', port: 22 })
  })
})

describe('argv assembly', () => {
  it('builds the ssh check command with the remote data-dir path', () => {
    expect(sshCommandArgs('user@host', buildCheckCommand('0.0.0'))).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      'user@host',
      'node ~/.universe-editor-server/0.0.0/bootstrap.js check',
    ])
  })

  it('adds -p for an explicit ssh port', () => {
    expect(sshCommandArgs('host:2222', buildStartCommand('0.0.0'))).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-p',
      '2222',
      'host',
      'node ~/.universe-editor-server/0.0.0/bootstrap.js start',
    ])
  })

  it('uses -P for scp and does not let the source path slip into options', () => {
    expect(scpArgs('host:22', '/tmp/a.tgz', 'host:/tmp/a.tgz')).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-P',
      '22',
      '/tmp/a.tgz',
      'host:/tmp/a.tgz',
    ])
  })

  it('builds forward args with keepalive and ExitOnForwardFailure', () => {
    expect(forwardArgs('user@host', 1234, 5678)).toEqual([
      '-N',
      '-L',
      '1234:127.0.0.1:5678',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ExitOnForwardFailure=yes',
      'user@host',
    ])
  })

  it('builds the remote deploy install script', () => {
    const script = buildDeployRemoteScript('0.0.0', 'universe-server-abc123.tgz', 'deadbeef')
    expect(script).toContain('mkdir -p ~/.universe-editor-server/0.0.0')
    expect(script).toContain('tar xzf /tmp/universe-server-abc123.tgz')
    expect(script).toContain('npm install --omit=dev --no-audit --no-fund')
    expect(script).toContain('vendor/claude-agent-acp vendor/codex-acp')
    expect(script).toContain('npm ci --omit=dev --no-audit --no-fund')
    expect(script).toContain('rm /tmp/universe-server-abc123.tgz')
    expect(script).toContain('printf %s "deadbeef" > ~/.universe-editor-server/0.0.0/bundle.hash')
  })

  it('builds check/start/stop commands against the versioned bootstrap', () => {
    expect(buildCheckCommand('1.2.3')).toBe(
      'node ~/.universe-editor-server/1.2.3/bootstrap.js check',
    )
    expect(buildStartCommand('1.2.3')).toBe(
      'node ~/.universe-editor-server/1.2.3/bootstrap.js start',
    )
    expect(buildStopCommand('1.2.3')).toBe('node ~/.universe-editor-server/1.2.3/bootstrap.js stop')
  })
})

describe('parseDaemonInfoLine', () => {
  it('parses a well-formed info line', () => {
    const info = parseDaemonInfoLine(
      'UNIVERSE_REMOTE_DAEMON_INFO={"serverVersion":"0.0.0","protocolVersion":2,"port":1234,"token":"t","pid":99}\n',
    )
    expect(info).toEqual({
      serverVersion: '0.0.0',
      protocolVersion: 2,
      port: 1234,
      token: 't',
      pid: 99,
    })
  })

  it('parses an info line with surrounding noise', () => {
    const info = parseDaemonInfoLine(
      'some log\nUNIVERSE_REMOTE_DAEMON_INFO={"serverVersion":"0.0.0","protocolVersion":2,"port":5,"token":"x","pid":1}\nmore',
    )
    expect(info?.port).toBe(5)
  })

  it('returns null for garbage / missing line', () => {
    expect(parseDaemonInfoLine('no info here')).toBeNull()
    expect(parseDaemonInfoLine('UNIVERSE_REMOTE_DAEMON_INFO={bad json}')).toBeNull()
    expect(parseDaemonInfoLine('UNIVERSE_REMOTE_DAEMON_INFO={"token":"no-port"}')).toBeNull()
  })
})

describe('computeBundleHash', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function makeBundle(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ue-bundle-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'index.js'), 'export const a = 1\n')
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'util.js'), 'export const b = 2\n')
    return dir
  }

  it('returns a stable 64-char hex hash that changes with content', () => {
    const dir = makeBundle()
    const h1 = computeBundleHash(dir)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(computeBundleHash(dir)).toBe(h1)

    writeFileSync(join(dir, 'lib', 'util.js'), 'export const b = 3\n')
    expect(computeBundleHash(dir)).not.toBe(h1)
  })

  it('depends only on relative paths + content, not absolute layout', () => {
    expect(computeBundleHash(makeBundle())).toBe(computeBundleHash(makeBundle()))
  })
})

describe('parseBundleHashLine', () => {
  it('extracts the hash value from the line', () => {
    expect(parseBundleHashLine('UNIVERSE_REMOTE_BUNDLE_HASH=deadbeef\n')).toBe('deadbeef')
    expect(parseBundleHashLine('noise\nUNIVERSE_REMOTE_BUNDLE_HASH=cafe\nmore')).toBe('cafe')
  })

  it('returns undefined for a missing or empty value', () => {
    expect(parseBundleHashLine('UNIVERSE_REMOTE_DAEMON_INFO={"x":1}\n')).toBeUndefined()
    expect(parseBundleHashLine('UNIVERSE_REMOTE_BUNDLE_HASH=\n')).toBeUndefined()
    expect(parseBundleHashLine('UNIVERSE_REMOTE_BUNDLE_HASH=   \n')).toBeUndefined()
    expect(parseBundleHashLine('')).toBeUndefined()
  })
})

describe('classifyCheckResult bundle hash', () => {
  const infoLine =
    'UNIVERSE_REMOTE_DAEMON_INFO={"serverVersion":"0.0.0","protocolVersion":2,"port":9,"token":"t","pid":1}\n'

  it('attaches deployedBundleHash to running and not-running when present', () => {
    const running = classifyCheckResult(
      { code: 0, stdout: `UNIVERSE_REMOTE_BUNDLE_HASH=abc\n${infoLine}`, stderr: '' },
      'wsl',
    )
    expect(running).toEqual({
      state: 'running',
      info: expect.objectContaining({ port: 9 }),
      deployedBundleHash: 'abc',
    })

    const notRunning = classifyCheckResult(
      { code: 3, stdout: 'UNIVERSE_REMOTE_BUNDLE_HASH=abc\n', stderr: '' },
      'wsl',
    )
    expect(notRunning).toEqual({ state: 'not-running', deployedBundleHash: 'abc' })
  })

  it('omits deployedBundleHash when the hash line is absent', () => {
    const running = classifyCheckResult({ code: 0, stdout: infoLine, stderr: '' }, 'wsl')
    expect(running).toEqual({ state: 'running', info: expect.objectContaining({ port: 9 }) })
    expect('deployedBundleHash' in running).toBe(false)

    expect(classifyCheckResult({ code: 3, stdout: '', stderr: '' }, 'wsl')).toEqual({
      state: 'not-running',
    })
  })
})

describe('RemoteDeployer.deployRemoteServer', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function makeBundle(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ue-bundle-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'index.js'), 'export const a = 1\n')
    return dir
  }

  it('runs tar and scp from tmpdir with a bare filename (GNU tar/scp treat C:\ as host:file)', async () => {
    const bundleDir = makeBundle()
    const calls: { command: string; args: readonly string[]; cwd?: string }[] = []
    const runner: RemoteRunner = (command, args, options) => {
      calls.push({ command, args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) })
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const deployer = new RemoteDeployer({ runner, serverVersion: '0.0.0', bundleDir })
    await deployer.deployRemoteServer('user@host')

    expect(calls.map((c) => c.command)).toEqual(['tar', 'scp', 'ssh'])

    const [tar, scp, install] = calls
    expect(tar!.args[0]).toBe('-czf')
    const tgzName = tar!.args[1]!
    expect(tgzName).toMatch(/^universe-server-[0-9a-f]+\.tgz$/)
    expect(tgzName).not.toContain(':')
    expect(tar!.args.slice(2)).toEqual(['-C', bundleDir, '.'])
    expect(tar!.cwd).toBe(tmpdir())

    expect(scp!.args).toContain(tgzName)
    expect(scp!.args).toContain(`user@host:/tmp/${tgzName}`)
    expect(scp!.cwd).toBe(tmpdir())

    const remoteScript = install!.args[install!.args.length - 1]!
    expect(remoteScript).toContain(`tar xzf /tmp/${tgzName}`)
    expect(remoteScript).toContain('printf %s "')
    expect(remoteScript).toContain('~/.universe-editor-server/0.0.0/bundle.hash')
  })

  it('surfaces the failing step in the thrown error', async () => {
    const runner: RemoteRunner = (command) =>
      Promise.resolve(
        command === 'scp'
          ? { code: 1, stdout: '', stderr: 'lost connection' }
          : { code: 0, stdout: '', stderr: '' },
      )
    const deployer = new RemoteDeployer({
      runner,
      serverVersion: '0.0.0',
      bundleDir: makeBundle(),
    })
    await expect(deployer.deployRemoteServer('user@host')).rejects.toThrow(
      'scp failed: lost connection',
    )
  })
})

describe('RemoteDeployer.createForward', () => {
  class FakeProc extends EventEmitter {
    readonly stdout = new EventEmitter()
    readonly stderr = new EventEmitter()
    readonly stdin = new EventEmitter()
    pid = 1
    kill(): boolean {
      return true
    }
  }

  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  it('returns a stderrSub that detaches the forward stderr listener when disposed', async () => {
    let proc: FakeProc | undefined
    // Parse the forwarded port out of `-L localPort:127.0.0.1:remotePort` and
    // listen on it so waitForPort succeeds without a real ssh process.
    const spawner: RemoteSpawner = (_command, args) => {
      const lIdx = args.indexOf('-L')
      const localPort = Number(args[lIdx + 1]!.split(':')[0]!)
      const server = createServer(() => {})
      servers.push(server)
      server.listen(localPort, '127.0.0.1')
      proc = new FakeProc()
      return proc as unknown as ChildProcessWithoutNullStreams
    }

    const warnings: string[] = []
    const logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
      dispose: () => {},
    } as unknown as ILogger

    const deployer = new RemoteDeployer({ spawner, serverVersion: '0.0.0' })
    const { stderrSub } = await deployer.createForward('user@host', 5678, logger)

    proc!.stderr.emit('data', Buffer.from('boom\n'))
    expect(warnings).toHaveLength(1)

    stderrSub.dispose()
    proc!.stderr.emit('data', Buffer.from('again\n'))
    expect(warnings).toHaveLength(1)
  })
})
