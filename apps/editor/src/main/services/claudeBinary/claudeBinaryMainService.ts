/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves the native Claude binary the bundled ACP agent spawns. The binary is
 *  the platform-specific optional dependency of @anthropic-ai/claude-agent-sdk
 *  (~226MB) and is deliberately NOT shipped in `resources/`. Instead it is:
 *    - downloaded on demand from the npm registry into userData (default), or
 *    - reused from a system `claude` install, or
 *    - taken from a user-provided custom path.
 *  The download itself lives in the shared AgentBinaryStore (node-services) so
 *  the remote server can reuse it verbatim; this shell only owns the system/
 *  custom resolution, the wire contract, and the local dev vendored-binary
 *  shortcut.
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
  compareBinaryVersions,
  createClaudeFlavor,
  parseBinaryVersion,
  probeBinaryVersion,
  type IRemoteAgentBinaryService,
} from '@universe-editor/node-services'
import { resolveFromRepo } from '../../repoPaths.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import type {
  IClaudeBinaryDownloadEvent,
  IClaudeBinaryResolveOptions,
  IClaudeBinaryResult,
  IClaudeBinaryService,
  IClaudeBinaryVersionInfo,
} from '../../../shared/ipc/claudeBinaryService.js'

/**
 * Cache key of a download-mode resolve. The policy is part of it: the same
 * options must not hand a caller the path resolved under the other policy after
 * the user locked or unlocked version selection mid-session.
 */
function resolveCacheKey(opts: IClaudeBinaryResolveOptions): string {
  return `${opts.policy}:${opts.source}:${opts.customPath ?? ''}${opts.allowDownload === false ? ':noDownload' : ''}`
}

