/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SSH orchestration for the remote server daemon. Every local spawn uses an argv
 *  array + shell:false (never the cmd.exe wrapper): the remote command is passed to
 *  ssh/scp as a single argument and interpreted by the remote shell. The daemon
 *  lives at `~/.universe-editor-server/<version>/` on the remote host; `~` is
 *  expanded remotely. All functions log liberally — this chain is the lifeline for
 *  WSL/real-machine debugging.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { ManagedChildProcess } from '@universe-editor/node-services'
import {
  NullLogger,
  type IDisposable,
  type ILogger,
  type IRemoteDaemonInfo,
} from '@universe-editor/platform'
import { buildChildEnv } from '../process/env.js'
import { decodeDiagnostic } from '../process/decode.js'

const DATA_DIR = '~/.universe-editor-server'
const DEFAULT_SERVER_VERSION = '0.0.0'
const DAEMON_INFO_PREFIX = 'UNIVERSE_REMOTE_DAEMON_INFO='
const BUNDLE_HASH_PREFIX = 'UNIVERSE_REMOTE_BUNDLE_HASH='
const BUNDLE_HASH_FILE = 'bundle.hash'
const SSH_BATCH_MODE = 'BatchMode=yes'
const SSH_STRICT_HOST_KEY = 'StrictHostKeyChecking=accept-new'

// ------------------------- authority parsing -------------------------

const AUTHORITY_PATTERN = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?(:\d+)?$/

export interface ParsedAuthority {
  readonly host: string
  readonly user?: string
  readonly port?: number
}

export function validateAuthority(authority: string): void {
  // A leading `-` would be parsed by ssh/scp as an option even in an argv array.
  if (!AUTHORITY_PATTERN.test(authority) || authority.startsWith('-')) {
    throw new Error(
      `invalid remote authority '${authority}'; expected user@host[:port] or host[:port]`,
    )
  }
}

export function parseAuthority(authority: string): ParsedAuthority {
  validateAuthority(authority)
  const at = authority.lastIndexOf('@')
  const user = at >= 0 ? authority.slice(0, at) : undefined
  const rest = at >= 0 ? authority.slice(at + 1) : authority
  const colon = rest.lastIndexOf(':')
  let host = rest
  let port: number | undefined
  if (colon >= 0) {
    host = rest.slice(0, colon)
    port = Number(rest.slice(colon + 1))
  }
  return {
    host,
    ...(user !== undefined ? { user } : {}),
    ...(port !== undefined ? { port } : {}),
  }
}

function destination(authority: string): string {
  const { host, user } = parseAuthority(authority)
  return user ? `${user}@${host}` : host
}

// ------------------------- argv assembly (exported for snapshot tests) -------------------------

export function sshBaseArgs(authority: string): string[] {
  const { port } = parseAuthority(authority)
  return [
    '-o',
    SSH_BATCH_MODE,
    '-o',
    SSH_STRICT_HOST_KEY,
    ...(port !== undefined ? ['-p', String(port)] : []),
    destination(authority),
  ]
}

export function sshCommandArgs(authority: string, remoteCommand: string): string[] {
  return [...sshBaseArgs(authority), remoteCommand]
}

export function scpArgs(authority: string, source: string, remoteTarget: string): string[] {
  const { port } = parseAuthority(authority)
  return [
    '-o',
    SSH_BATCH_MODE,
    '-o',
    SSH_STRICT_HOST_KEY,
    ...(port !== undefined ? ['-P', String(port)] : []),
    source,
    remoteTarget,
  ]
}

