/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves the native codex-acp adapter binary the built-in Codex agent spawns.
 *  The binary is a self-contained Rust executable shipped as the platform-specific
 *  optional dependency of `@zed-industries/codex-acp` (e.g.
 *  `@zed-industries/codex-acp-win32-x64`), and is deliberately NOT packaged.
 *  Instead it is:
 *    - downloaded on demand from the npm registry into userData (default), or
 *    - reused from a system `codex-acp` install, or
 *    - taken from a user-provided custom path.
 *  Mirrors ClaudeBinaryMainService; the only structural differences are the
 *  package naming, the pinned version (no vendor metadata to read), and the
 *  tarball entry layout (`package/bin/<binName>`, strip 2).
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import * as path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import { extract as tarExtract } from 'tar'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import type {
  ICodexBinaryProgress,
  ICodexBinaryResolveOptions,
  ICodexBinaryResult,
  ICodexBinaryService,
  ICodexBinaryVersionInfo,
} from '../../../shared/ipc/codexBinaryService.js'

const REGISTRY = 'https://registry.npmjs.org'

/**
 * Pinned codex-acp version to download. There is no vendor submodule to derive
 * this from (unlike Claude), so it is bumped by hand when following upstream.
 */
const CODEX_ACP_VERSION = '0.16.0'

interface PlatformBinary {
  /** Optional-dependency suffix, e.g. `win32-x64`, `darwin-arm64`, `linux-x64`. */
  readonly suffix: string
  /** File name inside the package and on disk. */
  readonly binName: string
}

