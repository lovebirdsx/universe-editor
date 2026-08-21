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
  type IRemoteAgentBinaryService,
} from '@universe-editor/node-services'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import type {
  ICodexBinaryProgress,
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

export class CodexBinaryMainService extends Disposable implements ICodexBinaryService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeProgress = this._register(new Emitter<ICodexBinaryProgress>())
  readonly onDidChangeProgress = this._onDidChangeProgress.event

  /** De-dupes concurrent resolves and caches the resolved path per options. */
  private readonly _inflight = new Map<string, Promise<ICodexBinaryResult>>()

  private readonly _logger: ILogger
  private readonly _binaryStore: AgentBinaryStore

  private readonly _remoteProgressBound = new Set<string>()

  constructor(
    @ILoggerService loggerService?: ILoggerService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'codexBinary', name: 'Codex Binary' })
    this._binaryStore = this._register(
      new AgentBinaryStore({
        baseDir: path.join(app.getPath('userData'), 'codex-bin'),
        flavor: codexFlavor,
        ...(loggerService !== undefined ? { logger: loggerService } : {}),
      }),
    )
    this._register(this._binaryStore.onDidChangeProgress((p) => this._onDidChangeProgress.fire(p)))
  }

  resolve(opts: ICodexBinaryResolveOptions): Promise<ICodexBinaryResult> {
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

  private async _resolve(opts: ICodexBinaryResolveOptions): Promise<ICodexBinaryResult> {
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
  ): Promise<ICodexBinaryResult> {
    const service = this._remoteService(authority)
    const { path } = await service.resolve('codex', {
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
    if (!this._remoteProgressBound.has(authority)) {
      this._remoteProgressBound.add(authority)
      this._register(
        service.onDidChangeProgress((e) => {
          if (e.agent !== 'codex') return
          this._onDidChangeProgress.fire({ received: e.received, total: e.total, authority })
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
    this._logger.info(`using system codex at ${resolved}`)
    return resolved
  }

  async getVersionInfo(authority?: string): Promise<ICodexBinaryVersionInfo> {
    if (authority !== undefined) {
      return this._remoteService(authority).getVersionInfo('codex')
    }
    return this._binaryStore.getVersionInfo()
  }

  async prefetch(authority?: string): Promise<void> {
    if (authority !== undefined) {
      await this._remoteService(authority).prefetch('codex')
      return
    }
    await this._binaryStore.prefetch()
  }

  async forceDownload(version: string, authority?: string): Promise<ICodexBinaryResult> {
    if (authority !== undefined) {
      const { path } = await this._remoteService(authority).forceDownload('codex', version)
      return { path }
    }
    // Clear inflight cache so the next resolve() call doesn't return the stale result.
    this._inflight.delete('download:')
    this._inflight.delete('download::noDownload')
    return { path: await this._binaryStore.forceDownload(version) }
  }

  async cleanupStaleVersions(authority?: string): Promise<void> {
    if (authority !== undefined) {
      await this._remoteService(authority).cleanupStaleVersions('codex')
      return
    }
    await this._binaryStore.cleanupStaleVersions()
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