export function forwardArgs(authority: string, localPort: number, remotePort: number): string[] {
  const { port } = parseAuthority(authority)
  return [
    '-N',
    '-L',
    `${localPort}:127.0.0.1:${remotePort}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    SSH_BATCH_MODE,
    '-o',
    SSH_STRICT_HOST_KEY,
    '-o',
    'ExitOnForwardFailure=yes',
    ...(port !== undefined ? ['-p', String(port)] : []),
    destination(authority),
  ]
}

function serverBootstrapPath(version: string): string {
  return `${DATA_DIR}/${version}/bootstrap.js`
}

export function buildCheckCommand(version: string): string {
  return `node ${serverBootstrapPath(version)} check`
}

export function buildStartCommand(version: string): string {
  return `node ${serverBootstrapPath(version)} start`
}

export function buildStopCommand(version: string): string {
  return `node ${serverBootstrapPath(version)} stop`
}

export function buildDeployScriptBody(
  version: string,
  tmpName: string,
  bundleHash: string,
): string {
  const dir = `${DATA_DIR}/${version}`
  // Vendored ACP agents ship without node_modules (client-platform binaries must
  // not cross the wire); `npm ci --omit=dev` in each vendor dir resolves the
  // remote host's own platform packages.
  const vendorInstall = `for v in vendor/claude-agent-acp vendor/codex-acp; do if [ -d "$v" ]; then (cd "$v" && npm ci --omit=dev --no-audit --no-fund); fi; done`
  return `mkdir -p ${dir} && tar xzf /tmp/${tmpName} -C ${dir} && printf %s "${bundleHash}" > ${dir}/${BUNDLE_HASH_FILE} && cd ${dir} && npm install --omit=dev --no-audit --no-fund && ${vendorInstall} && rm /tmp/${tmpName}`
}

export function buildDeployRemoteScript(
  version: string,
  tmpName: string,
  bundleHash: string,
): string {
  return `sh -c '${buildDeployScriptBody(version, tmpName, bundleHash)}'`
}

// ------------------------- daemon info line -------------------------

export function parseDaemonInfoLine(output: string): IRemoteDaemonInfo | null {
  const idx = output.indexOf(DAEMON_INFO_PREFIX)
  if (idx < 0) return null
  const valueStart = idx + DAEMON_INFO_PREFIX.length
  let valueEnd = output.indexOf('\n', valueStart)
  if (valueEnd < 0) valueEnd = output.length
  const json = output.slice(valueStart, valueEnd).trim()
  if (!json) return null
  try {
    const info = JSON.parse(json) as IRemoteDaemonInfo
    if (typeof info.port !== 'number' || typeof info.token !== 'string') return null
    return info
  } catch {
    return null
  }
}

// ------------------------- bundle hash line -------------------------

export function parseBundleHashLine(output: string): string | undefined {
  const idx = output.indexOf(BUNDLE_HASH_PREFIX)
  if (idx < 0) return undefined
  const valueStart = idx + BUNDLE_HASH_PREFIX.length
  let valueEnd = output.indexOf('\n', valueStart)
  if (valueEnd < 0) valueEnd = output.length
  const value = output.slice(valueStart, valueEnd).trim()
  return value || undefined
}

// ------------------------- local bundle / version resolution -------------------------

/**
 * Content hash of the deploy tree: every regular file (dirs/symlinks skipped)
 * fed into one sha256 in sorted `relPath` order, paths `/`-separated so the hash
 * is identical on the Windows build host and the Linux remote. The deploy writes
 * the result to `bundle.hash` next to the remote bootstrap so `check` can report
 * it — dev's constant 0.0.0 version can't signal staleness on its own.
 */
export function computeBundleHash(bundleDir: string): string {
  const files: { relPath: string; absPath: string }[] = []
  const visit = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      const absPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(absPath, relPath)
      } else if (entry.isFile()) {
        files.push({ relPath, absPath })
      }
    }
  }
  visit(bundleDir, '')
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.relPath)
    hash.update('\0')
    hash.update(readFileSync(file.absPath))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Walk up from this module looking for a workspace-relative path. */
function locateWorkspacePath(...segments: string[]): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, ...segments)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function resolveRemoteServerVersion(): string {
  const envVersion = process.env['UNIVERSE_REMOTE_SERVER_VERSION']
  if (envVersion) return envVersion
  const pkgPath = locateWorkspacePath('packages', 'remote-server', 'package.json')
  if (pkgPath) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
      if (pkg.version) return pkg.version
    } catch {
      // fall through to the default
    }
  }
  return DEFAULT_SERVER_VERSION
}

export function resolveRemoteServerBundleDir(): string {
  const dir = locateWorkspacePath('packages', 'remote-server', 'dist-bundle')
  if (!dir) {
    throw new Error(
      'remote server bundle not found at packages/remote-server/dist-bundle; build it first (pnpm --filter @universe-editor/remote-server bundle)',
    )
  }
  return dir
}

// ------------------------- spawn / run seams -------------------------

export type RemoteSpawner = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

export const defaultRemoteSpawner: RemoteSpawner = (command, args, options) =>
  spawn(command, [...args], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })

export interface RemoteRunResult {
  readonly code: number | null
  readonly signal?: string | null
  readonly stdout: string
  readonly stderr: string
  /** Set when the process could not be spawned (e.g. ssh not on PATH). */
  readonly spawnError?: string
}

export type RemoteRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<RemoteRunResult>

export const defaultRemoteRunner: RemoteRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        shell: false,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: options?.timeoutMs ?? 600_000,
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        const e = error as { code?: string | number; signal?: string | null; message: string }
        if (typeof e.code === 'number') {
          resolve({ code: e.code, signal: e.signal ?? null, stdout, stderr })
        } else {
          resolve({ code: null, spawnError: e.message, stdout, stderr })
        }
      },
    )
  })

export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (address && typeof address === 'object' && typeof address.port === 'number') {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('could not allocate a free local port')))
      }
    })
  })
}

export function waitForPort(port: number, host = '127.0.0.1', timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const attempt = (): void => {
      const socket = connect({ port, host })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`forward not ready within ${timeoutMs}ms`))
        } else {
          setTimeout(attempt, 100)
        }
      })
    }
    attempt()
  })
}

// ------------------------- deployer -------------------------

export interface RemoteDeployerOptions {
  readonly runner?: RemoteRunner
  readonly spawner?: RemoteSpawner
  readonly serverVersion?: string
  readonly logger?: ILogger
  readonly bundleDir?: string
}

export type RemoteCheckResult =
  | {
      readonly state: 'running'
      readonly info: IRemoteDaemonInfo
      readonly deployedBundleHash?: string
    }
  | { readonly state: 'not-running'; readonly deployedBundleHash?: string }
  | { readonly state: 'not-deployed'; readonly reason: string }
  | { readonly state: 'error'; readonly message: string }

/**
 * Shared classification of a `bootstrap.js check` run — the ssh and wsl
 * orchestrators only differ in how the command is transported. `transport`
 * labels the fallback error message ('ssh' / 'wsl').
 */
export function classifyCheckResult(result: RemoteRunResult, transport: string): RemoteCheckResult {
  const deployedBundleHash = parseBundleHashLine(result.stdout)
  const info = parseDaemonInfoLine(result.stdout)
  if (info)
    return {
      state: 'running',
      info,
      ...(deployedBundleHash !== undefined ? { deployedBundleHash } : {}),
    }
  if (result.spawnError) return { state: 'not-deployed', reason: result.spawnError }
  if (result.code === 3)
    return {
      state: 'not-running',
      ...(deployedBundleHash !== undefined ? { deployedBundleHash } : {}),
    }
  if (
    result.code === 127 ||
    /not found|cannot find module|ENOENT|no such file/i.test(result.stderr)
  ) {
    return { state: 'not-deployed', reason: result.stderr.trim() || `exit ${result.code}` }
  }
  return {
    state: 'error',
    message:
      result.stderr.trim() || `${transport} check failed (exit ${result.code ?? result.signal})`,
  }
}

/**
 * Common daemon-orchestration surface of RemoteDeployer (ssh, target=authority)
 * and WslDeployer (wsl.exe, target=distro) — what the connection state machine
 * needs to ensure a daemon is deployed and running.
 */
export interface IRemoteServerOrchestrator {
  readonly serverVersion: string
  localBundleHash(): string | undefined
  checkRemoteServer(target: string): Promise<RemoteCheckResult>
  startRemoteDaemon(target: string): Promise<IRemoteDaemonInfo>
  stopRemoteDaemon(target: string): Promise<void>
  deployRemoteServer(target: string, logger?: ILogger): Promise<void>
}

export class RemoteDeployer {
  private readonly _runner: RemoteRunner
  private readonly _spawner: RemoteSpawner
  private readonly _serverVersion: string
  private readonly _logger: ILogger
  private readonly _bundleDir: string | undefined

  constructor(options: RemoteDeployerOptions = {}) {
    this._runner = options.runner ?? defaultRemoteRunner
    this._spawner = options.spawner ?? defaultRemoteSpawner
    this._serverVersion = options.serverVersion ?? resolveRemoteServerVersion()
    this._logger = options.logger ?? new NullLogger()
    this._bundleDir = options.bundleDir
  }

  get serverVersion(): string {
    return this._serverVersion
  }

  localBundleHash(): string | undefined {
    try {
      const bundleDir = this._bundleDir ?? resolveRemoteServerBundleDir()
      return computeBundleHash(bundleDir)
    } catch {
      // Fail-open: an unbuildable/missing bundle skips the staleness comparison.
      return undefined
    }
  }

  async checkRemoteServer(authority: string): Promise<RemoteCheckResult> {
    const result = await this._runner(
      'ssh',
      sshCommandArgs(authority, buildCheckCommand(this._serverVersion)),
    )
    return classifyCheckResult(result, 'ssh')
  }

  async startRemoteDaemon(authority: string): Promise<IRemoteDaemonInfo> {
    const result = await this._runner(
      'ssh',
      sshCommandArgs(authority, buildStartCommand(this._serverVersion)),
    )
    const info = parseDaemonInfoLine(result.stdout)
    if (!info) {
      throw new Error(
        `failed to start remote daemon for '${authority}': ${result.stderr.trim() || result.spawnError || `exit ${result.code}`}`,
      )
    }
    this._logger.info(
      `[remote:${authority}] daemon running port=${info.port} version=${info.serverVersion}`,
    )
    return info
  }

  async stopRemoteDaemon(authority: string): Promise<void> {
    const result = await this._runner(
      'ssh',
      sshCommandArgs(authority, buildStopCommand(this._serverVersion)),
    )
    if (result.code !== 0) {
      this._logger.warn(
        `[remote:${authority}] stop daemon returned exit ${result.code ?? result.signal}: ${result.stderr.trim()}`,
      )
    } else {
      this._logger.info(`[remote:${authority}] daemon stopped`)
    }
  }

  async deployRemoteServer(authority: string, logger?: ILogger): Promise<void> {
    const log = logger ?? this._logger
    const bundleDir = this._bundleDir ?? resolveRemoteServerBundleDir()
    const bundleHash = computeBundleHash(bundleDir)
    const tmpName = `universe-server-${randomBytes(6).toString('hex')}.tgz`
    const localTgz = join(tmpdir(), tmpName)
    const remoteTgz = `/tmp/${tmpName}`
    log.info(`[remote:${authority}] deploying bundle ${bundleDir} as v${this._serverVersion}`)
    try {
      // GNU tar/scp treat a `C:\...` path as host:file (remote shell syntax) and
      // which binary PATH resolves to varies per machine — run from tmpdir with a
      // bare filename so the local path never contains a colon.
      const tarResult = await this._runner('tar', ['-czf', tmpName, '-C', bundleDir, '.'], {
        cwd: tmpdir(),
      })
      if (tarResult.code !== 0) {
        throw new Error(
          `tar failed: ${tarResult.stderr.trim() || tarResult.spawnError || `exit ${tarResult.code}`}`,
        )
      }
      const scpResult = await this._runner(
        'scp',
        scpArgs(authority, tmpName, `${destination(authority)}:${remoteTgz}`),
        { cwd: tmpdir() },
      )
      if (scpResult.code !== 0) {
        throw new Error(
          `scp failed: ${scpResult.stderr.trim() || scpResult.spawnError || `exit ${scpResult.code}`}`,
        )
      }
      const installResult = await this._runner(
        'ssh',
        sshCommandArgs(
          authority,
          buildDeployRemoteScript(this._serverVersion, tmpName, bundleHash),
        ),
        { timeoutMs: 1_800_000 },
      )
      if (installResult.code !== 0) {
        throw new Error(
          `remote install failed: ${installResult.stderr.trim() || installResult.spawnError || `exit ${installResult.code}`}`,
        )
      }
      log.info(`[remote:${authority}] remote server deployed`)
    } finally {
      try {
        rmSync(localTgz, { force: true })
      } catch {
        // best effort cleanup
      }
    }
  }

  async createForward(
    authority: string,
    remotePort: number,
    logger?: ILogger,
  ): Promise<{ localPort: number; process: ManagedChildProcess; stderrSub: IDisposable }> {
    const log = logger ?? this._logger
    const localPort = await findFreePort()
    const proc = new ManagedChildProcess(
      this._spawner('ssh', forwardArgs(authority, localPort, remotePort), {
        env: buildChildEnv(process.env),
      }),
      { logger: log, label: `remote-forward:${authority}` },
    )
    const stderrSub = proc.onStderr((chunk) => {
      log.warn(`[remote:${authority}] ssh forward: ${decodeDiagnostic(chunk).trim()}`)
    })
    try {
      await waitForPort(localPort)
    } catch (err) {
      stderrSub.dispose()
      proc.dispose()
      throw err
    }
    log.info(`[remote:${authority}] ssh forward ready ${localPort} -> 127.0.0.1:${remotePort}`)
    return { localPort, process: proc, stderrSub }
  }
}
