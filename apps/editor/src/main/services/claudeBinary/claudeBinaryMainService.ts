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
  createClaudeFlavor,
  type IRemoteAgentBinaryService,
} from '@universe-editor/node-services'
import { resolveFromRepo } from '../../repoPaths.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import type {
  IClaudeBinaryProgress,
  IClaudeBinaryResolveOptions,
  IClaudeBinaryResult,
  IClaudeBinaryService,
  IClaudeBinaryVersionInfo,
} from '../../../shared/ipc/claudeBinaryService.js'

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

  private readonly _onDidChangeProgress = this._register(new Emitter<IClaudeBinaryProgress>())
  readonly onDidChangeProgress = this._onDidChangeProgress.event

  /** De-dupes concurrent resolves and caches the resolved path per options. */
  private readonly _inflight = new Map<string, Promise<IClaudeBinaryResult>>()

  private readonly _logger: ILogger
  private readonly _flavor: ReturnType<typeof createClaudeFlavor>
  private readonly _binaryStore: AgentBinaryStore

  private readonly _remoteProgressBound = new Set<string>()

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
    this._register(this._binaryStore.onDidChangeProgress((p) => this._onDidChangeProgress.fire(p)))
  }

  resolve(opts: IClaudeBinaryResolveOptions): Promise<IClaudeBinaryResult> {
    if (opts.authority !== undefined) {
      return this._resolveRemote(opts.authority, opts.allowDownload)
    }
    // `allowDownload:false` gets its own key so a background probe that hits a
    // cache miss (fails fast, never cached — see below) can never hand its
    // fast-fail promise to a concurrent caller that actually wants to download.
    const key = `${opts.source}:${opts.customPath ?? ''}${opts.allowDownload === false ? ':noDownload' : ''}`
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
        return { path: await this._binaryStore.resolveDownload(opts.allowDownload ?? true) }
    }
  }

  private async _resolveRemote(
    authority: string,
    allowDownload: boolean | undefined,
  ): Promise<IClaudeBinaryResult> {
    const service = this._remoteService(authority)
    const { path } = await service.resolve('claude', {
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
    if (!this._remoteProgressBound.has(authority)) {
      this._remoteProgressBound.add(authority)
      this._register(
        service.onDidChangeProgress((e) => {
          if (e.agent !== 'claude') return
          this._onDidChangeProgress.fire({ received: e.received, total: e.total, authority })
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

  async getVersionInfo(authority?: string): Promise<IClaudeBinaryVersionInfo> {
    if (authority !== undefined) {
      return this._remoteService(authority).getVersionInfo('claude')
    }
    return this._binaryStore.getVersionInfo()
  }

  async prefetch(authority?: string): Promise<void> {
    if (authority !== undefined) {
      await this._remoteService(authority).prefetch('claude')
      return
    }
    await this._binaryStore.prefetch()
  }

  async forceDownload(version: string, authority?: string): Promise<IClaudeBinaryResult> {
    if (authority !== undefined) {
      const { path } = await this._remoteService(authority).forceDownload('claude', version)
      return { path }
    }
    // Clear inflight cache so the next resolve() call doesn't return the stale result.
    this._inflight.delete('download:')
    this._inflight.delete('download::noDownload')
    return { path: await this._binaryStore.forceDownload(version) }
  }

  async cleanupStaleVersions(authority?: string): Promise<void> {
    if (authority !== undefined) {
      await this._remoteService(authority).cleanupStaleVersions('claude')
      return
    }
    await this._binaryStore.cleanupStaleVersions()
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
