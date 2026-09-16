/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Electron-free core that downloads a native agent binary (Claude / Codex)
 *  from the npm registry into a per-version directory tree under `baseDir`, with
 *  a `.active` pointer naming the version in use. Shared verbatim by the local
 *  main process and the remote server so both download to their own host. Only
 *  the *download* semantics live here — system/custom resolution and the wire
 *  contract are the caller's concern.
 *
 *  Downloaded versions are kept on disk so switching between the pinned/bundled
 *  version and the latest release costs no network at all: `cleanupStaleVersions`
 *  only sweeps dirs outside {active, bundled, last-seen latest}. Downloads are
 *  de-duplicated per version, so a background prefetch and a user clicking the
 *  same version share one fetch.
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

export interface AgentBinaryDownloadState {
  /** Version being downloaded. */
  readonly version: string
  /** Bytes downloaded so far. */
  readonly received: number
  /** Total bytes per Content-Length, or 0 when the server didn't report it. */
  readonly total: number
  /**
   * True when the idle prefetch started this download rather than a user action.
   * A caller that joins an already-running background download inherits the
   * flag — never use it to tell "did I start this".
   */
  readonly background: boolean
}

export interface AgentBinaryVersionInfo {
  /** Version the binary was bundled/pinned at. */
  readonly bundledVersion: string
  /** Version named by the `.active` pointer (and verified present on disk), or null. */
  readonly installedVersion: string | null
  /** Latest version on the registry, or null when the query failed. */
  readonly latestVersion: string | null
  /** Versions whose binary is fully extracted on disk; `installedVersion` is one of them. */
  readonly downloadedVersions: readonly string[]
  /** Downloads in flight right now — empty when idle. */
  readonly downloads: readonly AgentBinaryDownloadState[]
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
  private readonly _onDidChangeDownload = this._register(
    new Emitter<readonly AgentBinaryDownloadState[]>(),
  )
  readonly onDidChangeDownload = this._onDidChangeDownload.event

  private readonly _logger: ILogger
  private readonly _flavor: AgentBinaryFlavor
  private readonly _baseDir: string
  private readonly _devBinaryFallback: (() => Promise<string | null>) | undefined
  private readonly _inflightResolves = new Map<string, Promise<string>>()
  /**
   * De-dupes downloads by target version. Background prefetch and a user click on
   * the same version therefore share a single fetch — and two concurrent callers
   * never extract into the same `.extract.<pid>` temp dir.
   */
  private readonly _inflightEnsures = new Map<string, Promise<string>>()
  /** In-flight downloads, keyed by version. Doubles as the UI's source of truth. */
  private readonly _downloads = new Map<string, AgentBinaryDownloadState>()
  /**
   * Versions a `forceDownload` is about to activate. Between the download settling
   * and `.active` being written there is a window where the version is no longer in
   * `_downloads` and not yet the active one — a cleanup sweep landing in it would
   * delete the few hundred MB it just downloaded.
   */
  private readonly _activating = new Set<string>()

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

