/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves the native Claude binary the bundled ACP agent spawns. The binary is
 *  the platform-specific optional dependency of @anthropic-ai/claude-agent-sdk
 *  (~226MB) and is deliberately NOT shipped in `resources/`. Instead it is:
 *    - downloaded on demand from the npm registry into userData (default), or
 *    - reused from a system `claude` install, or
 *    - taken from a user-provided custom path.
 *  In the dev tree a `download` request transparently reuses the binary already
 *  present in the fork's node_modules so contributors don't pay a ~100MB fetch.
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
  IClaudeBinaryProgress,
  IClaudeBinaryResolveOptions,
  IClaudeBinaryResult,
  IClaudeBinaryService,
  IClaudeBinaryVersionInfo,
} from '../../../shared/ipc/claudeBinaryService.js'

const REGISTRY = 'https://registry.npmjs.org'

interface PlatformBinary {
  /** Package suffix, e.g. `win32-x64`, `darwin-arm64`, `linux-x64-musl`. */
  readonly suffix: string
  /** File name inside the package and on disk. */
  readonly binName: string
}

function detectPlatformBinary(): PlatformBinary {
  const arch = process.arch
  if (process.platform === 'win32') return { suffix: `win32-${arch}`, binName: 'claude.exe' }
  if (process.platform === 'darwin') return { suffix: `darwin-${arch}`, binName: 'claude' }
  if (process.platform === 'linux') {
    return { suffix: `linux-${arch}${isMuslLibc() ? '-musl' : ''}`, binName: 'claude' }
  }
  throw new Error(`Unsupported platform for Claude binary: ${process.platform}-${arch}`)
}

