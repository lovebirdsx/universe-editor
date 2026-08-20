/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote server daemon CLI. Four subcommands:
 *    serve [--data-dir <dir>] [--port <n>] [--token <t>]  run the daemon in the foreground
 *    start [--data-dir <dir>]                             detached-spawn serve and wait until ready
 *    check [--data-dir <dir>]                             verify a daemon is alive + version-matched
 *    stop  [--data-dir <dir>]                             stop the daemon and clean bookkeeping files
 *  (post-deploy dependency install is the separate install.js entry — see installCli.ts)
 *
 *  The data dir (default ~/.universe-editor-server) holds daemon.lock (single-instance
 *  guard), server.json (IRemoteDaemonInfo, written atomically 0600) and server.log.
 *  serve prints exactly one line to stdout — `UNIVERSE_REMOTE_DAEMON_INFO=<json>` — and
 *  nothing else; all diagnostics go to server.log + stderr.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AbstractLogger,
  LogLevel,
  REMOTE_PROTOCOL_VERSION,
  type ILogger,
  type IRemoteDaemonInfo,
} from '@universe-editor/platform'
import { createDaemon } from './daemon.js'
import { BUNDLE_HASH_FILE } from './install.js'
import { SERVER_VERSION } from './version.js'

const DEFAULT_DATA_DIR = path.join(homedir(), '.universe-editor-server')
const INFO_PREFIX = 'UNIVERSE_REMOTE_DAEMON_INFO='
const BUNDLE_HASH_PREFIX = 'UNIVERSE_REMOTE_BUNDLE_HASH='
const START_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 3_000

interface CliOptions {
  dataDir: string
  port?: number
  token?: string
}

class AlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`daemon already running (pid ${pid})`)
    this.name = 'AlreadyRunningError'
  }
}

class CheckError extends Error {
  constructor(
    readonly code: 'not-running' | 'version-mismatch',
    message: string,
  ) {
    super(message)
    this.name = 'CheckError'
  }
}

class DaemonLogger extends AbstractLogger {
  constructor(private readonly _stream: WriteStream) {
    super(LogLevel.Info)
  }

  protected override _log(_level: LogLevel, message: string): void {
    const line = `[${new Date().toISOString()}] ${message}\n`
    this._stream.write(line)
    process.stderr.write(line)
  }

  override dispose(): void {
    this._stream.end()
    super.dispose()
  }
}

function createDaemonLogger(dataDir: string): ILogger {
  return new DaemonLogger(createWriteStream(path.join(dataDir, 'server.log'), { flags: 'a' }))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Content hash of the deployed tree, written next to bootstrap.js by the deployer. */
function readBundleHash(): string | undefined {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const value = readFileSync(path.join(dir, BUNDLE_HASH_FILE), 'utf8').trim()
    return value || undefined
  } catch {
    return undefined
  }
}

async function readServerInfo(dataDir: string): Promise<IRemoteDaemonInfo | undefined> {
  try {
    const raw = await readFile(path.join(dataDir, 'server.json'), 'utf8')
    const parsed = JSON.parse(raw) as IRemoteDaemonInfo
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function writeServerInfo(dataDir: string, info: IRemoteDaemonInfo): Promise<void> {
  const target = path.join(dataDir, 'server.json')
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 })
  try {
    await rename(tmp, target)
  } catch {
    await rm(target, { force: true })
    await rename(tmp, target)
  }
}

async function cleanupFiles(dataDir: string): Promise<void> {
  await rm(path.join(dataDir, 'server.json'), { force: true })
  await rm(path.join(dataDir, 'daemon.lock'), { force: true })
}

