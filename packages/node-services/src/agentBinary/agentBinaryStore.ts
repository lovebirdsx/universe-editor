/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Electron-free core that downloads a native agent binary (Claude / Codex)
 *  from the npm registry into a per-version directory tree under `baseDir`,
 *  with a `.active` pointer and a `.prefetch` staging area. Shared verbatim by
 *  the local main process and the remote server so both download to their own
 *  host. Only the *download* semantics live here — system/custom resolution and
 *  the wire contract are the caller's concern.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import * as path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extract as tarExtract } from 'tar'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import type { AgentBinaryFlavor, AgentBinaryPlatform } from './flavors.js'

const REGISTRY = 'https://registry.npmjs.org'

/**
 * Bounds "can we even reach the registry" for the metadata/connect phase of a
 * download. A DNS/TCP failure otherwise hangs on the OS-level connect timeout
 * (20s+ on Windows) with no upper bound of its own — fatal for a background
 * hydrate probe that must fail fast. Once the tarball response headers arrive,
 * streaming the body itself is intentionally left unbounded (a real multi-
 * hundred-MB download on a slow connection can legitimately take minutes).
 */
const NETWORK_TIMEOUT_MS = 10_000

export interface AgentBinaryProgressEvent {
  /** Bytes downloaded so far. */
  readonly received: number
  /** Total bytes per Content-Length, or 0 when the server didn't report it. */
  readonly total: number
}

export interface AgentBinaryVersionInfo {
  /** Version the binary was bundled/pinned at. */
  readonly bundledVersion: string
  /** Version named by the `.active` pointer (and verified present on disk), or null. */
  readonly installedVersion: string | null
  /** Latest version on the registry, or null when the query failed. */
  readonly latestVersion: string | null
  /** Version staged in the prefetch area, or null when none is ready. */
  readonly prefetchedVersion: string | null
}

export interface AgentBinaryStoreOptions {
  /** Root dir holding every downloaded version plus the `.active` pointer. */
  readonly baseDir: string
  readonly flavor: AgentBinaryFlavor
  readonly logger?: ILoggerService
  /**
   * Dev convenience: reuse the binary npm already installed in the vendor fork
   * so contributors don't pay a ~100MB fetch. Only injected in the local dev
   * tree (never remote). Returns null when unavailable.
   */
  readonly devBinaryFallback?: () => Promise<string | null>
}

