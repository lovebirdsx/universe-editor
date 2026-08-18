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
import { createWriteStream, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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
// Reserved exit code for "node not on the remote PATH" — kept clear of the shell
// codes the probe collides with (127 command-not-found, 3 check not-running, 2/1).
const NODE_MISSING_EXIT_CODE = 40
export const NODE_RUNTIME_VERSION = '24.19.0'
const NODE_RUNTIME_DIR = `$HOME/.universe-editor-server/node/v${NODE_RUNTIME_VERSION}`
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

/**
 * Tail-append the private node runtime bin dir to PATH: a system node (when
 * present) keeps winning, and the fallback only resolves when `command -v node`
 * would otherwise fail. `$HOME` (not `~`) so the assignment expands in the
 * remote shell; no single quotes so it survives the `sh -c '...'` wrapper.
 */
function nodePathPrelude(): string {
  return `PATH="$PATH:${NODE_RUNTIME_DIR}/bin"; `
}

export function buildCheckCommand(version: string): string {
  return `${nodePathPrelude()}command -v node >/dev/null 2>&1 || exit ${NODE_MISSING_EXIT_CODE}; node ${serverBootstrapPath(version)} check`
}

export function buildStartCommand(version: string): string {
  return `${nodePathPrelude()}node ${serverBootstrapPath(version)} start`
}

export function buildStopCommand(version: string): string {
  return `${nodePathPrelude()}node ${serverBootstrapPath(version)} stop`
}

export function buildDeployScriptBody(
  version: string,
  tmpName: string,
  bundleHash: string,
): string {
  const dir = `${DATA_DIR}/${version}`
  // Vendored ACP agents ship without node_modules (client-platform binaries must
  // not cross the wire); `npm ci --omit=dev --omit=optional` in each vendor dir
  // resolves the remote host's own platform packages. `--omit=optional` skips the
  // native agent binaries (claude's @anthropic-ai/claude-agent-sdk-* / codex's
  // @openai/codex platform packages, ~500MB total) — those are now downloaded on
  // demand by the AgentBinary channel instead of being pulled in by npm.
  const vendorInstall = `for v in vendor/claude-agent-acp vendor/codex-acp; do if [ -d "$v" ]; then (cd "$v" && npm ci --omit=dev --omit=optional --no-audit --no-fund); fi; done`
  // The bundle.hash marker is written only after npm install + vendor install
  // both succeed: a mid-install failure must not leave a "complete install"
  // marker that would later make `check` skip the redeploy.
  return `${nodePathPrelude()}mkdir -p ${dir} && tar xzf /tmp/${tmpName} -C ${dir} && cd ${dir} && npm install --omit=dev --no-audit --no-fund && ${vendorInstall} && printf %s "${bundleHash}" > ${BUNDLE_HASH_FILE} && rm /tmp/${tmpName}`
}

export function buildDeployRemoteScript(
  version: string,
  tmpName: string,
  bundleHash: string,
): string {
  return `sh -c '${buildDeployScriptBody(version, tmpName, bundleHash)}'`
}

// ------------------------- node runtime provisioning -------------------------

export type NodeArtifactResolution =
  | { readonly platformKey: string; readonly fileName: string }
  | { readonly error: string }

export function buildUnameCommand(): string {
  return 'uname -sm; (ldd --version 2>&1 || true) | head -n 1'
}

/** Map `uname -sm` + the first `ldd --version` line to a Node.js dist filename. */
export function resolveNodeArtifact(output: string): NodeArtifactResolution {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const uname = lines[0] ?? ''
  const lddLine = lines.find((line) => line !== uname) ?? ''
  if (/musl/i.test(lddLine)) {
    return {
      error:
        'musl libc (e.g. Alpine Linux) is not supported by the official Node.js binaries. Install Node.js 20 or later manually and reconnect.',
    }
  }
  const [os, machine] = uname.split(/\s+/)
  let platformKey: string | undefined
  if (os === 'Linux') {
    if (machine === 'x86_64') platformKey = 'linux-x64'
    else if (machine === 'aarch64' || machine === 'arm64') platformKey = 'linux-arm64'
    else if (machine === 'armv7l') platformKey = 'linux-armv7l'
  } else if (os === 'Darwin') {
    if (machine === 'x86_64') platformKey = 'darwin-x64'
    else if (machine === 'arm64') platformKey = 'darwin-arm64'
  }
  if (platformKey === undefined) {
    return {
      error: `unsupported remote platform '${uname || '(unknown)'}'. Install Node.js 20 or later manually on the remote machine and reconnect.`,
    }
  }
  return { platformKey, fileName: `node-v${NODE_RUNTIME_VERSION}-${platformKey}.tar.gz` }
}

export type NodeArchiveFetcher = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly body: ReadableStream<Uint8Array> | null
}>