function isMuslLibc(): boolean {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined
  return !report?.header?.glibcVersionRuntime
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

interface RegistryDist {
  readonly tarball: string
  readonly integrity?: string
  readonly shasum?: string
}

export class ClaudeBinaryMainService extends Disposable implements IClaudeBinaryService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeProgress = this._register(new Emitter<IClaudeBinaryProgress>())
  readonly onDidChangeProgress = this._onDidChangeProgress.event

  /** De-dupes concurrent resolves and caches the resolved path per options. */
  private readonly _inflight = new Map<string, Promise<IClaudeBinaryResult>>()

  private readonly _logger: ILogger

  constructor(@ILoggerService loggerService?: ILoggerService) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'claudeBinary', name: 'Claude Binary' })
  }

  resolve(opts: IClaudeBinaryResolveOptions): Promise<IClaudeBinaryResult> {
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

  private async _resolve(opts: IClaudeBinaryResolveOptions): Promise<IClaudeBinaryResult> {
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

  private async _resolveCustom(customPath: string | undefined): Promise<IClaudeBinaryResult> {
    if (!customPath) {
      throw new Error('Claude binary: custom source selected but no path is configured.')
    }
    if (!(await pathExists(customPath))) {
      throw new Error(`Claude binary not found at configured path: ${customPath}`)
    }
    const selected = await selectClaudeExecutable([customPath])
    if (!selected) {
      throw new Error(
        `Claude binary path is not a native Windows executable: ${customPath}. ` +
          'Point `acp.claude.executablePath` at the package bin claude.exe instead.',
      )
    }
    return { path: selected }
  }

  private async _resolveSystem(): Promise<string> {
    const resolved = await this._whichClaude()
    if (!resolved) {
      throw new Error(
        'No system `claude` executable found on PATH. Install Claude Code or switch ' +
          '`acp.claude.source` to "download".',
      )
    }
    this._logger.info(`using system claude at ${resolved}`)
    return resolved
  }

  /** Root dir holding every downloaded claude version plus the `.active` pointer. */
  private _baseDir(): string {
    return path.join(app.getPath('userData'), 'claude-bin')
  }

  /** Per-version install dir; the dir name is the version. */
  private _versionDir(version: string): string {
    return path.join(this._baseDir(), version)
  }

  /** Pointer file naming the version `resolve()` should spawn. */
  private _activeFile(): string {
    return path.join(this._baseDir(), '.active')
  }

  private async _readActiveVersion(): Promise<string | null> {
    try {
      const v = (await readFile(this._activeFile(), 'utf8')).trim()
      return v || null
    } catch {
      return null
    }
  }

  private async _setActiveVersion(version: string): Promise<void> {
    await mkdir(this._baseDir(), { recursive: true })
    await writeFile(this._activeFile(), version, 'utf8')
  }

  /**
   * Best-effort removal of every version dir except `keep`. A dir whose binary is
   * still running stays locked on Windows; `_rmQuiet` swallows the failure and the
   * next run retries it. Skips dotfiles (`.active`, `.prefetch`) and in-flight
   * `*.extract.*` temp dirs so a concurrent download is never clobbered.
   */
  private async _cleanupStaleVersions(keep: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this._baseDir())
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === keep || entry.startsWith('.') || entry.includes('.extract.')) continue
      await this._rmQuiet(path.join(this._baseDir(), entry))
    }
  }

  /**
   * Removes stale (non-active) version dirs. Call only at startup/idle: a just-
   * upgraded version's predecessor is still locked by the running agent, so
   * deleting it mid-session both fails (EPERM) and risks corrupting the live
   * process — by next launch its lock is gone and removal succeeds cleanly.
   */
  async cleanupStaleVersions(): Promise<void> {
    const active = (await this._readActiveVersion()) ?? (await this._readSdkVersion())
    await this._cleanupStaleVersions(active)
  }

  private async _resolveDownload(): Promise<string> {
    const version = await this._readSdkVersion()
    const { suffix, binName } = detectPlatformBinary()
    const active = (await this._readActiveVersion()) ?? version
    const cached = path.join(this._versionDir(active), binName)
    if (await pathExists(cached)) {
      this._logger.info(`claude binary cache hit ${cached}`)
      return cached
    }

    // Dev convenience: reuse the binary npm already installed in the fork so
    // contributors don't download ~100MB on first run.
    if (!app.isPackaged) {
      const vendor = path.resolve(
        app.getAppPath(),
        '../../vendor/claude-agent-acp/node_modules/@anthropic-ai',
        `claude-agent-sdk-${suffix}`,
        binName,
      )
      if (await pathExists(vendor)) {
        this._logger.info(`dev reuse of vendored claude binary ${vendor}`)
        return vendor
      }
    }

    const binaryPath = await this._download(
      version,
      suffix,
      binName,
      path.join(this._versionDir(version), binName),
    )
    await this._setActiveVersion(version)
    return binaryPath
  }

  private async _download(
    version: string,
    suffix: string,
    binName: string,
    cached: string,
    silent = false,
  ): Promise<string> {
    const pkg = `@anthropic-ai/claude-agent-sdk-${suffix}`
    this._logger.info(`downloading claude binary ${pkg}@${version}${silent ? ' (background)' : ''}`)

    const dist = await this._fetchDist(pkg, version)
    const cacheDir = path.dirname(cached)
    await mkdir(cacheDir, { recursive: true })

    // Stream the tarball straight through gunzip+untar into a temp dir — the
    // ~80MB archive never lands on disk. Writing it out first tripped Windows
    // Defender, which locked the freshly-written `.tgz` (its payload is a large
    // executable) and made the cleanup `lstat` fail with EPERM. Extract to a
    // temp dir, verify, then atomically rename so a crash never leaves a
    // half-written binary that looks cached.
    const tmpDir = path.join(cacheDir, `.extract.${process.pid}`)
    await this._rmQuiet(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    try {
      this._logger.info(`start downloading claude binary from ${dist.tarball}...`)
      await this._streamExtract(dist, tmpDir, binName, silent)
      const extracted = path.join(tmpDir, binName)
      this._logger.info(`downloading claude binary complete, extracted to ${extracted}`)
      if (!(await pathExists(extracted))) {
        throw new Error(`Tarball ${pkg}@${version} did not contain ${binName}`)
      }
      if (process.platform !== 'win32') await chmod(extracted, 0o755)
      await this._rmQuiet(cached)
      await this._renameWithRetry(extracted, cached)
      this._logger.info(`claude binary ready at ${cached}`)
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
    // through exactly once into the tar extractor. A manual `source.on('data')`
    // listener would switch the stream to flowing mode and race the pipe,
    // dropping mid-stream bytes and corrupting the gzip ("invalid block type").
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        received += chunk.length
        hash.update(chunk)
        if (!silent) this._onDidChangeProgress.fire({ received, total })
        cb(null, chunk)
      },
    })
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(
      source,
      meter,
      tarExtract({ cwd: tmpDir, strip: 1, filter: (p) => p === `package/${binName}` }),
    )

    this._verifyIntegrity(hash, dist, dist.tarball)
  }

  /** Best-effort recursive remove that survives transient Windows file locks. */
  private async _rmQuiet(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (err) {
      this._logger.warn(`claude binary cleanup failed for ${target}: ${String(err)}`)
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

  private async _readSdkVersion(): Promise<string> {
    const metaPath = app.isPackaged
      ? path.join(process.resourcesPath, 'claude-agent-acp/dist/claude-binary.json')
      : path.resolve(app.getAppPath(), '../../vendor/claude-agent-acp/dist/claude-binary.json')
    const raw = await readFile(metaPath, 'utf8')
    const meta = JSON.parse(raw) as { sdkVersion?: string }
    if (!meta.sdkVersion) {
      throw new Error(`claude-binary.json at ${metaPath} is missing sdkVersion`)
    }
    return meta.sdkVersion
  }

  async getVersionInfo(): Promise<IClaudeBinaryVersionInfo> {
    const bundledVersion = await this._readSdkVersion()
    const { binName } = detectPlatformBinary()

    // The active version's dir name *is* its version; verify the binary still
    // exists before reporting it. Fall back to the bundled-version dir for trees
    // written before the `.active` pointer scheme.
    let installedVersion: string | null = null
    const active = await this._readActiveVersion()
    if (active && (await pathExists(path.join(this._versionDir(active), binName)))) {
      installedVersion = active
    } else if (await pathExists(path.join(this._versionDir(bundledVersion), binName))) {
      installedVersion = bundledVersion
    }

    let latestVersion: string | null = null
    try {
      const res = await fetch(`${REGISTRY}/@anthropic-ai/claude-agent-sdk/latest`)
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
    return path.join(this._baseDir(), '.prefetch', version)
  }

  /** Returns the version staged in the prefetch area, or null when none is ready. */
  private async _findPrefetched(binName: string): Promise<string | null> {
    const root = path.join(this._baseDir(), '.prefetch')
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
    const bundledVersion = await this._readSdkVersion()
    const { suffix, binName } = detectPlatformBinary()

    // Prefer the latest release; fall back to the bundled SDK version when the
    // registry is unreachable.
    let target = bundledVersion
    try {
      const res = await fetch(`${REGISTRY}/@anthropic-ai/claude-agent-sdk/latest`)
      if (res.ok) {
        const body = (await res.json()) as { version?: string }
        if (body.version) target = body.version
      }
    } catch {
      // network error — fall back to bundled
    }

    // Already the active version? Nothing worth prefetching.
    const active = (await this._readActiveVersion()) ?? bundledVersion
    if (active === target && (await pathExists(path.join(this._versionDir(active), binName)))) {
      return
    }

    // Already staged for this exact version? Done.
    const staged = this._prefetchDir(target)
    if (await pathExists(path.join(staged, binName))) {
      this._logger.info(`claude binary already prefetched ${target}`)
      return
    }

    // Dev convenience: the vendored binary already covers download mode for the
    // bundled version, so prefetching it is pointless. But when the target is a
    // newer `latest`, vendor (= bundled) can't help — fall through and fetch it.
    if (!app.isPackaged && target === bundledVersion) {
      const vendor = path.resolve(
        app.getAppPath(),
        '../../vendor/claude-agent-acp/node_modules/@anthropic-ai',
        `claude-agent-sdk-${suffix}`,
        binName,
      )
      if (await pathExists(vendor)) return
    }

    // Clear any stale staging dirs (other versions) before fetching the target.
    await this._rmQuiet(path.join(this._baseDir(), '.prefetch'))
    this._logger.info(`prefetching claude binary ${target} in background`)
    await this._download(target, suffix, binName, path.join(staged, binName), true)
    this._logger.info(`claude binary prefetch ready ${target}`)
  }

  async forceDownload(version: string): Promise<IClaudeBinaryResult> {
    const { suffix, binName } = detectPlatformBinary()
    const versionDir = this._versionDir(version)
    const cached = path.join(versionDir, binName)

    // Clear inflight cache so the next resolve() call doesn't return the stale result.
    this._inflight.delete('download:')

    // Already the active, on-disk version — nothing to do. Re-downloading it would
    // target its own (possibly running, hence locked) dir.
    const active = await this._readActiveVersion()
    if (active === version && (await pathExists(cached))) {
      this._logger.info(`claude binary ${version} already active`)
      return { path: cached }
    }

    // Each version lives in its own dir, so the activation target never overlaps the
    // running binary's dir — no need to delete a locked, in-use exe (the EPERM trap).
    // The previously active dir is left in place; cleanup removes whatever isn't locked.
    const staged = path.join(this._prefetchDir(version), binName)
    if (await pathExists(staged)) {
      this._logger.info(`activating prefetched claude binary ${version}`)
      await this._rmQuiet(versionDir)
      await mkdir(this._baseDir(), { recursive: true })
      await this._renameWithRetry(path.dirname(staged), versionDir)
    } else {
      await this._rmQuiet(versionDir)
      await this._download(version, suffix, binName, cached)
    }

    await this._setActiveVersion(version)
    // Don't clean up the previous version's dir here — it's still locked by the
    // running agent and removal would block the upgrade UI for seconds and risk a
    // partial delete. Stale dirs are swept at next startup via cleanupStaleVersions().
    return { path: cached }
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