/** The download-mode keys, spelled the way `resolveCacheKey` builds them. */
function downloadResolveKey(policy: AgentBinaryVersionPolicy, allowDownload: boolean): string {
  return `${policy}:download:${allowDownload ? '' : ':noDownload'}`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function resolveWindowsNpmClaudeNative(candidate: string): Promise<string | null> {
  if (path.extname(candidate).toLowerCase() === '.exe') return candidate
  const native = path.join(
    path.dirname(candidate),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  )
  return (await pathExists(native)) ? native : null
}

export async function selectClaudeExecutable(
  candidates: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const nonEmpty = candidates.map((l) => l.trim()).filter((l) => l.length > 0)
  if (platform !== 'win32') return nonEmpty[0] ?? null

  for (const candidate of nonEmpty) {
    const native = await resolveWindowsNpmClaudeNative(candidate)
    if (native) return native
  }
  return null
}

export class ClaudeBinaryMainService extends Disposable implements IClaudeBinaryService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeDownload = this._register(new Emitter<IClaudeBinaryDownloadEvent>())
  readonly onDidChangeDownload = this._onDidChangeDownload.event

  /** De-dupes concurrent resolves and caches the resolved path per options. */
  private readonly _inflight = new Map<string, Promise<IClaudeBinaryResult>>()

  private readonly _logger: ILogger
  private readonly _flavor: ReturnType<typeof createClaudeFlavor>
  private readonly _binaryStore: AgentBinaryStore

  private readonly _remoteDownloadBound = new Set<string>()

  constructor(
    @ILoggerService loggerService?: ILoggerService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'claudeBinary', name: 'Claude Binary' })
    this._flavor = createClaudeFlavor(() => this._metaPath())
    this._binaryStore = this._register(
      new AgentBinaryStore({
        baseDir: path.join(app.getPath('userData'), 'claude-bin'),
        flavor: this._flavor,
        ...(loggerService !== undefined ? { logger: loggerService } : {}),
        ...(!app.isPackaged ? { devBinaryFallback: () => this._vendoredBinary() } : {}),
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

  resolve(opts: IClaudeBinaryResolveOptions): Promise<IClaudeBinaryResult> {
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

  private async _resolve(opts: IClaudeBinaryResolveOptions): Promise<IClaudeBinaryResult> {
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
  ): Promise<IClaudeBinaryResult> {
    const service = this._remoteService(authority)
    const { path } = await service.resolve('claude', {
      policy,
      ...(allowDownload !== undefined ? { allowDownload } : {}),
    })
    return { path }
  }

  private _remoteService(authority: string): IRemoteAgentBinaryService {
    if (!this._connections) {
      throw new Error('claudeBinary: remote connection service not available')
    }
    const service = this._connections.getServiceProxy<IRemoteAgentBinaryService>(
      authority,
      RemoteChannels.AgentBinary,
    )
    if (!this._remoteDownloadBound.has(authority)) {
      this._remoteDownloadBound.add(authority)
      this._register(
        service.onDidChangeDownload((e) => {
          if (e.agent !== 'claude') return
          this._onDidChangeDownload.fire({ downloads: e.downloads, authority })
        }),
      )
    }
    return service
  }

  private async _resolveCustom(customPath: string | undefined): Promise<IClaudeBinaryResult> {
    if (!customPath) {
      throw new Error(
        localize(
          'claudeBinary.error.noCustomPath',
          'Claude binary: custom source selected but no path is configured.',
        ),
      )
    }
    if (!(await pathExists(customPath))) {
      throw new Error(
        localize(
          'claudeBinary.error.customPathNotFound',
          'Claude binary not found at configured path: {path}',
          { path: customPath },
        ),
      )
    }
    const selected = await selectClaudeExecutable([customPath])
    if (!selected) {
      throw new Error(
        localize(
          'claudeBinary.error.notNativeExecutable',
          'Claude binary path is not a native Windows executable: {path}. ' +
            'Point `acp.claude.executablePath` at the package bin claude.exe instead.',
          { path: customPath },
        ),
      )
    }
    await this._assertBinaryNotOlder(selected, (found, required) => {
      return new Error(
        localize(
          'claudeBinary.error.customBinaryTooOld',
          'The configured Claude binary is version {found}, older than the {required} this build ' +
            'requires. Point `acp.claude.executablePath` at a newer Claude Code binary, or switch ' +
            '`acp.claude.source` to "download".',
          { found, required },
        ),
      )
    })
    return { path: selected }
  }

  private async _resolveSystem(): Promise<string> {
    const resolved = await this._whichClaude()
    if (!resolved) {
      throw new Error(
        localize(
          'claudeBinary.error.noSystemBinary',
          'No system `claude` executable found on PATH. Install Claude Code or switch ' +
            '`acp.claude.source` to "download".',
        ),
      )
    }
    await this._assertBinaryNotOlder(resolved, (found, required) => {
      return new Error(
        localize(
          'claudeBinary.error.systemBinaryTooOld',
          'The system `claude` is version {found}, older than the {required} this build requires. ' +
            'Upgrade the system install, switch `acp.claude.source` to "download", or point ' +
            '`acp.claude.executablePath` at a newer binary.',
          { found, required },
        ),
      )
    })
    this._logger.info(`using system claude at ${resolved}`)
    return resolved
  }

  private _metaPath(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'claude-agent-acp/dist/claude-binary.json')
      : resolveFromRepo('vendor/claude-agent-acp/dist/claude-binary.json')
  }

  private async _vendoredBinary(): Promise<string | null> {
    const { suffix, binName } = this._flavor.detectPlatform()
    const vendor = resolveFromRepo(
      path.join(
        'vendor/claude-agent-acp/node_modules/@anthropic-ai',
        `claude-agent-sdk-${suffix}`,
        binName,
      ),
    )
    return (await pathExists(vendor)) ? vendor : null
  }

  async getVersionInfo(
    policy: AgentBinaryVersionPolicy,
    authority?: string,
  ): Promise<IClaudeBinaryVersionInfo> {
    if (authority !== undefined) {
      return this._remoteService(authority).getVersionInfo('claude', policy)
    }
    return this._binaryStore.getVersionInfo(policy)
  }

  async prefetch(policy: AgentBinaryVersionPolicy, authority?: string): Promise<void> {
    if (authority !== undefined) {
      await this._remoteService(authority).prefetch('claude', policy)
      return
    }
    await this._binaryStore.prefetch(policy)
  }

  async forceDownload(version: string, authority?: string): Promise<IClaudeBinaryResult> {
    if (authority !== undefined) {
      const { path } = await this._remoteService(authority).forceDownload('claude', version)
      return { path }
    }
    return { path: await this._binaryStore.forceDownload(version) }
  }

  async cleanupStaleVersions(authority?: string): Promise<void> {
    if (authority !== undefined) {
      await this._remoteService(authority).cleanupStaleVersions('claude')
      return
    }
    await this._binaryStore.cleanupStaleVersions()
  }

  async syncBundled(authority?: string): Promise<string | null> {
    if (authority !== undefined) {
      const { version } = await this._remoteService(authority).syncBundled('claude')
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
      this._logger.warn(`claude binary: required version unavailable: ${String(err)}`)
      return
    }
    if (required === null) {
      this._logger.warn(
        `claude binary: no CLI version was recorded at build time, skipping the version check for ${binaryPath}`,
      )
      return
    }
    const found = await probeBinaryVersion(binaryPath, 'claude')
    if (found === null) {
      this._logger.warn(
        `claude binary: could not read the version of ${binaryPath}, skipping the version check`,
      )
      return
    }
    const requiredVersion = parseBinaryVersion(required)
    const foundVersion = parseBinaryVersion(found)
    if (requiredVersion === null || foundVersion === null) {
      this._logger.warn(
        `claude binary: cannot compare "${found}" against "${required}", skipping the version check`,
      )
      return
    }
    if (compareBinaryVersions(foundVersion, requiredVersion) < 0) {
      throw makeError(found, required)
    }
  }

  private _whichClaude(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const tool = process.platform === 'win32' ? 'where' : 'which'
      const proc = spawn(tool, ['claude'], { windowsHide: true })
      let out = ''
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      proc.once('error', () => resolve(null))
      proc.once('exit', (code) => {
        if (code !== 0) return resolve(null)
        void selectClaudeExecutable(out.split(/\r?\n/)).then(resolve, () => resolve(null))
      })
    })
  }
}