/** Stream the official Node.js archive to `destPath`, falling back to a mirror. */
export async function downloadNodeArchive(
  fileName: string,
  destPath: string,
  logger: ILogger,
  fetchImpl: NodeArchiveFetcher = fetch,
): Promise<void> {
  const urls = [
    `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${fileName}`,
    `https://npmmirror.com/mirrors/node/v${NODE_RUNTIME_VERSION}/${fileName}`,
  ]
  let lastError: Error | undefined
  for (const url of urls) {
    const startedAt = Date.now()
    try {
      logger.info(`[remote] downloading node runtime from ${url}`)
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(600_000) })
      if (!res.ok || !res.body) {
        const err = new Error(`download returned HTTP ${res.status}`)
        logger.warn(`[remote] node runtime download failed: ${err.message}`)
        lastError = err
        continue
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath))
      logger.info(`[remote] node runtime downloaded in ${Date.now() - startedAt}ms`)
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`[remote] node runtime download failed from ${url}: ${message}`)
      lastError = err instanceof Error ? err : new Error(message)
    }
  }
  throw new Error(
    `failed to download Node.js ${NODE_RUNTIME_VERSION} runtime (tried ${urls.join(', ')})${lastError ? `: ${lastError.message}` : ''}`,
  )
}

export function buildNodeInstallScriptBody(tmpName: string): string {
  const dir = NODE_RUNTIME_DIR
  return `dir="${dir}"; rm -rf "$dir.tmp" && mkdir -p "$dir.tmp" && tar xzf /tmp/${tmpName} -C "$dir.tmp" --strip-components=1 && rm -rf "$dir" && mv "$dir.tmp" "$dir" && rm -f /tmp/${tmpName} && "$dir/bin/node" --version`
}

export function buildNodeInstallRemoteScript(tmpName: string): string {
  return `sh -c '${buildNodeInstallScriptBody(tmpName)}'`
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
  readonly nodeArchiveFetcher?: NodeArchiveFetcher
}

