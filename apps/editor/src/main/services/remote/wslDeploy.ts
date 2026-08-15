/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  wsl.exe orchestration for the remote server daemon inside a local WSL distro.
 *  Mirrors RemoteDeployer (check/start/stop/deploy) minus createForward — the
 *  daemon's 127.0.0.1 port is reachable directly from Windows for both WSL1
 *  (shared network stack) and WSL2 (localhost forwarding). Commands run via
 *  `wsl.exe -d <distro> -e bash -lc <cmd>`: `-e` execs without the default-shell
 *  wrapper (argv passes through verbatim), `bash -lc` sources the login profile
 *  so nvm-style PATH setups resolve node (VSCode agent-host parity). The bundle
 *  uploads through a stdin pipe (`cat > /tmp/<name>`) — never via /mnt automount
 *  or the \\wsl$ UNC share. Logs liberally: this chain is the WSL debugging
 *  lifeline.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { NullLogger, type ILogger, type IRemoteDaemonInfo } from '@universe-editor/platform'
import { buildChildEnv } from '../process/env.js'
import {
  buildCheckCommand,
  buildDeployScriptBody,
  buildStartCommand,
  buildStopCommand,
  classifyCheckResult,
  computeBundleHash,
  defaultRemoteRunner,
  defaultRemoteSpawner,
  parseDaemonInfoLine,
  resolveRemoteServerBundleDir,
  resolveRemoteServerVersion,
  type RemoteCheckResult,
  type RemoteDeployPhase,
  type RemoteRunner,
  type RemoteSpawner,
} from './remoteDeploy.js'
import { getWslExePath } from './wslTargets.js'

export function wslCommandArgs(distro: string, command: string): string[] {
  return ['-d', distro, '-e', 'bash', '-lc', command]
}

/**
 * wsl.exe writes its own diagnostics (e.g. "there is no distribution ...") as
 * UTF-16LE while the runner decodes utf8, interleaving NULs into every other
 * byte — strip them before the text reaches error messages or regexes.
 */
export function stripWslNuls(text: string): string {
  return text.replace(/\0/g, '')
}

export interface WslDeployerOptions {
  readonly runner?: RemoteRunner
  readonly spawner?: RemoteSpawner
  readonly serverVersion?: string
  readonly logger?: ILogger
  readonly bundleDir?: string
  /** Test seam — production resolves via getWslExePath(). */
  readonly wslExePath?: string
}

export class WslDeployer {
  private readonly _runner: RemoteRunner
  private readonly _spawner: RemoteSpawner
  private readonly _serverVersion: string
  private readonly _logger: ILogger
  private readonly _bundleDir: string | undefined
  private readonly _wslExePath: string | undefined