interface RegistryDist {
  readonly tarball: string
  readonly integrity?: string
  readonly shasum?: string
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export class AgentBinaryStore extends Disposable {
  private readonly _onDidChangeProgress = this._register(new Emitter<AgentBinaryProgressEvent>())
  readonly onDidChangeProgress = this._onDidChangeProgress.event

  private readonly _logger: ILogger
  private readonly _flavor: AgentBinaryFlavor
  private readonly _baseDir: string
  private readonly _devBinaryFallback: (() => Promise<string | null>) | undefined
  private readonly _inflightResolves = new Map<string, Promise<string>>()

  constructor(options: AgentBinaryStoreOptions) {
    super()
    this._flavor = options.flavor
    this._baseDir = options.baseDir
    this._devBinaryFallback = options.devBinaryFallback
    this._logger = createNamedLogger(options.logger, { id: 'agentBinary', name: 'Agent Binary' })
  }

  private _displayName(): string {
    return this._flavor.id === 'claude' ? 'Claude' : 'Codex'
  }

  private _versionDir(version: string): string {
    return path.join(this._baseDir, version)
  }

  private _activeFile(): string {
    return path.join(this._baseDir, '.active')
  }

  private _prefetchDir(version: string): string {
    return path.join(this._baseDir, '.prefetch', version)
  }

  private _binaryIn(dir: string, platform: AgentBinaryPlatform): string {
    return this._flavor.binaryIn(dir, platform)
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
    await mkdir(this._baseDir, { recursive: true })
    await writeFile(this._activeFile(), version, 'utf8')
  }

  /**
   * De-dupes concurrent callers only while a resolve is in flight: on the remote
   * server two sessions racing the first download would otherwise extract into
   * the same `.extract.<pid>` temp dir (same process) and corrupt each other.
   * Settled promises are dropped — the disk cache-hit path is cheap and a
   * `forceDownload` version flip must be observed by the next call. The
   * `allowDownload:false` fast-fail gets its own key so it never hands its
   * rejection to a concurrent caller that actually wants to download.
   */
  resolveDownload(allowDownload: boolean): Promise<string> {
    const key = allowDownload ? 'download' : 'noDownload'
    let pending = this._inflightResolves.get(key)
    if (!pending) {
      pending = this._resolveDownload(allowDownload).finally(() => {
        this._inflightResolves.delete(key)
      })
      this._inflightResolves.set(key, pending)
    }
    return pending
  }

  private async _resolveDownload(allowDownload: boolean): Promise<string> {
    const version = await this._flavor.bundledVersion()
    const platform = this._flavor.detectPlatform()
    const active = (await this._readActiveVersion()) ?? version
    const cached = this._binaryIn(this._versionDir(active), platform)
    if (await pathExists(cached)) {
      this._logger.info(`${this._flavor.id} binary cache hit ${cached}`)
      return cached
    }

    if (this._devBinaryFallback) {
      const vendor = await this._devBinaryFallback()
      if (vendor) {
        this._logger.info(`dev reuse of vendored ${this._flavor.id} binary ${vendor}`)
        return vendor
      }
    }

    if (!allowDownload) {
      throw new Error(
        `${this._displayName()} binary is not downloaded yet — background probes never trigger a download; ` +
          `start a ${this._displayName()} session or download it explicitly to fetch it.`,
      )
    }

    const binaryPath = await this._download(version, platform, this._versionDir(version))
    await this._setActiveVersion(version)
    return binaryPath
  }

  async getVersionInfo(): Promise<AgentBinaryVersionInfo> {
    const bundledVersion = await this._flavor.bundledVersion()
    const platform = this._flavor.detectPlatform()

    // The active version's dir name *is* its version; verify the binary still
    // exists before reporting it. Fall back to the bundled/pinned-version dir for
    // trees written before the `.active` pointer scheme.
    let installedVersion: string | null = null
    const active = await this._readActiveVersion()
    if (active && (await pathExists(this._binaryIn(this._versionDir(active), platform)))) {
      installedVersion = active
    } else if (await pathExists(this._binaryIn(this._versionDir(bundledVersion), platform))) {
      installedVersion = bundledVersion
    }

    let latestVersion: string | null = null
    try {
      const res = await fetch(`${REGISTRY}/${this._flavor.latestPackage}/latest`, {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      })
      if (res.ok) {
        const body = (await res.json()) as { version?: string }
        latestVersion = body.version ?? null
      }
    } catch {
      // network error — leave latestVersion null
    }

    const prefetchedVersion = await this._findPrefetched(platform)

    return { bundledVersion, installedVersion, latestVersion, prefetchedVersion }
  }

  async prefetch(): Promise<void> {
    const bundledVersion = await this._flavor.bundledVersion()
    const platform = this._flavor.detectPlatform()

    // Prefer the latest release; fall back to the bundled/pinned version when the
    // registry is unreachable.
    let target = bundledVersion
    try {
      const res = await fetch(`${REGISTRY}/${this._flavor.latestPackage}/latest`, {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      })
      if (res.ok) {
        const body = (await res.json()) as { version?: string }
        if (body.version) target = body.version
      }
    } catch {
      // network error — fall back to bundled/pinned
    }

    // Already the active version? Nothing worth prefetching.
    const active = (await this._readActiveVersion()) ?? bundledVersion
    if (
      active === target &&
      (await pathExists(this._binaryIn(this._versionDir(active), platform)))
    ) {
      return
    }

    // Already staged for this exact version? Done.
    const staged = this._prefetchDir(target)
    if (await pathExists(this._binaryIn(staged, platform))) {
      this._logger.info(`${this._flavor.id} binary already prefetched ${target}`)
      return
    }

    // Dev convenience: the vendored binary already covers download mode for the
    // bundled version, so prefetching it is pointless. But when the target is a
    // newer `latest`, vendor (= bundled) can't help — fall through and fetch it.
    if (this._devBinaryFallback && target === bundledVersion) {
      if (await this._devBinaryFallback()) return
    }

    // Clear any stale staging dirs (other versions) before fetching the target.
    await this._rmQuiet(path.join(this._baseDir, '.prefetch'))
    this._logger.info(`prefetching ${this._flavor.id} binary ${target} in background`)
    await this._download(target, platform, this._prefetchDir(target), true)
    this._logger.info(`${this._flavor.id} binary prefetch ready ${target}`)
  }

  async forceDownload(version: string): Promise<string> {
    const platform = this._flavor.detectPlatform()
    const versionDir = this._versionDir(version)
    const cached = this._binaryIn(versionDir, platform)

    // Already the active, on-disk version — nothing to do. Re-downloading it would
    // target its own (possibly running, hence locked) tree.
    const active = await this._readActiveVersion()
    if (active === version && (await pathExists(cached))) {
      this._logger.info(`${this._flavor.id} binary ${version} already active`)
      return cached
    }

    // Each version lives in its own dir, so the activation target never overlaps
    // the running binary's dir — no need to delete a locked, in-use exe (the EPERM
    // trap). The previously active dir is left in place; cleanup removes whatever
    // isn't locked.
    const staged = this._prefetchDir(version)
    if (await pathExists(this._binaryIn(staged, platform))) {
      this._logger.info(`activating prefetched ${this._flavor.id} binary ${version}`)
      await this._rmQuiet(versionDir)
      await mkdir(this._baseDir, { recursive: true })
      await this._renameWithRetry(staged, versionDir)
    } else {
      await this._rmQuiet(versionDir)
      await this._download(version, platform, versionDir)
    }

    await this._setActiveVersion(version)
    // Don't clean up the previous version's dir here — it's still locked by the
    // running agent and removal would block the upgrade UI for seconds and risk a
    // partial delete. Stale dirs are swept at next startup via cleanupStaleVersions().
    return cached
  }

  /**
   * Removes stale (non-active) version dirs. Call only at startup/idle: a just-
   * upgraded version's predecessor is still locked by the running agent, so
   * deleting it mid-session both fails (EPERM) and risks corrupting the live
   * process — by next launch its lock is gone and removal succeeds cleanly.
   */
  async cleanupStaleVersions(): Promise<void> {
    const active = (await this._readActiveVersion()) ?? (await this._flavor.bundledVersion())
    await this._cleanupStaleVersions(active)
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
      entries = await readdir(this._baseDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === keep || entry.startsWith('.') || entry.includes('.extract.')) continue
      await this._rmQuiet(path.join(this._baseDir, entry))
    }
  }

