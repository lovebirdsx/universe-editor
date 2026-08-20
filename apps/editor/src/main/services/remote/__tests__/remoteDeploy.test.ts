import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ILogger } from '@universe-editor/platform'
import {
  NODE_ARCHIVE_PROBE_BYTES,
  NODE_RUNTIME_VERSION,
  buildCheckCommand,
  buildDeployRemoteScript,
  buildDeployScriptBody,
  buildNodeInstallRemoteScript,
  buildNodeInstallScriptBody,
  buildStartCommand,
  buildStopCommand,
  buildUnameCommand,
  buildWindowsCheckCommand,
  buildWindowsDeployCommand,
  buildWindowsNodeInstallCommand,
  buildWindowsProbeCommand,
  buildWindowsStartCommand,
  buildWindowsStopCommand,
  classifyCheckResult,
  computeBundleHash,
  downloadNodeArchive,
  forwardArgs,
  parseAuthority,
  parseBundleHashLine,
  parseDaemonInfoLine,
  pickFastestNodeArchiveUrl,
  RemoteDeployer,
  resolveNodeArtifact,
  resolveWindowsNodeArtifact,
  scpArgs,
  sshCommandArgs,
  validateAuthority,
  type NodeArchiveFetcher,
  type RemoteRunner,
  type RemoteSpawner,
} from '../remoteDeploy.js'

const NODE_BIN_PATH = '$HOME/.universe-editor-server/node/v24.19.0/bin'
const NODE_PATH_PRELUDE = `PATH="$PATH:${NODE_BIN_PATH}"; `
const ARCHIVE_FILE_NAME = 'node-v24.19.0-linux-x64.tar.gz'
const OFFICIAL_URL = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${ARCHIVE_FILE_NAME}`
const MIRROR_URL = `https://npmmirror.com/mirrors/node/v${NODE_RUNTIME_VERSION}/${ARCHIVE_FILE_NAME}`
const noopLogger = { info: () => {}, warn: () => {} } as unknown as ILogger

/** A successful probe response with a full byte window. */
function rangeResponse(bytes = NODE_ARCHIVE_PROBE_BYTES): ReturnType<NodeArchiveFetcher> {
  return Promise.resolve({
    ok: true,
    status: 206,
    body: Readable.toWeb(Readable.from([Buffer.alloc(bytes)])),
  })
}

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
async function delayOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })
}

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
      `${NODE_PATH_PRELUDE}command -v node >/dev/null 2>&1 || exit 40; node ~/.universe-editor-server/0.0.0/bootstrap.js check`,
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
      `${NODE_PATH_PRELUDE}node ~/.universe-editor-server/0.0.0/bootstrap.js start`,
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

  it('builds the remote deploy install script delegating to install.js', () => {
    const script = buildDeployRemoteScript('0.0.0', 'universe-server-abc123.tgz', 'deadbeef')
    expect(script).toContain('mkdir -p ~/.universe-editor-server/0.0.0')
    expect(script).toContain('tar xzf /tmp/universe-server-abc123.tgz')
    expect(script).toContain(
      'node ~/.universe-editor-server/0.0.0/install.js --bundle-hash deadbeef',
    )
    expect(script).toContain('rm /tmp/universe-server-abc123.tgz')
  })

  it('removes the uploaded tgz only after install.js succeeds', () => {
    const body = buildDeployScriptBody('0.0.0', 'universe-server-abc123.tgz', 'deadbeef')
    const installIdx = body.indexOf('install.js --bundle-hash deadbeef')
    const rmIdx = body.indexOf('rm /tmp/universe-server-abc123.tgz')
    expect(installIdx).toBeGreaterThan(-1)
    expect(rmIdx).toBeGreaterThan(-1)
    expect(installIdx).toBeLessThan(rmIdx)
    expect(body.slice(installIdx, rmIdx)).toContain('&&')
  })

  it('builds check/start/stop commands against the versioned bootstrap', () => {
    expect(buildCheckCommand('1.2.3')).toBe(
      `${NODE_PATH_PRELUDE}command -v node >/dev/null 2>&1 || exit 40; node ~/.universe-editor-server/1.2.3/bootstrap.js check`,
    )
    expect(buildStartCommand('1.2.3')).toBe(
      `${NODE_PATH_PRELUDE}node ~/.universe-editor-server/1.2.3/bootstrap.js start`,
    )
    expect(buildStopCommand('1.2.3')).toBe(
      `${NODE_PATH_PRELUDE}node ~/.universe-editor-server/1.2.3/bootstrap.js stop`,
    )
  })
})