  constructor(options: WslDeployerOptions = {}) {
    this._runner = options.runner ?? defaultRemoteRunner
    this._spawner = options.spawner ?? defaultRemoteSpawner
    this._serverVersion = options.serverVersion ?? resolveRemoteServerVersion()
    this._logger = options.logger ?? new NullLogger()
    this._bundleDir = options.bundleDir
    this._wslExePath = options.wslExePath
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

  private _wslExe(): string {
    const wslPath = this._wslExePath ?? getWslExePath()
    if (!wslPath) {
      throw new Error('wsl.exe not found — WSL is not installed or this is not Windows')
    }
    return wslPath
  }

  async checkRemoteServer(distro: string): Promise<RemoteCheckResult> {
    const result = await this._runner(
      this._wslExe(),
      wslCommandArgs(distro, buildCheckCommand(this._serverVersion)),
    )
    return classifyCheckResult({ ...result, stderr: stripWslNuls(result.stderr) }, 'wsl')
  }

  async startRemoteDaemon(distro: string): Promise<IRemoteDaemonInfo> {
    const startedAt = Date.now()
    this._logger.info(`[wsl:${distro}] starting daemon`)
    const result = await this._runner(
      this._wslExe(),
      wslCommandArgs(distro, buildStartCommand(this._serverVersion)),
    )
    const info = parseDaemonInfoLine(result.stdout)
    if (!info) {
      throw new Error(
        `failed to start WSL daemon in '${distro}': ${stripWslNuls(result.stderr).trim() || result.spawnError || `exit ${result.code}`}`,
      )
    }
    this._logger.info(
      `[wsl:${distro}] daemon running port=${info.port} version=${info.serverVersion}`,
    )
    this._logger.info(`[wsl:${distro}] daemon started in ${Date.now() - startedAt}ms`)
    return info
  }

  async stopRemoteDaemon(distro: string): Promise<void> {
    this._logger.info(`[wsl:${distro}] stopping daemon`)
    const result = await this._runner(
      this._wslExe(),
      wslCommandArgs(distro, buildStopCommand(this._serverVersion)),
    )
    if (result.code !== 0) {
      this._logger.warn(
        `[wsl:${distro}] stop daemon returned exit ${result.code ?? result.signal}: ${stripWslNuls(result.stderr).trim()}`,
      )
    } else {
      this._logger.info(`[wsl:${distro}] daemon stopped`)
    }
  }

  async deployRemoteServer(
    distro: string,
    logger?: ILogger,
    onPhase?: (phase: RemoteDeployPhase) => void,
  ): Promise<void> {
    const log = logger ?? this._logger
    const startedAt = Date.now()
    const bundleDir = this._bundleDir ?? resolveRemoteServerBundleDir()
    const bundleHash = computeBundleHash(bundleDir)
    const tmpName = `universe-server-${randomBytes(6).toString('hex')}.tgz`
    const localTgz = join(tmpdir(), tmpName)
    log.info(`[wsl:${distro}] deploying bundle ${bundleDir} as v${this._serverVersion}`)
    try {
      onPhase?.('uploading')
      // Same colon-in-path dodge as the ssh deployer: run tar from tmpdir with a
      // bare filename so GNU tar never sees `C:\...` as host:file.
      const tarStarted = Date.now()
      const tarResult = await this._runner('tar', ['-czf', tmpName, '-C', bundleDir, '.'], {
        cwd: tmpdir(),
      })
      if (tarResult.code !== 0) {
        throw new Error(
          `tar failed: ${tarResult.stderr.trim() || tarResult.spawnError || `exit ${tarResult.code}`}`,
        )
      }
      log.info(`[wsl:${distro}] bundle packaged in ${Date.now() - tarStarted}ms`)
      const uploadStarted = Date.now()
      await this._uploadViaStdin(distro, localTgz, tmpName, log)
      log.info(`[wsl:${distro}] bundle uploaded in ${Date.now() - uploadStarted}ms`)
      onPhase?.('installing')
      const installStarted = Date.now()
      const installResult = await this._runner(
        this._wslExe(),
        wslCommandArgs(distro, buildDeployScriptBody(this._serverVersion, tmpName, bundleHash)),
        { timeoutMs: 1_800_000 },
      )
      if (installResult.code !== 0) {
        throw new Error(
          `wsl install failed: ${stripWslNuls(installResult.stderr).trim() || installResult.spawnError || `exit ${installResult.code}`}`,
        )
      }
      log.info(`[wsl:${distro}] remote install completed in ${Date.now() - installStarted}ms`)
      log.info(`[wsl:${distro}] remote server deployed in ${Date.now() - startedAt}ms`)
    } finally {
      try {
        rmSync(localTgz, { force: true })
      } catch {
        // best effort cleanup
      }
    }
  }

  private _uploadViaStdin(
    distro: string,
    localTgz: string,
    tmpName: string,
    log: ILogger,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = this._spawner(this._wslExe(), wslCommandArgs(distro, `cat > /tmp/${tmpName}`), {
        env: buildChildEnv(process.env),
      })
      let stderr = ''
      let settled = false
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      proc.on('error', (err) => settle(new Error(`wsl upload spawn failed: ${err.message}`)))
      proc.on('close', (code) => {
        if (code === 0) {
          log.info(`[wsl:${distro}] bundle uploaded to /tmp/${tmpName}`)
          settle()
        } else {
          settle(new Error(`wsl upload failed (exit ${code}): ${stripWslNuls(stderr).trim()}`))
        }
      })
      const stream = createReadStream(localTgz)
      stream.on('error', (err) => {
        proc.kill()
        settle(new Error(`wsl upload failed reading ${localTgz}: ${err.message}`))
      })
      stream.pipe(proc.stdin)
    })
  }
}