async function acquireLock(dataDir: string): Promise<void> {
  const lockPath = path.join(dataDir, 'daemon.lock')
  try {
    await writeFile(lockPath, String(process.pid), { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const raw = await readFile(lockPath, 'utf8').catch(() => '')
    const pid = Number(raw)
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
      throw new AlreadyRunningError(pid)
    }
    // Stale lock from a dead daemon: take it over.
    await writeFile(lockPath, String(process.pid))
  }
}

async function serve(opts: CliOptions): Promise<void> {
  await mkdir(opts.dataDir, { recursive: true })
  await acquireLock(opts.dataDir)

  const logger = createDaemonLogger(opts.dataDir)
  logger.info(`[remote-server] serve starting (data-dir ${opts.dataDir})`)

  const daemon = await createDaemon({
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    dataDir: opts.dataDir,
    logger,
  })

  const info: IRemoteDaemonInfo = {
    serverVersion: SERVER_VERSION,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    port: daemon.port,
    token: daemon.token,
    pid: process.pid,
  }
  await writeServerInfo(opts.dataDir, info)
  process.stdout.write(`${INFO_PREFIX}${JSON.stringify(info)}\n`)
  logger.info(`[remote-server] ready on 127.0.0.1:${daemon.port}`)

  let shuttingDown = false
  const shutdown = (reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`[remote-server] shutdown (${reason})`)
    void (async () => {
      try {
        await daemon.dispose()
      } catch (err) {
        logger.error(`[remote-server] shutdown dispose failed: ${(err as Error).message}`)
      }
      await cleanupFiles(opts.dataDir)
      logger.dispose()
      process.exit(0)
    })()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

function toWindowsCommandLine(argv: readonly string[]): string {
  return argv.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')
}

/**
 * Windows OpenSSH wraps each session in a kill-on-close job object, so a plain
 * detached spawn dies with the SSH session (node cannot pass
 * CREATE_BREAKAWAY_FROM_JOB — vscode's rust CLI can). Win32_Process.Create runs
 * the daemon from the WMI provider host instead, outside that job.
 */
export function buildWindowsDaemonLaunch(argv: readonly string[]): {
  file: string
  args: string[]
} {
  const commandLine = toWindowsCommandLine(argv)
  const script = [
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' }`,
    'exit $r.ReturnValue',
  ].join('; ')
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  return {
    file: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  }
}

function spawnDaemonWindows(argv: readonly string[]): Promise<void> {
  const launch = buildWindowsDaemonLaunch(argv)
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else {
        reject(
          new Error(
            `Win32_Process.Create failed (exit ${code})${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        )
      }
    })
  })
}

async function startDaemon(dataDir: string): Promise<void> {
  const script = path.resolve(process.argv[1] ?? '')
  const serveArgv = [process.execPath, script, 'serve', '--data-dir', dataDir]
  if (process.platform === 'win32') {
    await spawnDaemonWindows(serveArgv)
  } else {
    const child = spawn(process.execPath, serveArgv.slice(1), {
      // detached = setsid: escape the caller's SIGHUP when the SSH session ends.
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    const info = await readServerInfo(dataDir)
    if (info && isAlive(info.pid)) {
      printInfo(info)
      return
    }
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for server.json')
    }
    await sleep(100)
  }
}

async function checkDaemon(dataDir: string): Promise<void> {
  // Emit the bundle hash before any liveness check so a not-running daemon still
  // reports it — the client compares it against the local build to detect a
  // stale deploy under the constant dev version 0.0.0.
  process.stdout.write(`${BUNDLE_HASH_PREFIX}${readBundleHash() ?? ''}\n`)
  const info = await readServerInfo(dataDir)
  if (!info) {
    throw new CheckError('not-running', 'server is not running (no server.json)')
  }
  if (!isAlive(info.pid)) {
    throw new CheckError('not-running', `server pid ${info.pid} is not alive`)
  }
  if (info.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    throw new CheckError(
      'version-mismatch',
      `protocol version ${info.protocolVersion} != ${REMOTE_PROTOCOL_VERSION}`,
    )
  }
  if (info.serverVersion !== SERVER_VERSION) {
    throw new CheckError(
      'version-mismatch',
      `server version ${info.serverVersion} != ${SERVER_VERSION}`,
    )
  }
  printInfo(info)
}

export type KillSpawner = (command: string, args: readonly string[]) => Promise<void>

/** Spawn and swallow the result — a tree-kill of an already-gone pid is not an error. */
export const defaultKillSpawner: KillSpawner = (command, args) =>
  new Promise<void>((resolve) => {
    const child = spawn(command, [...args], { shell: false, windowsHide: true })
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })

export function killProcessTree(
  pid: number,
  spawner: KillSpawner = defaultKillSpawner,
): Promise<void> {
  return spawner('taskkill', ['/pid', String(pid), '/t', '/f'])
}

async function stopDaemon(dataDir: string): Promise<void> {
  const info = await readServerInfo(dataDir)
  if (info && isAlive(info.pid)) {
    if (process.platform === 'win32') {
      // process.kill maps to TerminateProcess on Windows and leaves the process
      // tree (exthost/pty/agent) orphaned — taskkill /t kills the whole tree.
      await killProcessTree(info.pid)
      const deadline = Date.now() + STOP_TIMEOUT_MS
      while (isAlive(info.pid) && Date.now() < deadline) {
        await sleep(100)
      }
      if (isAlive(info.pid)) {
        // No second-stage kill exists on Windows (taskkill /f already is one);
        // leave a trace before the bookkeeping cleanup orphans the daemon.
        process.stderr.write(
          `warning: daemon pid ${info.pid} still alive after taskkill; cleaning bookkeeping files anyway\n`,
        )
      }
    } else {
      try {
        process.kill(info.pid, 'SIGTERM')
      } catch {
        // already gone
      }
      const deadline = Date.now() + STOP_TIMEOUT_MS
      while (isAlive(info.pid) && Date.now() < deadline) {
        await sleep(100)
      }
      if (isAlive(info.pid)) {
        try {
          process.kill(info.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }
  await cleanupFiles(dataDir)
}

function printInfo(info: IRemoteDaemonInfo): void {
  process.stdout.write(`${INFO_PREFIX}${JSON.stringify(info)}\n`)
}

function parseOptions(args: string[]): CliOptions {
  const opts: CliOptions = { dataDir: DEFAULT_DATA_DIR }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (flag === '--data-dir') {
      const value = args[i + 1]
      if (value !== undefined) {
        opts.dataDir = value
        i++
      }
    } else if (flag === '--port') {
      const value = args[i + 1]
      if (value !== undefined) {
        const port = Number(value)
        if (Number.isFinite(port)) {
          opts.port = Math.floor(port)
        }
        i++
      }
    } else if (flag === '--token') {
      const value = args[i + 1]
      if (value !== undefined) {
        opts.token = value
        i++
      }
    }
  }
  return opts
}

function printUsage(): void {
  process.stderr.write(
    [
      'usage: universe-editor-server <command> [options]',
      '',
      'commands:',
      '  serve  run the daemon in the foreground',
      '  start  detached-spawn serve and wait until ready',
      '  check  verify the daemon is alive and version-matched (exit 3 otherwise)',
      '  stop   stop the daemon and clean bookkeeping files',
      '',
      'options:',
      '  --data-dir <dir>  data directory (default ~/.universe-editor-server)',
      '  --port <n>        serve: fixed listen port (default: ephemeral)',
      '  --token <t>       serve: fixed connection token (default: random)',
      '',
    ].join('\n'),
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    printUsage()
    process.exit(1)
  }

  const opts = parseOptions(argv.slice(1))
  try {
    switch (command) {
      case 'serve':
        await serve(opts)
        break
      case 'start':
        await startDaemon(opts.dataDir)
        break
      case 'check':
        await checkDaemon(opts.dataDir)
        break
      case 'stop':
        await stopDaemon(opts.dataDir)
        break
      default:
        printUsage()
        process.exit(1)
    }
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      process.stderr.write(`already running (pid ${err.pid})\n`)
      process.exit(2)
    }
    if (err instanceof CheckError) {
      process.stderr.write(`${err.code}: ${err.message}\n`)
      process.exit(3)
    }
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main()
}