describe('parseDaemonInfoLine', () => {
  it('parses a well-formed info line', () => {
    const info = parseDaemonInfoLine(
      'UNIVERSE_REMOTE_DAEMON_INFO={"serverVersion":"0.0.0","protocolVersion":3,"port":1234,"token":"t","pid":99}\n',
    )
    expect(info).toEqual({
      serverVersion: '0.0.0',
      protocolVersion: 3,
      port: 1234,
      token: 't',
      pid: 99,
    })
  })

  it('parses an info line with surrounding noise', () => {
    const info = parseDaemonInfoLine(
      'some log\nUNIVERSE_REMOTE_DAEMON_INFO={"serverVersion":"0.0.0","protocolVersion":3,"port":5,"token":"x","pid":1}\nmore',
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

describe('classifyCheckResult node-missing and incomplete install', () => {
  it('maps exit 40 to node-missing', () => {
    expect(classifyCheckResult({ code: 40, stdout: '', stderr: '' }, 'ssh')).toEqual({
      state: 'node-missing',
    })
  })

  it('maps a missing node_modules ESM load error to not-deployed (self-heal redeploy)', () => {
    expect(
      classifyCheckResult(
        {
          code: 1,
          stdout: '',
          stderr:
            "Cannot find package '@universe-editor/platform' imported from /home/u/.universe-editor-server/0.0.0/bootstrap.js",
        },
        'ssh',
      ),
    ).toEqual({
      state: 'not-deployed',
      reason:
        "Cannot find package '@universe-editor/platform' imported from /home/u/.universe-editor-server/0.0.0/bootstrap.js",
    })
  })

  it('maps ERR_MODULE_NOT_FOUND stderr to not-deployed', () => {
    expect(
      classifyCheckResult(
        { code: 1, stdout: '', stderr: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package x' },
        'wsl',
      ),
    ).toEqual({
      state: 'not-deployed',
      reason: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package x',
    })
  })
})

describe('resolveNodeArtifact', () => {
  it('maps Linux and Darwin platforms to their node dist filenames', () => {
    expect(resolveNodeArtifact('Linux x86_64\n')).toEqual({
      platformKey: 'linux-x64',
      fileName: `node-v${NODE_RUNTIME_VERSION}-linux-x64.tar.gz`,
    })
    expect(resolveNodeArtifact('Linux aarch64\n')).toEqual({
      platformKey: 'linux-arm64',
      fileName: `node-v${NODE_RUNTIME_VERSION}-linux-arm64.tar.gz`,
    })
    expect(resolveNodeArtifact('Linux arm64\n')).toEqual({
      platformKey: 'linux-arm64',
      fileName: `node-v${NODE_RUNTIME_VERSION}-linux-arm64.tar.gz`,
    })
    expect(resolveNodeArtifact('Linux armv7l\n')).toEqual({
      platformKey: 'linux-armv7l',
      fileName: `node-v${NODE_RUNTIME_VERSION}-linux-armv7l.tar.gz`,
    })
    expect(resolveNodeArtifact('Darwin x86_64\n')).toEqual({
      platformKey: 'darwin-x64',
      fileName: `node-v${NODE_RUNTIME_VERSION}-darwin-x64.tar.gz`,
    })
    expect(resolveNodeArtifact('Darwin arm64\n')).toEqual({
      platformKey: 'darwin-arm64',
      fileName: `node-v${NODE_RUNTIME_VERSION}-darwin-arm64.tar.gz`,
    })
  })

  it('rejects musl libc (Alpine) with manual-install guidance', () => {
    const result = resolveNodeArtifact('Linux x86_64\nmusl libc (x86_64)\n')
    expect('error' in result).toBe(true)
    expect(result).toHaveProperty('error', expect.stringMatching(/musl/i))
  })

  it('rejects unknown platforms with manual-install guidance', () => {
    expect(resolveNodeArtifact('Linux s390x\n')).toHaveProperty(
      'error',
      expect.stringContaining('unsupported remote platform'),
    )
    expect(resolveNodeArtifact('')).toHaveProperty('error')
  })
})

describe('buildUnameCommand', () => {
  it('probes kernel/machine and the libc flavor', () => {
    expect(buildUnameCommand()).toBe('uname -sm; (ldd --version 2>&1 || true) | head -n 1')
  })
})

describe('buildWindowsProbeCommand', () => {
  it('round-trips %OS%/%PROCESSOR_ARCHITECTURE% through cmd.exe', () => {
    expect(buildWindowsProbeCommand()).toBe(
      'cmd /d /s /c "echo UNIVERSE_REMOTE_OS=%OS%.%PROCESSOR_ARCHITECTURE%"',
    )
  })
})

describe('windows command family', () => {
  const NODE_DIR = '.universe-editor-server\\node\\v24.19.0'
  // Every body pins the cwd first: the ssh session cwd is not reliably the home
  // directory (Win32-OpenSSH starts admin users in System32).
  const CD_HOME = 'cd /d %USERPROFILE%&'
  const PRELUDE = `${CD_HOME}set PATH=%PATH%;%USERPROFILE%\\${NODE_DIR}&`

  it('builds the exact check/start/stop commands', () => {
    expect(buildWindowsCheckCommand('0.0.0')).toBe(
      `cmd /d /s /c "${PRELUDE}(where node >nul 2>&1||exit /b 40)&node .universe-editor-server\\0.0.0\\bootstrap.js check"`,
    )
    expect(buildWindowsStartCommand('0.0.0')).toBe(
      `cmd /d /s /c "${PRELUDE}node .universe-editor-server\\0.0.0\\bootstrap.js start"`,
    )
    expect(buildWindowsStopCommand('0.0.0')).toBe(
      `cmd /d /s /c "${PRELUDE}node .universe-editor-server\\0.0.0\\bootstrap.js stop"`,
    )
  })

  it('builds the exact node install command', () => {
    expect(buildWindowsNodeInstallCommand('node-runtime-abc123.zip')).toBe(
      `cmd /d /s /c "${CD_HOME}(rmdir /s /q ${NODE_DIR}.tmp 2>nul)&(mkdir ${NODE_DIR}.tmp 2>nul)&%SystemRoot%\\System32\\tar.exe -xf node-runtime-abc123.zip --strip-components=1 -C ${NODE_DIR}.tmp&&(rmdir /s /q ${NODE_DIR} 2>nul)&move /y ${NODE_DIR}.tmp ${NODE_DIR} >nul&&del node-runtime-abc123.zip&&${NODE_DIR}\\node.exe --version"`,
    )
  })

  it('builds the exact deploy command', () => {
    expect(buildWindowsDeployCommand('0.0.0', 'universe-server-abc123.tgz', 'deadbeef')).toBe(
      `cmd /d /s /c "${CD_HOME}(rmdir /s /q .universe-editor-server\\0.0.0 2>nul)&mkdir .universe-editor-server\\0.0.0&&%SystemRoot%\\System32\\tar.exe -xzf universe-server-abc123.tgz -C .universe-editor-server\\0.0.0&&del universe-server-abc123.tgz&&set PATH=%PATH%;%USERPROFILE%\\${NODE_DIR}&node .universe-editor-server\\0.0.0\\install.js --bundle-hash deadbeef"`,
    )
  })

  it('keeps every body free of double quotes, $ and backticks (cmd/PowerShell invariant)', () => {
    const bodies = [
      buildWindowsCheckCommand('0.0.0'),
      buildWindowsStartCommand('0.0.0'),
      buildWindowsStopCommand('0.0.0'),
      buildWindowsNodeInstallCommand('node-runtime-abc123.zip'),
      buildWindowsDeployCommand('0.0.0', 'universe-server-abc123.tgz', 'deadbeef'),
    ].map((cmd) => cmd.slice('cmd /d /s /c "'.length, -1))
    for (const body of bodies) {
      expect(body).not.toContain('"')
      expect(body).not.toContain('$')
      expect(body).not.toContain('`')
    }
  })

  it('pins the cwd to the profile dir before any relative path (admin sessions start in System32)', () => {
    for (const cmd of [
      buildWindowsCheckCommand('0.0.0'),
      buildWindowsStartCommand('0.0.0'),
      buildWindowsStopCommand('0.0.0'),
      buildWindowsNodeInstallCommand('node-runtime-abc123.zip'),
      buildWindowsDeployCommand('0.0.0', 'universe-server-abc123.tgz', 'deadbeef'),
    ]) {
      expect(cmd.startsWith(`cmd /d /s /c "${CD_HOME}`)).toBe(true)
      // %CD% would expand before the cd runs (cmd expands the whole line once).
      expect(cmd).not.toContain('%CD%')
    }
  })
})

describe('resolveWindowsNodeArtifact', () => {
  it('maps x64 and arm64 to win dist zip filenames', () => {
    expect(resolveWindowsNodeArtifact('x64')).toEqual({
      platformKey: 'win-x64',
      fileName: `node-v${NODE_RUNTIME_VERSION}-win-x64.zip`,
    })
    expect(resolveWindowsNodeArtifact('arm64')).toEqual({
      platformKey: 'win-arm64',
      fileName: `node-v${NODE_RUNTIME_VERSION}-win-arm64.zip`,
    })
  })
})

describe('buildNodeInstallScriptBody', () => {
  it('extracts to a temp dir, atomically swaps and self-checks the runtime', () => {
    const body = buildNodeInstallScriptBody('node-runtime-abc.tar.gz')
    expect(body).toContain('dir="$HOME/.universe-editor-server/node/v24.19.0"')
    expect(body).toContain('tar xzf /tmp/node-runtime-abc.tar.gz')
    expect(body).toContain('--strip-components=1')
    expect(body).toContain('mv "$dir.tmp" "$dir"')
    expect(body).toContain('rm -f /tmp/node-runtime-abc.tar.gz')
    expect(body).toContain('"$dir/bin/node" --version')
    expect(body).not.toContain("'")
  })
})

describe('pickFastestNodeArchiveUrl', () => {
  it('picks the faster source and aborts the slower probe', async () => {
    const fetcher: NodeArchiveFetcher = async (url, init) => {
      await delayOrAbort(url.startsWith('https://nodejs.org') ? 60 : 5, init?.signal)
      return rangeResponse()
    }
    const winner = await pickFastestNodeArchiveUrl([OFFICIAL_URL, MIRROR_URL], noopLogger, fetcher)
    expect(winner?.url).toBe(MIRROR_URL)
    const officialProbe = winner!.probes.find((p) => p.url === OFFICIAL_URL)!
    expect('error' in officialProbe).toBe(true)
    if ('error' in officialProbe) {
      expect(officialProbe.error).toMatch(/abort/i)
    }
  })

  it('treats a stream ending before the probe window as failure', async () => {
    const fetcher: NodeArchiveFetcher = async (url) => {
      if (url.startsWith('https://nodejs.org')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: Readable.toWeb(Readable.from([Buffer.from('tiny')])),
        })
      }
      return rangeResponse()
    }
    const winner = await pickFastestNodeArchiveUrl([OFFICIAL_URL, MIRROR_URL], noopLogger, fetcher)
    expect(winner?.url).toBe(MIRROR_URL)
  })

  it('returns undefined when every probe stream ends early', async () => {
    const fetcher: NodeArchiveFetcher = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: Readable.toWeb(Readable.from([Buffer.from('tiny')])),
      })
    const winner = await pickFastestNodeArchiveUrl([OFFICIAL_URL, MIRROR_URL], noopLogger, fetcher)
    expect(winner).toBeUndefined()
  })

  it('returns undefined without fetching when there is a single source', async () => {
    const fetcher = vi.fn<NodeArchiveFetcher>()
    const winner = await pickFastestNodeArchiveUrl([OFFICIAL_URL], noopLogger, fetcher)
    expect(winner).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('times out when a probe never settles', async () => {
    const fetcher: NodeArchiveFetcher = async (_url, init) => {
      await delayOrAbort(60_000, init?.signal)
      return rangeResponse()
    }
    const winner = await pickFastestNodeArchiveUrl(
      [OFFICIAL_URL, MIRROR_URL],
      noopLogger,
      fetcher,
      50,
    )
    expect(winner).toBeUndefined()
  })
})

describe('downloadNodeArchive', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function okResponse(body: string): ReturnType<NodeArchiveFetcher> {
    return Promise.resolve({
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from(Buffer.from(body))),
    })
  }

  function mkDest(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ue-node-dl-'))
    dirs.push(dir)
    return join(dir, 'archive.tar.gz')
  }

  it('streams the archive from nodejs.org when it wins the probe', async () => {
    const calls: { url: string; ranged: boolean }[] = []
    const fetcher: NodeArchiveFetcher = async (url, init) => {
      const ranged = init?.headers?.Range !== undefined
      calls.push({ url, ranged })
      return ranged ? rangeResponse() : okResponse('TGZ-BYTES')
    }
    const dest = mkDest()
    await downloadNodeArchive(ARCHIVE_FILE_NAME, dest, noopLogger, fetcher)
    expect(calls.map((c) => c.url)).toEqual([OFFICIAL_URL, MIRROR_URL, OFFICIAL_URL])
    expect(calls.map((c) => c.ranged)).toEqual([true, true, false])
    expect(readFileSync(dest, 'utf8')).toBe('TGZ-BYTES')
  })

  it('downloads from npmmirror when the official probe fails', async () => {
    const calls: { url: string; ranged: boolean }[] = []
    const fetcher: NodeArchiveFetcher = async (url, init) => {
      const ranged = init?.headers?.Range !== undefined
      calls.push({ url, ranged })
      if (ranged && url.startsWith('https://nodejs.org')) {
        return Promise.resolve({ ok: false, status: 500, body: null })
      }
      return ranged ? rangeResponse() : okResponse('MIRROR-BYTES')
    }
    const dest = mkDest()
    await downloadNodeArchive(ARCHIVE_FILE_NAME, dest, noopLogger, fetcher)
    expect(calls.map((c) => c.url)).toEqual([OFFICIAL_URL, MIRROR_URL, MIRROR_URL])
    expect(readFileSync(dest, 'utf8')).toBe('MIRROR-BYTES')
  })

  it('downloads from the probe winner first', async () => {
    const calls: { url: string; ranged: boolean }[] = []
    const fetcher: NodeArchiveFetcher = async (url, init) => {
      const ranged = init?.headers?.Range !== undefined
      calls.push({ url, ranged })
      if (ranged) {
        await delayOrAbort(url.startsWith('https://nodejs.org') ? 60 : 5, init?.signal)
        return rangeResponse()
      }
      return okResponse(url.startsWith('https://npmmirror.com') ? 'MIRROR-BYTES' : 'OFFICIAL-BYTES')
    }
    const dest = mkDest()
    await downloadNodeArchive(ARCHIVE_FILE_NAME, dest, noopLogger, fetcher)
    expect(calls.map((c) => c.url)).toEqual([OFFICIAL_URL, MIRROR_URL, MIRROR_URL])
    expect(readFileSync(dest, 'utf8')).toBe('MIRROR-BYTES')
  })

  it('falls back to the remaining source when the preferred download fails', async () => {
    const calls: { url: string; ranged: boolean }[] = []
    const fetcher: NodeArchiveFetcher = async (url, init) => {
      const ranged = init?.headers?.Range !== undefined
      calls.push({ url, ranged })
      if (ranged) {
        await delayOrAbort(url.startsWith('https://nodejs.org') ? 60 : 5, init?.signal)
        return rangeResponse()
      }
      if (url.startsWith('https://npmmirror.com')) {
        return Promise.resolve({ ok: false, status: 500, body: null })
      }
      return okResponse('OFFICIAL-BYTES')
    }
    const dest = mkDest()
    await downloadNodeArchive(ARCHIVE_FILE_NAME, dest, noopLogger, fetcher)
    expect(calls.map((c) => c.url)).toEqual([OFFICIAL_URL, MIRROR_URL, MIRROR_URL, OFFICIAL_URL])
    expect(readFileSync(dest, 'utf8')).toBe('OFFICIAL-BYTES')
  })

  it('keeps the fixed order when every probe fails', async () => {
    const calls: string[] = []
    const fetcher: NodeArchiveFetcher = async (url, init) => {
      calls.push(url)
      if (init?.headers?.Range !== undefined) {
        return Promise.resolve({ ok: false, status: 500, body: null })
      }
      return okResponse('TGZ-BYTES')
    }
    const dest = mkDest()
    await downloadNodeArchive(ARCHIVE_FILE_NAME, dest, noopLogger, fetcher)
    expect(calls).toEqual([OFFICIAL_URL, MIRROR_URL, OFFICIAL_URL])
    expect(readFileSync(dest, 'utf8')).toBe('TGZ-BYTES')
  })

  it('throws including both URLs when every mirror fails', async () => {
    const calls: string[] = []
    const fetcher: NodeArchiveFetcher = async (url) => {
      calls.push(url)
      return Promise.resolve({ ok: false, status: 404, body: null })
    }
    const dest = mkDest()
    await expect(downloadNodeArchive(ARCHIVE_FILE_NAME, dest, noopLogger, fetcher)).rejects.toThrow(
      /failed to download Node.js .*nodejs\.org.*npmmirror/,
    )
    expect(calls).toHaveLength(4)
  })
})

describe('RemoteDeployer platform probing', () => {
  it('treats a Linux uname as posix and skips the windows probe', async () => {
    const commands: string[] = []
    const runner: RemoteRunner = (_command, args) => {
      const remote = args[args.length - 1]!
      commands.push(remote)
      if (remote === buildUnameCommand()) {
        return Promise.resolve({ code: 0, stdout: 'Linux x86_64\n', stderr: '' })
      }
      return Promise.resolve({ code: 3, stdout: '', stderr: '' })
    }
    const deployer = new RemoteDeployer({ runner, serverVersion: '0.0.0' })
    await expect(deployer.checkRemoteServer('user@host')).resolves.toEqual({
      state: 'not-running',
    })
    expect(commands).toEqual([buildUnameCommand(), buildCheckCommand('0.0.0')])
  })

  it('detects a cmd.exe Windows remote via the probe and uses the windows check command', async () => {
    const commands: string[] = []
    const runner: RemoteRunner = (_command, args) => {
      const remote = args[args.length - 1]!
      commands.push(remote)
      if (remote === buildUnameCommand()) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'not recognized' })
      }
      if (remote === buildWindowsProbeCommand()) {
        return Promise.resolve({
          code: 0,
          stdout: 'UNIVERSE_REMOTE_OS=Windows_NT.AMD64\r\n',
          stderr: '',
        })
      }
      return Promise.resolve({ code: 3, stdout: '', stderr: '' })
    }
    const deployer = new RemoteDeployer({ runner, serverVersion: '0.0.0' })
    await expect(deployer.checkRemoteServer('user@host')).resolves.toEqual({
      state: 'not-running',
    })
    expect(commands).toEqual([
      buildUnameCommand(),
      buildWindowsProbeCommand(),
      buildWindowsCheckCommand('0.0.0'),
    ])
  })

  it('rejects a git-bash (MINGW) uname with DefaultShell guidance', async () => {
    const runner: RemoteRunner = (_command, args) => {
      const remote = args[args.length - 1]!
      if (remote === buildUnameCommand()) {
        return Promise.resolve({ code: 0, stdout: 'MINGW64_NT-10.0 x86_64\n', stderr: '' })
      }
      return Promise.resolve({ code: 3, stdout: '', stderr: '' })
    }
    const deployer = new RemoteDeployer({ runner, serverVersion: '0.0.0' })
    await expect(deployer.checkRemoteServer('user@host')).rejects.toThrow(
      /git-bash\/MSYS.*DefaultShell/s,
    )
  })

  it('throws failed-to-probe when neither uname nor the windows probe identify the host', async () => {
    const runner: RemoteRunner = (_command, args) => {
      const remote = args[args.length - 1]!
      if (remote === buildUnameCommand()) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'uname: not found' })
      }
      // POSIX sh echoes %OS% literally
      return Promise.resolve({ code: 0, stdout: '%OS%\n', stderr: '' })
    }
    const deployer = new RemoteDeployer({ runner, serverVersion: '0.0.0' })
    await expect(deployer.checkRemoteServer('user@host')).rejects.toThrow(
      'failed to probe remote platform: uname: not found',
    )
  })

  it('caches the probe result per authority (no second uname)', async () => {
    const commands: string[] = []
    const runner: RemoteRunner = (_command, args) => {
      const remote = args[args.length - 1]!
      commands.push(remote)
      if (remote === buildUnameCommand()) {
        return Promise.resolve({ code: 0, stdout: 'Linux x86_64\n', stderr: '' })
      }
      return Promise.resolve({ code: 3, stdout: '', stderr: '' })
    }
    const deployer = new RemoteDeployer({ runner, serverVersion: '0.0.0' })
    await deployer.checkRemoteServer('user@host')
    await deployer.checkRemoteServer('user@host')
    expect(commands).toEqual([
      buildUnameCommand(),
      buildCheckCommand('0.0.0'),
      buildCheckCommand('0.0.0'),
    ])
  })
})

