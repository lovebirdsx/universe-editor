/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves the native `codex` binary the built-in Codex agent drives. The
 *  bundled codex-acp adapter (JS) spawns it directly when `CODEX_PATH` points at
 *  it, so we only need the native Rust executable — shipped as the platform
 *  version of `@openai/codex` (e.g. `@openai/codex@<ver>-win32-x64`), and
 *  deliberately NOT packaged (~300MB). Instead it is:
 *    - downloaded on demand from the npm registry into userData (default), or
 *    - reused from a system `codex` install, or
 *    - taken from a user-provided custom path.
 *  The download itself lives in the shared AgentBinaryStore (node-services) so
 *  the remote server can reuse it verbatim; this shell only owns the system/
 *  custom resolution and the wire contract.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import * as path from 'node:path'
import { app } from 'electron'
import {
  type AgentBinaryVersionPolicy,
  createNamedLogger,
  Disposable,
  Emitter,
  type ILogger,
  ILoggerService,
  localize,
  RemoteChannels,
} from '@universe-editor/platform'
import {
  AgentBinaryStore,
  codexFlavor,
  compareBinaryVersions,
  parseBinaryVersion,
  probeBinaryVersion,
  type AgentBinaryFlavor,
  type IRemoteAgentBinaryService,
} from '@universe-editor/node-services'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import type {
  ICodexBinaryDownloadEvent,
  ICodexBinaryResolveOptions,
  ICodexBinaryResult,
  ICodexBinaryService,
  ICodexBinaryVersionInfo,
} from '../../../shared/ipc/codexBinaryService.js'

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Cache key of a download-mode resolve. The policy is part of it: the same
 * options must not hand a caller the path resolved under the other policy after
 * the user locked or unlocked version selection mid-session.
 */
function resolveCacheKey(opts: ICodexBinaryResolveOptions): string {
  return `${opts.policy}:${opts.source}:${opts.customPath ?? ''}${opts.allowDownload === false ? ':noDownload' : ''}`
}

/** The download-mode keys, spelled the way `resolveCacheKey` builds them. */
function downloadResolveKey(policy: AgentBinaryVersionPolicy, allowDownload: boolean): string {
  return `${policy}:download:${allowDownload ? '' : ':noDownload'}`
}