  private _latestFile(): string {
    return path.join(this._baseDir, '.latest')
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
   * Last-seen registry `latest`, persisted so `cleanupStaleVersions` can keep that
   * version's dir without querying the network — cleanup runs on the startup path
   * where a 10s registry timeout would be the worst case.
   */
  private async _readRememberedLatest(): Promise<string | null> {
    try {
      const v = (await readFile(this._latestFile(), 'utf8')).trim()
      return v || null
    } catch {
      return null
    }
  }

  private async _rememberLatest(version: string): Promise<void> {
    try {
      if ((await this._readRememberedLatest()) === version) return
      await mkdir(this._baseDir, { recursive: true })
      await writeFile(this._latestFile(), version, 'utf8')
    } catch (err) {
      // Best-effort: this only widens what cleanup keeps, never blocks a download.
      this._logger.warn(`${this._flavor.id} binary: recording latest failed: ${String(err)}`)
    }
  }

  private async _queryLatest(): Promise<string | null> {
    try {
      const res = await fetch(`${REGISTRY}/${this._flavor.latestPackage}/latest`, {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { version?: string }
      return body.version ?? null
    } catch {
      // network error — caller falls back to the bundled version
      return null
    }
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

    const binaryPath = await this._ensureVersion(version, false)
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

    const latestVersion = await this._queryLatest()
    if (latestVersion) await this._rememberLatest(latestVersion)

    return {
      bundledVersion,
      installedVersion,
      latestVersion,
      downloadedVersions: await this._listDownloadedVersions(platform),
      downloads: [...this._downloads.values()],
    }
  }

  /**
   * Background-prefetches the most desirable version (latest when available,
   * otherwise the bundled/pinned one) into its own version dir without flipping
   * `.active`, so a later `forceDownload` activates it without a network fetch.
   * Never throws — a failed prefetch must not disrupt the caller.
   */
  async prefetch(): Promise<void> {
    try {
      await this._prefetchImpl()
    } catch (err) {
      this._logger.warn(`${this._flavor.id} binary prefetch failed: ${String(err)}`)
    }
  }

  private async _prefetchImpl(): Promise<void> {
    const bundledVersion = await this._flavor.bundledVersion()
    const platform = this._flavor.detectPlatform()

    const latest = await this._queryLatest()
    if (latest) await this._rememberLatest(latest)
    const target = latest ?? bundledVersion

    // Already the active version? Nothing worth prefetching.
    const active = (await this._readActiveVersion()) ?? bundledVersion
    if (
      active === target &&
      (await pathExists(this._binaryIn(this._versionDir(active), platform)))
    ) {
      return
    }

    // Dev convenience: the vendored binary already covers download mode for the
    // bundled version, so prefetching it is pointless. But when the target is a
    // newer `latest`, vendor (= bundled) can't help — fall through and fetch it.
    if (this._devBinaryFallback && target === bundledVersion) {
      if (await this._devBinaryFallback()) return
    }

    this._logger.info(`prefetching ${this._flavor.id} binary ${target} in background`)
    await this._ensureVersion(target, true)
    this._logger.info(`${this._flavor.id} binary prefetch ready ${target}`)
  }

  /**
   * Switches `.active` to `version`, downloading it only when it isn't on disk.
   * Each version lives in its own dir, so a switch never overwrites the running
   * binary's tree (the EPERM trap on Windows) and a previously downloaded version
   * is re-activated with zero network — what makes revert/upgrade instant.
   */
  async forceDownload(version: string): Promise<string> {
    // Held across the whole span, not just the fetch: the activation write is what
    // makes the version safe from the cleanup sweep. The previous version's dir is
    // deliberately left alone here — it's still locked by the running agent, and
    // removing it would block the upgrade UI for seconds and risk a partial delete.
    // Stale dirs are swept at next startup via cleanupStaleVersions().
    this._activating.add(version)
    try {
      const binaryPath = await this._ensureVersion(version, false)
      await this._setActiveVersion(version)
      return binaryPath
    } finally {
      this._activating.delete(version)
    }
  }

  /**
   * Removes version dirs the user can no longer switch to offline. Call only at
   * startup/idle: a just-upgraded version's predecessor is still locked by the
   * running agent, so deleting it mid-session both fails (EPERM) and risks
   * corrupting the live process — by next launch its lock is gone and removal
   * succeeds cleanly.
   */
  async cleanupStaleVersions(): Promise<void> {
    const active = await this._readActiveVersion()
    let bundledVersion: string | null = null
    try {
      bundledVersion = await this._flavor.bundledVersion()
    } catch (err) {
      // A missing/!unreadable meta file must not turn the sweep into a wipe.
      this._logger.warn(`${this._flavor.id} binary: pinned version unavailable: ${String(err)}`)
    }
    if (active === null && bundledVersion === null) {
      // Nothing to anchor the keep-set on — an empty one would delete every
      // downloaded version. Skipping is always safe; a later run retries.
      return
    }
    // Keep everything switchable without a network fetch: the active version, the
    // pinned/bundled one, and the last-seen registry latest.
    const keep = new Set<string>()
    if (active !== null) keep.add(active)
    if (bundledVersion !== null) keep.add(bundledVersion)
    const latest = await this._readRememberedLatest()
    if (latest) keep.add(latest)
    // An in-flight download has no dir yet, but keep it anyway: `.latest` is only
    // rewritten once the registry answers, so the target can briefly fall outside
    // the set above.
    for (const version of this._downloads.keys()) keep.add(version)
    // Nor has a forced download flipped `.active` yet — that happens after the
    // download settles, i.e. after it left `_downloads`.
    for (const version of this._activating) keep.add(version)
    // A version staged by the old `.prefetch` scheme is moved into its own dir here
    // — and thereby kept: cleanup runs at idle, i.e. before the user's next click,
    // so reclaiming the staging area blindly would throw away a finished download.
    for (const version of await this._adoptLegacyPrefetch()) keep.add(version)
    await this._cleanupStaleVersions(keep)
  }

  /**
   * Best-effort removal of every version dir outside `keep`. A dir whose binary is
   * still running stays locked on Windows; `_rmQuiet` swallows the failure and the
   * next run retries it. Skips dotfiles (`.active`, `.latest`) and in-flight
   * `*.extract.*` temp dirs so a concurrent download is never clobbered.
   */
  private async _cleanupStaleVersions(keep: ReadonlySet<string>): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this._baseDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (keep.has(entry) || entry.startsWith('.') || entry.includes('.extract.')) continue
      await this._rmQuiet(path.join(this._baseDir, entry))
    }
  }

  private async _listDownloadedVersions(platform: AgentBinaryPlatform): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this._baseDir)
    } catch {
      return []
    }
    const versions: string[] = []
    for (const entry of entries) {
      if (entry.startsWith('.') || entry.includes('.extract.')) continue
      if (await pathExists(this._binaryIn(this._versionDir(entry), platform))) versions.push(entry)
    }
    return versions.sort()
  }

  /**
   * The single download entry point. Callers for the same version — background
   * prefetch, an explicit download, a session hydrating — share one fetch, and an
   * on-disk version short-circuits before any network work.
   */
  private _ensureVersion(version: string, background: boolean): Promise<string> {
    const pending = this._inflightEnsures.get(version)
    if (pending) return pending
    const started = this._ensureVersionImpl(version, background).finally(() => {
      this._inflightEnsures.delete(version)
    })
    this._inflightEnsures.set(version, started)
    return started
  }

  private async _ensureVersionImpl(version: string, background: boolean): Promise<string> {
    const platform = this._flavor.detectPlatform()
    const dir = this._versionDir(version)
    const cached = this._binaryIn(dir, platform)
    if (await pathExists(cached)) {
      this._logger.info(`${this._flavor.id} binary cache hit ${cached}`)
      return cached
    }
    await this._adoptStagedVersion(version, platform, dir)
    if (await pathExists(cached)) return cached
    return this._download(version, platform, background)
  }

  /**
   * One-time migration for trees written by builds that staged prefetched
   * versions under `.prefetch/<version>/`: move the already-downloaded tree into
   * place instead of throwing away hundreds of MB and re-fetching it. Best-effort
   * — a failed move just falls through to a normal download.
   */
  private async _adoptStagedVersion(
    version: string,
    platform: AgentBinaryPlatform,
    destDir: string,
  ): Promise<void> {
    const staged = path.join(this._baseDir, '.prefetch', version)
    if (!(await pathExists(this._binaryIn(staged, platform)))) return
    this._logger.info(`adopting prefetched ${this._flavor.id} binary ${version}`)
    try {
      await this._rmQuiet(destDir)
      await mkdir(this._baseDir, { recursive: true })
      await this._renameWithRetry(staged, destDir)
    } catch (err) {
      this._logger.warn(
        `adopting prefetched ${this._flavor.id} binary ${version} failed: ${String(err)}`,
      )
    }
  }

  /**
   * Migrates whatever is left in the pre-2026-09 `.prefetch` staging area into
   * per-version dirs and removes the staging area, returning the versions now on
   * disk. Called from the cleanup sweep rather than only on demand: cleanup runs at
   * idle, i.e. before the user's next click, so a staged version would otherwise be
   * reclaimed (hundreds of MB) moments before the download that wanted it.
   */
  private async _adoptLegacyPrefetch(): Promise<string[]> {
    const staged = path.join(this._baseDir, '.prefetch')
    let entries: string[]
    try {
      entries = await readdir(staged)
    } catch {
      return []
    }
    const platform = this._flavor.detectPlatform()
    const adopted: string[] = []
    for (const version of entries) {
      if (version.startsWith('.')) continue
      const destDir = this._versionDir(version)
      if (!(await pathExists(this._binaryIn(destDir, platform)))) {
        await this._adoptStagedVersion(version, platform, destDir)
      }
      if (await pathExists(this._binaryIn(destDir, platform))) adopted.push(version)
    }
    await this._rmQuiet(staged)
    return adopted
  }

  private async _download(
    version: string,
    platform: AgentBinaryPlatform,
    background: boolean,
  ): Promise<string> {
    const destDir = this._versionDir(version)
    const pkg = this._flavor.platformPackage(platform)
    const registryVersion = this._flavor.platformVersion(version, platform)
    this._logger.info(
      `downloading ${this._flavor.id} binary ${pkg}@${registryVersion}${background ? ' (background)' : ''}`,
    )

    // Announce before the metadata round-trip so the UI shows the download the
    // moment it is requested rather than seconds later.
    this._beginDownload(version, background)
    const tmpDir = `${destDir}.extract.${process.pid}`
    try {
      const dist = await this._fetchDist(pkg, registryVersion)
      await mkdir(path.dirname(destDir), { recursive: true })

      // Stream the tarball straight through gunzip+untar into a temp dir — the
      // archive never lands on disk. Writing it out first tripped Windows
      // Defender, which locked the freshly-written `.tgz` (its payload is a large
      // executable) and made the cleanup `lstat` fail with EPERM. Extract to a
      // temp dir, verify, then atomically rename so a crash never leaves a
      // half-written tree that looks cached.
      await this._rmQuiet(tmpDir)
      await mkdir(tmpDir, { recursive: true })
      this._logger.info(`start downloading ${this._flavor.id} binary from ${dist.tarball}...`)
      await this._streamExtract(dist, tmpDir, platform, version)
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
      // Must run on failure too — a stale entry would leave the UI reporting a
      // download that is no longer happening.
      this._endDownload(version)
    }
  }

  private _emitDownloads(): void {
    this._onDidChangeDownload.fire([...this._downloads.values()])
  }

  private _beginDownload(version: string, background: boolean): void {
    this._downloads.set(version, { version, received: 0, total: 0, background })
    this._emitDownloads()
  }

  private _updateDownload(version: string, received: number, total: number): void {
    const prev = this._downloads.get(version)
    if (!prev) return
    this._downloads.set(version, { ...prev, received, total })
    this._emitDownloads()
  }

  private _endDownload(version: string): void {
    if (this._downloads.delete(version)) this._emitDownloads()
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
    version: string,
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
        this._updateDownload(version, received, total)
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