describe('RemoteDeployer.provisionNodeRuntime', () => {
  it('probes → downloads → scp → installs the private node runtime', async () => {
    const calls: {
      command: string
      args: readonly string[]
      cwd?: string
      timeoutMs?: number
    }[] = []
    const runner: RemoteRunner = (command, args, options) => {
      calls.push({
        command,
        args,
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
      if (command === 'ssh' && args[args.length - 1] === buildUnameCommand()) {
        return Promise.resolve({ code: 0, stdout: 'Linux x86_64\n', stderr: '' })
      }
      if (command === 'ssh') {
        return Promise.resolve({ code: 0, stdout: `v${NODE_RUNTIME_VERSION}\n`, stderr: '' })
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const fetcher: NodeArchiveFetcher = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: Readable.toWeb(Readable.from(Buffer.from('NODE-TGZ-BYTES'))),
      })
    const deployer = new RemoteDeployer({
      runner,
      nodeArchiveFetcher: fetcher,
      serverVersion: '0.0.0',
    })
    await deployer.provisionNodeRuntime('user@host')

    expect(calls.map((c) => c.command)).toEqual(['ssh', 'scp', 'ssh'])
    const [uname, scp, install] = calls
    expect(uname!.args).toEqual(sshCommandArgs('user@host', buildUnameCommand()))
    const tgzName = scp!.args.find((a) => a.includes('node-runtime-'))!
    expect(tgzName).toMatch(/^node-runtime-[0-9a-f]+\.tar\.gz$/)
    expect(scp!.args).toContain(`user@host:/tmp/${tgzName}`)
    expect(scp!.cwd).toBe(tmpdir())
    expect(install!.args).toEqual(
      sshCommandArgs('user@host', buildNodeInstallRemoteScript(tgzName)),
    )
    expect(install!.timeoutMs).toBe(300_000)
  })

  it('throws when the remote platform is unsupported', async () => {
    const runner: RemoteRunner = () =>
      Promise.resolve({ code: 0, stdout: 'Linux s390x\n', stderr: '' })
    const deployer = new RemoteDeployer({ runner, serverVersion: '0.0.0' })
    await expect(deployer.provisionNodeRuntime('user@host')).rejects.toThrow(
      'unsupported remote platform',
    )
  })

  it('provisions a windows node runtime (zip → relative-home scp → cmd install)', async () => {
    const calls: {
      command: string
      args: readonly string[]
      cwd?: string
      timeoutMs?: number
    }[] = []
    const fetched: string[] = []
    const runner: RemoteRunner = (command, args, options) => {
      calls.push({
        command,
        args,
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
      const remote = args[args.length - 1]!
      if (command === 'ssh' && remote === buildUnameCommand()) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'not recognized' })
      }
      if (command === 'ssh' && remote === buildWindowsProbeCommand()) {
        return Promise.resolve({
          code: 0,
          stdout: 'UNIVERSE_REMOTE_OS=Windows_NT.AMD64\r\n',
          stderr: '',
        })
      }
      if (command === 'ssh') {
        return Promise.resolve({ code: 0, stdout: `v${NODE_RUNTIME_VERSION}\n`, stderr: '' })
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const fetcher: NodeArchiveFetcher = (url) => {
      fetched.push(url)
      return Promise.resolve({
        ok: true,
        status: 200,
        body: Readable.toWeb(Readable.from(Buffer.from('NODE-ZIP-BYTES'))),
      })
    }
    const deployer = new RemoteDeployer({
      runner,
      nodeArchiveFetcher: fetcher,
      serverVersion: '0.0.0',
    })
    await deployer.provisionNodeRuntime('user@host')

    expect(calls.map((c) => c.command)).toEqual(['ssh', 'ssh', 'scp', 'ssh'])
    const [, probe, scp, install] = calls
    expect(probe!.args).toEqual(sshCommandArgs('user@host', buildWindowsProbeCommand()))
    const zipName = scp!.args.find((a) => a.includes('node-runtime-'))!
    expect(zipName).toMatch(/^node-runtime-[0-9a-f]+\.zip$/)
    expect(scp!.args).toContain(`user@host:${zipName}`)
    expect(scp!.args).not.toContain('/tmp/')
    expect(scp!.cwd).toBe(tmpdir())
    expect(install!.args).toEqual(
      sshCommandArgs('user@host', buildWindowsNodeInstallCommand(zipName)),
    )
    expect(install!.timeoutMs).toBe(300_000)
    expect(fetched.some((u) => u.includes(`node-v${NODE_RUNTIME_VERSION}-win-x64.zip`))).toBe(true)
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

    expect(calls.map((c) => c.command)).toEqual(['ssh', 'tar', 'scp', 'ssh'])

    const [, tar, scp, install] = calls
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
    expect(remoteScript).toMatch(/install\.js --bundle-hash [0-9a-f]+/)
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

  it('reports uploading then installing phases to the onPhase callback', async () => {
    const runner: RemoteRunner = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
    const deployer = new RemoteDeployer({
      runner,
      serverVersion: '0.0.0',
      bundleDir: makeBundle(),
    })
    const phases: string[] = []
    await deployer.deployRemoteServer('user@host', undefined, (phase) => phases.push(phase))
    expect(phases).toEqual(['uploading', 'installing'])
  })

  it('deploys to a windows remote via relative-home scp + cmd deploy', async () => {
    const bundleDir = makeBundle()
    const bundleHash = computeBundleHash(bundleDir)
    const calls: { command: string; args: readonly string[]; cwd?: string }[] = []
    const runner: RemoteRunner = (command, args, options) => {
      calls.push({ command, args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) })
      const remote = args[args.length - 1]!
      if (command === 'ssh' && remote === buildUnameCommand()) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'not recognized' })
      }
      if (command === 'ssh' && remote === buildWindowsProbeCommand()) {
        return Promise.resolve({
          code: 0,
          stdout: 'UNIVERSE_REMOTE_OS=Windows_NT.AMD64\r\n',
          stderr: '',
        })
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const deployer = new RemoteDeployer({ runner, serverVersion: '0.0.0', bundleDir })
    await deployer.deployRemoteServer('user@host')

    expect(calls.map((c) => c.command)).toEqual(['ssh', 'ssh', 'tar', 'scp', 'ssh'])
    const [uname, probe, tar, scp, install] = calls
    expect(uname!.args).toEqual(sshCommandArgs('user@host', buildUnameCommand()))
    expect(probe!.args).toEqual(sshCommandArgs('user@host', buildWindowsProbeCommand()))
    const tgzName = tar!.args[1]!
    expect(tgzName).toMatch(/^universe-server-[0-9a-f]+\.tgz$/)
    expect(scp!.args).toContain(`user@host:${tgzName}`)
    expect(scp!.args).not.toContain('/tmp/')
    expect(install!.args).toEqual(
      sshCommandArgs('user@host', buildWindowsDeployCommand('0.0.0', tgzName, bundleHash)),
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