  /** Returns the version staged in the prefetch area, or null when none is ready. */
  private async _findPrefetched(platform: AgentBinaryPlatform): Promise<string | null> {
    const root = path.join(this._baseDir, '.prefetch')
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return null
    }
    for (const version of entries) {
      if (await pathExists(this._binaryIn(path.join(root, version), platform))) return version
    }
    return null
  }

  private async _download(
    version: string,
    platform: AgentBinaryPlatform,
    destDir: string,
    silent = false,
  ): Promise<string> {
    const pkg = this._flavor.platformPackage(platform)
    const registryVersion = this._flavor.platformVersion(version, platform)
    this._logger.info(
      `downloading ${this._flavor.id} binary ${pkg}@${registryVersion}${silent ? ' (background)' : ''}`,
    )

    const dist = await this._fetchDist(pkg, registryVersion)
    await mkdir(path.dirname(destDir), { recursive: true })

    // Stream the tarball straight through gunzip+untar into a temp dir — the
    // archive never lands on disk. Writing it out first tripped Windows
    // Defender, which locked the freshly-written `.tgz` (its payload is a large
    // executable) and made the cleanup `lstat` fail with EPERM. Extract to a
    // temp dir, verify, then atomically rename so a crash never leaves a
    // half-written tree that looks cached.
    const tmpDir = `${destDir}.extract.${process.pid}`
    await this._rmQuiet(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    try {
      this._logger.info(`start downloading ${this._flavor.id} binary from ${dist.tarball}...`)
      await this._streamExtract(dist, tmpDir, platform, silent)
      const extracted = this._binaryIn(tmpDir, platform)
      this._logger.info(`downloading ${this._flavor.id} binary complete, extracted to ${tmpDir}`)
      if (!(await pathExists(extracted))) {
        throw new Error(`Tarball ${pkg}@${registryVersion} did not contain ${extracted}`)
      }
      if (process.platform !== 'win32') await chmod(extracted, 0o755)
      await this._rmQuiet(destDir)
      await this._renameWithRetry(tmpDir, destDir)
      const cached = this._binaryIn(destDir, platform)
      this._logger.info(`${this._flavor.id} binary ready at ${cached}`)
      return cached
    } finally {
      await this._rmQuiet(tmpDir)
    }
  }

  private async _fetchDist(pkg: string, version: string): Promise<RegistryDist> {
    const url = `${REGISTRY}/${pkg}/${version}`
    const res = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
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
    platform: AgentBinaryPlatform,
    silent = false,
  ): Promise<void> {
    // Bound only the connect/headers phase — once the response arrives, the
    // (potentially large, potentially slow) body stream is read unbounded below.
    const controller = new AbortController()
    const connectTimer = setTimeout(
      () => controller.abort(new Error(`Timed out connecting to ${dist.tarball}`)),
      NETWORK_TIMEOUT_MS,
    )
    let res: Response
    try {
      res = await fetch(dist.tarball, { signal: controller.signal })
    } finally {
      clearTimeout(connectTimer)
    }
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
      tarExtract({ cwd: tmpDir, ...this._flavor.extractOptions(platform) }),
    )

    this._verifyIntegrity(hash, dist, dist.tarball)
  }

  /** Best-effort recursive remove that survives transient Windows file locks. */
  private async _rmQuiet(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (err) {
      this._logger.warn(`${this._flavor.id} binary cleanup failed for ${target}: ${String(err)}`)
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
}