export class CodexBinaryMainService extends Disposable implements ICodexBinaryService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeDownload = this._register(new Emitter<ICodexBinaryDownloadEvent>())
  readonly onDidChangeDownload = this._onDidChangeDownload.event

  /** De-dupes concurrent resolves and caches the resolved path per options. */
  private readonly _inflight = new Map<string, Promise<ICodexBinaryResult>>()

  private readonly _logger: ILogger
  private readonly _flavor: AgentBinaryFlavor
  private readonly _binaryStore: AgentBinaryStore

  private readonly _remoteDownloadBound = new Set<string>()

  constructor(
    @ILoggerService loggerService?: ILoggerService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'codexBinary', name: 'Codex Binary' })
    this._flavor = codexFlavor
    this._binaryStore = this._register(
      new AgentBinaryStore({
        baseDir: path.join(app.getPath('userData'), 'codex-bin'),
        flavor: this._flavor,
        ...(loggerService !== undefined ? { logger: loggerService } : {}),
      }),
    )
    this._register(
      this._binaryStore.onDidChangeDownload((downloads) => {
        this._onDidChangeDownload.fire({ downloads })
      }),
    )
    // `_inflight` caches a path for the rest of the session; the pointer moving is
    // what makes it stale, and the locked policy moves it with no download at all.
    this._register(this._binaryStore.onDidChangeActiveVersion(() => this._evictResolveCache()))
  }

  resolve(opts: ICodexBinaryResolveOptions): Promise<ICodexBinaryResult> {
    if (opts.authority !== undefined) {
      return this._resolveRemote(opts.authority, opts.allowDownload, opts.policy)
    }
    // A download-mode probe with `allowDownload:false` is deliberately never cached:
    // its *success* may be a below-pin fallback, and the `.active` flip that ends
    // that state can come from another process (a second editor window), which the
    // store's in-process eviction cannot observe. Re-running costs a few
    // `pathExists` calls; the store still de-dupes concurrent probes itself. Every
    // other combination is keyed by `resolveCacheKey` — policy included, so locking
    // or unlocking version selection mid-session can never reuse the other mode's
    // resolved path.
    if (opts.source !== 'custom' && opts.source !== 'system' && opts.allowDownload === false) {
      return this._resolve(opts)
    }
    const key = resolveCacheKey(opts)
    let pending = this._inflight.get(key)
    if (!pending) {
      pending = this._resolve(opts).catch((err) => {
        // Don't cache failures — let the next attempt retry.
        this._inflight.delete(key)
        throw err
      })
      this._inflight.set(key, pending)
    }
    return pending
  }

  private async _resolve(opts: ICodexBinaryResolveOptions): Promise<ICodexBinaryResult> {
    switch (opts.source) {
      case 'custom':
        return this._resolveCustom(opts.customPath)
      case 'system':
        return { path: await this._resolveSystem() }
      case 'download':
      default:
        return {
          path: await this._binaryStore.resolveDownload(opts.allowDownload ?? true, opts.policy),
        }
    }
  }

  private async _resolveRemote(
    authority: string,
    allowDownload: boolean | undefined,
    policy: AgentBinaryVersionPolicy,
  ): Promise<ICodexBinaryResult> {
    const service = this._remoteService(authority)
    const { path } = await service.resolve('codex', {
      policy,
      ...(allowDownload !== undefined ? { allowDownload } : {}),
    })
    return { path }
  }

  private _remoteService(authority: string): IRemoteAgentBinaryService {
    if (!this._connections) {
      throw new Error('codexBinary: remote connection service not available')
    }
    const service = this._connections.getServiceProxy<IRemoteAgentBinaryService>(
      authority,
      RemoteChannels.AgentBinary,
    )
    if (!this._remoteDownloadBound.has(authority)) {
      this._remoteDownloadBound.add(authority)
      this._register(
        service.onDidChangeDownload((e) => {
          if (e.agent !== 'codex') return
          this._onDidChangeDownload.fire({ downloads: e.downloads, authority })
        }),
      )
    }
    return service
  }

  private async _resolveCustom(customPath: string | undefined): Promise<ICodexBinaryResult> {
    if (!customPath) {
      throw new Error(
        localize(
          'codexBinary.error.noCustomPath',
          'Codex binary: custom source selected but no path is configured.',
        ),
      )
    }
    if (!(await pathExists(customPath))) {
      throw new Error(
        localize(
          'codexBinary.error.customPathNotFound',
          'Codex binary not found at configured path: {path}',
          { path: customPath },
        ),
      )
    }
    await this._assertBinaryNotOlder(customPath, (found, required) => {
      return new Error(
        localize(
          'codexBinary.error.customBinaryTooOld',
          'The configured Codex binary is version {found}, older than the {required} this build ' +
            'requires. Point `acp.codex.executablePath` at a newer binary, or switch ' +
            '`acp.codex.source` to "download".',
          { found, required },
        ),
      )
    })
    return { path: customPath }
  }

  private async _resolveSystem(): Promise<string> {
    const resolved = await this._whichCodex()
    if (!resolved) {
      throw new Error(
        localize(
          'codexBinary.error.noSystemBinary',
          'No system `codex` executable found on PATH. Install it or switch ' +
            '`acp.codex.source` to "download".',
        ),
      )
    }
    await this._assertBinaryNotOlder(resolved, (found, required) => {
      return new Error(
        localize(
          'codexBinary.error.systemBinaryTooOld',
          'The system `codex` is version {found}, older than the {required} this build requires. ' +
            'Upgrade the system install, switch `acp.codex.source` to "download", or point ' +
            '`acp.codex.executablePath` at a newer binary.',
          { found, required },
        ),
      )
    })
    this._logger.info(`using system codex at ${resolved}`)
    return resolved
  }

  async getVersionInfo(
    policy: AgentBinaryVersionPolicy,
    authority?: string,
  ): Promise<ICodexBinaryVersionInfo> {
    if (authority !== undefined) {
      return this._remoteService(authority).getVersionInfo('codex', policy)
    }
    return this._binaryStore.getVersionInfo(policy)
  }

  async prefetch(policy: AgentBinaryVersionPolicy, authority?: string): Promise<void> {
    if (authority !== undefined) {
      await this._remoteService(authority).prefetch('codex', policy)
      return
    }
    await this._binaryStore.prefetch(policy)
  }

  async forceDownload(version: string, authority?: string): Promise<ICodexBinaryResult> {
    if (authority !== undefined) {
      const { path } = await this._remoteService(authority).forceDownload('codex', version)
      return { path }
    }
    return { path: await this._binaryStore.forceDownload(version) }
  }

  async cleanupStaleVersions(authority?: string): Promise<void> {
    if (authority !== undefined) {
      await this._remoteService(authority).cleanupStaleVersions('codex')
      return
    }
    await this._binaryStore.cleanupStaleVersions()
  }

  async syncBundled(authority?: string): Promise<string | null> {
    if (authority !== undefined) {
      const { version } = await this._remoteService(authority).syncBundled('codex')
      return version
    }
    return await this._binaryStore.syncBundled()
  }

  /**
   * Drops the cached resolve results for download mode. `_inflight` otherwise caches
   * a resolved path for the rest of the session, and a moved `.active` — every write
   * of it is announced, pointer reconciles included — makes such a path stale: the
   * next resolve() would keep handing out the previous version's binary.
   */
  private _evictResolveCache(): void {
    for (const policy of ['pinned', 'manual'] as const) {
      this._inflight.delete(downloadResolveKey(policy, true))
      this._inflight.delete(downloadResolveKey(policy, false))
    }
  }

  /**
   * Refuses a binary older than the one this build was validated against — the
   * runtime floor for the two sources the store never sees. Everything uncertain
   * fails *open*: an unrecorded/unreadable floor or a probe that cannot read a
   * version leaves a working setup alone (a failed probe must never brick a
   * session), while a cleanly read older version is fatal and names the fixes.
   */
  private async _assertBinaryNotOlder(
    binaryPath: string,
    makeError: (found: string, required: string) => Error,
  ): Promise<void> {
    let required: string | null
    try {
      required = await this._flavor.minimumBinaryVersion()
    } catch (err) {
      this._logger.warn(`codex binary: required version unavailable: ${String(err)}`)
      return
    }
    if (required === null) {
      this._logger.warn(
        `codex binary: no minimum version is known, skipping the version check for ${binaryPath}`,
      )
      return
    }
    const found = await probeBinaryVersion(binaryPath, 'codex')
    if (found === null) {
      this._logger.warn(
        `codex binary: could not read the version of ${binaryPath}, skipping the version check`,
      )
      return
    }
    const requiredVersion = parseBinaryVersion(required)
    const foundVersion = parseBinaryVersion(found)
    if (requiredVersion === null || foundVersion === null) {
      this._logger.warn(
        `codex binary: cannot compare "${found}" against "${required}", skipping the version check`,
      )
      return
    }
    if (compareBinaryVersions(foundVersion, requiredVersion) < 0) {
      throw makeError(found, required)
    }
  }

  private _whichCodex(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const tool = process.platform === 'win32' ? 'where' : 'which'
      const proc = spawn(tool, ['codex'], { windowsHide: true })
      let out = ''
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      proc.once('error', () => resolve(null))
      proc.once('exit', (code) => {
        if (code !== 0) return resolve(null)
        const first = out.split(/\r?\n/).find((l) => l.trim().length > 0)
        resolve(first ? first.trim() : null)
      })
    })
  }
}