function detectPlatformBinary(): PlatformBinary {
  const arch = process.arch
  if (process.platform === 'win32') return { suffix: `win32-${arch}`, binName: 'codex-acp.exe' }
  if (process.platform === 'darwin') return { suffix: `darwin-${arch}`, binName: 'codex-acp' }
  if (process.platform === 'linux') return { suffix: `linux-${arch}`, binName: 'codex-acp' }
  throw new Error(`Unsupported platform for codex-acp binary: ${process.platform}-${arch}`)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

interface RegistryDist {
  readonly tarball: string
  readonly integrity?: string
  readonly shasum?: string
}

export class CodexBinaryMainService extends Disposable implements ICodexBinaryService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeProgress = this._register(new Emitter<ICodexBinaryProgress>())
  readonly onDidChangeProgress = this._onDidChangeProgress.event

  /** De-dupes concurrent resolves and caches the resolved path per options. */
  private readonly _inflight = new Map<string, Promise<ICodexBinaryResult>>()

  private readonly _logger: ILogger

  constructor(@ILoggerService loggerService?: ILoggerService) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'codexBinary', name: 'Codex Binary' })
  }

  resolve(opts: ICodexBinaryResolveOptions): Promise<ICodexBinaryResult> {
    const key = `${opts.source}:${opts.customPath ?? ''}`
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
        return { path: await this._resolveDownload() }
    }
  }

  private async _resolveCustom(customPath: string | undefined): Promise<ICodexBinaryResult> {
    if (!customPath) {
      throw new Error('codex-acp binary: custom source selected but no path is configured.')
    }
    if (!(await pathExists(customPath))) {
      throw new Error(`codex-acp binary not found at configured path: ${customPath}`)
    }
    return { path: customPath }
  }

  private async _resolveSystem(): Promise<string> {
    const resolved = await this._whichCodexAcp()
    if (!resolved) {
      throw new Error(
        'No system `codex-acp` executable found on PATH. Install it or switch ' +
          '`acp.codex.source` to "download".',
      )
    }
    this._logger.info(`using system codex-acp at ${resolved}`)
    return resolved
  }

  private async _resolveDownload(): Promise<string> {
    const { suffix, binName } = detectPlatformBinary()
    const cached = path.join(app.getPath('userData'), 'codex-acp-bin', CODEX_ACP_VERSION, binName)
    if (await pathExists(cached)) {
      this._logger.info(`codex-acp binary cache hit ${cached}`)
      return cached
    }
    return this._download(CODEX_ACP_VERSION, suffix, binName, cached)
  }

  async getVersionInfo(): Promise<ICodexBinaryVersionInfo> {
    const bundledVersion = CODEX_ACP_VERSION
    const { binName } = detectPlatformBinary()
    const cacheDir = path.join(app.getPath('userData'), 'codex-acp-bin', bundledVersion)
    const cached = path.join(cacheDir, binName)

    let installedVersion: string | null = null
    if (await pathExists(cached)) {
      try {
        const ver = (await readFile(path.join(cacheDir, '.version'), 'utf8')).trim()
        installedVersion = ver || bundledVersion
      } catch {
        // .version sidecar absent — this is a pre-upgrade binary, treat as bundled version
        installedVersion = bundledVersion
      }
    }

    let latestVersion: string | null = null
    try {
      const res = await fetch(`${REGISTRY}/@zed-industries/codex-acp/latest`)
      if (res.ok) {
        const body = (await res.json()) as { version?: string }
        latestVersion = body.version ?? null
      }
    } catch {
      // network error — leave latestVersion null
    }

    const prefetchedVersion = await this._findPrefetched(binName)

    return { bundledVersion, installedVersion, latestVersion, prefetchedVersion }
  }

  /** Path of the background prefetch staging area for a specific version. */
  private _prefetchDir(version: string): string {
    return path.join(app.getPath('userData'), 'codex-acp-bin', '.prefetch', version)
  }

  /** Returns the version staged in the prefetch area, or null when none is ready. */
  private async _findPrefetched(binName: string): Promise<string | null> {
    const root = path.join(app.getPath('userData'), 'codex-acp-bin', '.prefetch')
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return null
    }
    for (const version of entries) {
      if (await pathExists(path.join(root, version, binName))) return version
    }
    return null
  }

  async prefetch(): Promise<void> {
    const bundledVersion = CODEX_ACP_VERSION
    const { suffix, binName } = detectPlatformBinary()

    // Prefer the latest release; fall back to the pinned version when the
    // registry is unreachable.
    let target = bundledVersion
    try {
      const res = await fetch(`${REGISTRY}/@zed-industries/codex-acp/latest`)
      if (res.ok) {
        const body = (await res.json()) as { version?: string }
        if (body.version) target = body.version
      }
    } catch {
      // network error — fall back to pinned
    }

    // Already the active version? Nothing worth prefetching.
    const cacheDir = path.join(app.getPath('userData'), 'codex-acp-bin', bundledVersion)
    if (await pathExists(path.join(cacheDir, binName))) {
      try {
        const installed = (await readFile(path.join(cacheDir, '.version'), 'utf8')).trim()
        if ((installed || bundledVersion) === target) return
      } catch {
        if (bundledVersion === target) return
      }
    }

    // Already staged for this exact version? Done.
    const staged = this._prefetchDir(target)
    if (await pathExists(path.join(staged, binName))) {
      this._logger.info(`codex-acp binary already prefetched ${target}`)
      return
    }

    // Clear any stale staging dirs (other versions) before fetching the target.
    await this._rmQuiet(path.join(app.getPath('userData'), 'codex-acp-bin', '.prefetch'))
    this._logger.info(`prefetching codex-acp binary ${target} in background`)
    await this._download(target, suffix, binName, path.join(staged, binName), true)
    await writeFile(path.join(staged, '.version'), target, 'utf8')
    this._logger.info(`codex-acp binary prefetch ready ${target}`)
  }

  async forceDownload(version: string): Promise<ICodexBinaryResult> {
    const { suffix, binName } = detectPlatformBinary()
    const cacheDir = path.join(app.getPath('userData'), 'codex-acp-bin', CODEX_ACP_VERSION)
    const cached = path.join(cacheDir, binName)

    // Clear inflight cache so the next resolve() call doesn't return the stale result.
    this._inflight.delete('download:')

    // Fast path: the requested version is already staged by a background prefetch.
    // Move it into the active path instead of re-downloading.
    const staged = path.join(this._prefetchDir(version), binName)
    if (await pathExists(staged)) {
      this._logger.info(`activating prefetched codex-acp binary ${version}`)
      await mkdir(cacheDir, { recursive: true })
      await this._rmQuiet(cached)
      await this._renameWithRetry(staged, cached)
      await this._rmQuiet(this._prefetchDir(version))
      await writeFile(path.join(cacheDir, '.version'), version, 'utf8')
      return { path: cached }
    }

    await this._rmQuiet(cached)
    const binaryPath = await this._download(version, suffix, binName, cached)
    await writeFile(path.join(cacheDir, '.version'), version, 'utf8')
    return { path: binaryPath }
  }

  private async _download(
    version: string,
    suffix: string,
    binName: string,
    cached: string,
    silent = false,
  ): Promise<string> {
    const pkg = `@zed-industries/codex-acp-${suffix}`
    this._logger.info(
      `downloading codex-acp binary ${pkg}@${version}${silent ? ' (background)' : ''}`,
    )

    const dist = await this._fetchDist(pkg, version)
    const cacheDir = path.dirname(cached)
    await mkdir(cacheDir, { recursive: true })

    // Stream the tarball straight through gunzip+untar into a temp dir — the
    // archive never lands on disk (see ClaudeBinaryMainService for the Windows
    // Defender rationale). Extract to a temp dir, verify, then atomically rename
    // so a crash never leaves a half-written binary that looks cached.
    const tmpDir = path.join(cacheDir, `.extract.${process.pid}`)
    await this._rmQuiet(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    try {
      this._logger.info(`start downloading codex-acp binary from ${dist.tarball}...`)
      await this._streamExtract(dist, tmpDir, binName, silent)
      const extracted = path.join(tmpDir, binName)
      this._logger.info(`downloading codex-acp binary complete, extracted to ${extracted}`)
      if (!(await pathExists(extracted))) {
        throw new Error(`Tarball ${pkg}@${version} did not contain bin/${binName}`)
      }
      if (process.platform !== 'win32') await chmod(extracted, 0o755)
      await this._rmQuiet(cached)
      await this._renameWithRetry(extracted, cached)
      this._logger.info(`codex-acp binary ready at ${cached}`)
      return cached
    } finally {
      await this._rmQuiet(tmpDir)
    }
  }

  private async _fetchDist(pkg: string, version: string): Promise<RegistryDist> {
    const url = `${REGISTRY}/${pkg}/${version}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to fetch ${pkg}@${version} metadata: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { dist?: RegistryDist }
    if (!body.dist?.tarball) {
      throw new Error(`Registry metadata for ${pkg}@${version} has no tarball URL`)
    }
    return body.dist
  }

  private async _streamExtract(
    dist: RegistryDist,
    tmpDir: string,
    binName: string,
    silent = false,
  ): Promise<void> {
    const res = await fetch(dist.tarball)
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download ${dist.tarball}: HTTP ${res.status}`)
    }
    const total = Number(res.headers.get('content-length') ?? 0)
    let received = 0
    const hash = createHash(dist.integrity ? 'sha512' : 'sha1')

    // Compute hash + progress in-band via a Transform so every byte flows
    // through exactly once into the tar extractor (a manual `data` listener would
    // switch the stream to flowing mode and race the pipe, corrupting the gzip).
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        received += chunk.length
        hash.update(chunk)
        if (!silent) this._onDidChangeProgress.fire({ received, total })
        cb(null, chunk)
      },
    })
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    // The native binary lives at `package/bin/<binName>` (npm prefixes every
    // entry with `package/`; the platform package nests it under `bin/`). Strip
    // both segments so it lands directly in tmpDir.
    await pipeline(
      source,
      meter,
      tarExtract({ cwd: tmpDir, strip: 2, filter: (p) => p === `package/bin/${binName}` }),
    )

    this._verifyIntegrity(hash, dist, dist.tarball)
  }

  /** Best-effort recursive remove that survives transient Windows file locks. */
  private async _rmQuiet(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (err) {
      this._logger.warn(`codex-acp binary cleanup failed for ${target}: ${String(err)}`)
    }
  }

  /** `fs.rename` has no built-in retry; antivirus can briefly hold the source. */
  private async _renameWithRetry(from: string, to: string): Promise<void> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rename(from, to)
        return
      } catch (err) {
        lastErr = err
        await delay(100 * (attempt + 1))
      }
    }
    throw lastErr
  }

  private _verifyIntegrity(hash: ReturnType<typeof createHash>, dist: RegistryDist, url: string) {
    if (dist.integrity) {
      const expected = dist.integrity.replace(/^sha512-/, '')
      const actual = hash.digest('base64')
      if (actual !== expected) {
        throw new Error(`Integrity check failed for ${url} (sha512 mismatch)`)
      }
      return
    }
    if (dist.shasum) {
      const actual = hash.digest('hex')
      if (actual !== dist.shasum) {
        throw new Error(`Integrity check failed for ${url} (sha1 mismatch)`)
      }
    }
  }

  private _whichCodexAcp(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const tool = process.platform === 'win32' ? 'where' : 'which'
      const proc = spawn(tool, ['codex-acp'], { windowsHide: true })
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