export type RemoteCheckResult =
  | {
      readonly state: 'running'
      readonly info: IRemoteDaemonInfo
      readonly deployedBundleHash?: string
    }
  | { readonly state: 'not-running'; readonly deployedBundleHash?: string }
  | { readonly state: 'not-deployed'; readonly reason: string }
  | { readonly state: 'node-missing' }
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
  if (result.code === NODE_MISSING_EXIT_CODE) return { state: 'node-missing' }
  if (
    result.code === 127 ||
    /not found|cannot find module|cannot find package|ERR_MODULE_NOT_FOUND|ENOENT|no such file/i.test(
      result.stderr,
    )
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
export type RemoteDeployPhase = 'uploading' | 'installing'

export interface IRemoteServerOrchestrator {
  readonly serverVersion: string
  localBundleHash(): string | undefined
  checkRemoteServer(target: string): Promise<RemoteCheckResult>
  startRemoteDaemon(target: string): Promise<IRemoteDaemonInfo>
  stopRemoteDaemon(target: string): Promise<void>
  deployRemoteServer(
    target: string,
    logger?: ILogger,
    onPhase?: (phase: RemoteDeployPhase) => void,
  ): Promise<void>
  provisionNodeRuntime(target: string, logger?: ILogger): Promise<void>
}

export class RemoteDeployer {
  private readonly _runner: RemoteRunner
  private readonly _spawner: RemoteSpawner
  private readonly _serverVersion: string
  private readonly _logger: ILogger
  private readonly _bundleDir: string | undefined
  private readonly _nodeArchiveFetcher: NodeArchiveFetcher

  constructor(options: RemoteDeployerOptions = {}) {
    this._runner = options.runner ?? defaultRemoteRunner
    this._spawner = options.spawner ?? defaultRemoteSpawner
    this._serverVersion = options.serverVersion ?? resolveRemoteServerVersion()
    this._logger = options.logger ?? new NullLogger()
    this._bundleDir = options.bundleDir
    this._nodeArchiveFetcher = options.nodeArchiveFetcher ?? fetch
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
    const startedAt = Date.now()
    this._logger.info(`[remote:${authority}] starting remote daemon`)
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
    this._logger.info(`[remote:${authority}] daemon started in ${Date.now() - startedAt}ms`)
    return info
  }

  async stopRemoteDaemon(authority: string): Promise<void> {
    this._logger.info(`[remote:${authority}] stopping remote daemon`)
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

  async deployRemoteServer(
    authority: string,
    logger?: ILogger,
    onPhase?: (phase: RemoteDeployPhase) => void,
  ): Promise<void> {
    const log = logger ?? this._logger
    const startedAt = Date.now()
    const bundleDir = this._bundleDir ?? resolveRemoteServerBundleDir()
    const bundleHash = computeBundleHash(bundleDir)
    const tmpName = `universe-server-${randomBytes(6).toString('hex')}.tgz`
    const localTgz = join(tmpdir(), tmpName)
    const remoteTgz = `/tmp/${tmpName}`
    log.info(`[remote:${authority}] deploying bundle ${bundleDir} as v${this._serverVersion}`)
    try {
      onPhase?.('uploading')
      // GNU tar/scp treat a `C:\...` path as host:file (remote shell syntax) and
      // which binary PATH resolves to varies per machine — run from tmpdir with a
      // bare filename so the local path never contains a colon.
      const tarStarted = Date.now()
      const tarResult = await this._runner('tar', ['-czf', tmpName, '-C', bundleDir, '.'], {
        cwd: tmpdir(),
      })
      if (tarResult.code !== 0) {
        throw new Error(
          `tar failed: ${tarResult.stderr.trim() || tarResult.spawnError || `exit ${tarResult.code}`}`,
        )
      }
      log.info(`[remote:${authority}] bundle packaged in ${Date.now() - tarStarted}ms`)
      const scpStarted = Date.now()
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
      log.info(`[remote:${authority}] bundle uploaded in ${Date.now() - scpStarted}ms`)
      onPhase?.('installing')
      const installStarted = Date.now()
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
      log.info(`[remote:${authority}] remote install completed in ${Date.now() - installStarted}ms`)
      log.info(`[remote:${authority}] remote server deployed in ${Date.now() - startedAt}ms`)
    } finally {
      try {
        rmSync(localTgz, { force: true })
      } catch {
        // best effort cleanup
      }
    }
  }

  async provisionNodeRuntime(authority: string, logger?: ILogger): Promise<void> {
    const log = logger ?? this._logger
    const startedAt = Date.now()
    log.info(
      `[remote:${authority}] Node.js missing; provisioning private runtime v${NODE_RUNTIME_VERSION}`,
    )
    const probeResult = await this._runner('ssh', sshCommandArgs(authority, buildUnameCommand()))
    if (probeResult.code !== 0) {
      throw new Error(
        `failed to probe remote platform: ${probeResult.stderr.trim() || probeResult.spawnError || `exit ${probeResult.code}`}`,
      )
    }
    const resolution = resolveNodeArtifact(probeResult.stdout)
    if ('error' in resolution) throw new Error(resolution.error)
    log.info(`[remote:${authority}] remote platform '${resolution.platformKey}'`)
    const tmpName = `node-runtime-${randomBytes(6).toString('hex')}.tar.gz`
    const localTgz = join(tmpdir(), tmpName)
    const remoteTgz = `/tmp/${tmpName}`
    try {
      await downloadNodeArchive(resolution.fileName, localTgz, log, this._nodeArchiveFetcher)
      const scpStarted = Date.now()
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
      log.info(`[remote:${authority}] node runtime uploaded in ${Date.now() - scpStarted}ms`)
      const installStarted = Date.now()
      const installResult = await this._runner(
        'ssh',
        sshCommandArgs(authority, buildNodeInstallRemoteScript(tmpName)),
        { timeoutMs: 300_000 },
      )
      if (installResult.code !== 0) {
        throw new Error(
          `remote node install failed: ${installResult.stderr.trim() || installResult.spawnError || `exit ${installResult.code}`}`,
        )
      }
      if (!installResult.stdout.includes(`v${NODE_RUNTIME_VERSION}`)) {
        throw new Error(
          `remote node install self-check failed: ${installResult.stdout.trim() || '(no output)'}`,
        )
      }
      log.info(`[remote:${authority}] node runtime installed in ${Date.now() - installStarted}ms`)
      log.info(`[remote:${authority}] node runtime provisioned in ${Date.now() - startedAt}ms`)
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
