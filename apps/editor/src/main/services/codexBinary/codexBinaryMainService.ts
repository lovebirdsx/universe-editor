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
 *  Unlike the old single-file codex-acp binary, the codex platform tarball nests
 *  the executable plus sibling runtime resources (sandbox helpers, ripgrep)
 *  under `package/vendor/<triple>/`; the whole `<triple>` tree is extracted and
 *  `bin/codex(.exe)` inside it is the resolved path.
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
 * Bounds "can we even reach the registry" for the metadata/connect phase of a
 * download. A DNS/TCP failure otherwise hangs on the OS-level connect timeout
 * (20s+ on Windows) with no upper bound of its own — fatal for a background
 * hydrate probe that must fail fast. Once the tarball response headers arrive,
 * streaming the body itself is intentionally left unbounded (a real multi-
 * hundred-MB download on a slow connection can legitimately take minutes).
 */
const NETWORK_TIMEOUT_MS = 10_000

/**
 * Pinned `@openai/codex` version to download. Kept in sync with the codex-acp
 * fork's lockfile (`vendor/codex-acp`); bumped by hand when following upstream.
 */
const CODEX_VERSION = '0.141.0'

interface PlatformBinary {
  /** Platform/arch suffix of the `@openai/codex` platform version, e.g. `win32-x64`. */
  readonly suffix: string
  /** Rust target triple the tarball nests the binary under, e.g. `x86_64-pc-windows-msvc`. */
  readonly triple: string
  /** Executable file name inside `vendor/<triple>/bin/` and the resolved path. */
  readonly binName: string
}

function detectPlatformBinary(): PlatformBinary {
  const arch = process.arch
  const win = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const mac = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const linux = arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'
  if (process.platform === 'win32')
    return { suffix: `win32-${arch}`, triple: win, binName: 'codex.exe' }
  if (process.platform === 'darwin')
    return { suffix: `darwin-${arch}`, triple: mac, binName: 'codex' }
  if (process.platform === 'linux')
    return { suffix: `linux-${arch}`, triple: linux, binName: 'codex' }
  throw new Error(`Unsupported platform for codex binary: ${process.platform}-${arch}`)
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
        return { path: await this._resolveDownload(opts.allowDownload ?? true) }
    }
  }

  private async _resolveCustom(customPath: string | undefined): Promise<ICodexBinaryResult> {
    if (!customPath) {
      throw new Error('codex binary: custom source selected but no path is configured.')
    }
    if (!(await pathExists(customPath))) {
      throw new Error(`codex binary not found at configured path: ${customPath}`)
    }
    return { path: customPath }
  }

  private async _resolveSystem(): Promise<string> {
    const resolved = await this._whichCodex()
    if (!resolved) {
      throw new Error(
        'No system `codex` executable found on PATH. Install it or switch ' +
          '`acp.codex.source` to "download".',
      )
    }
    this._logger.info(`using system codex at ${resolved}`)
    return resolved
  }

  /** Root dir holding all downloaded codex versions. */
  private _baseDir(): string {
    return path.join(app.getPath('userData'), 'codex-bin')
  }

  /** Directory a given version's extracted `vendor/<triple>` tree lives in. */
  private _versionDir(version: string): string {
    return path.join(this._baseDir(), version)
  }

  /** Resolved executable path inside an extracted version dir. */
  private _binaryIn(dir: string, binName: string): string {
    return path.join(dir, 'bin', binName)
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
   * Best-effort removal of every version dir except `keep`. A tree whose binary is
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
   * Removes stale (non-active) version trees. Call only at startup/idle: a just-
   * upgraded version's predecessor is still locked by the running agent (and its
   * tree holds live runtime resources like ripgrep), so deleting it mid-session
   * both fails (EPERM) and risks corrupting the live process — by next launch its
   * lock is gone and removal succeeds cleanly.
   */
  async cleanupStaleVersions(): Promise<void> {
    const active = (await this._readActiveVersion()) ?? CODEX_VERSION
    await this._cleanupStaleVersions(active)
  }

  private async _resolveDownload(allowDownload: boolean): Promise<string> {
    const { suffix, triple, binName } = detectPlatformBinary()
    const active = (await this._readActiveVersion()) ?? CODEX_VERSION
    const cached = this._binaryIn(this._versionDir(active), binName)
    if (await pathExists(cached)) {
      this._logger.info(`codex binary cache hit ${cached}`)
      return cached
    }
    if (!allowDownload) {
      throw new Error(
        'codex binary is not downloaded yet — background probes never trigger a download; ' +
          'start a Codex session or download it explicitly to fetch it.',
      )
    }
    const versionDir = this._versionDir(CODEX_VERSION)
    const binaryPath = await this._download(CODEX_VERSION, suffix, triple, binName, versionDir)
    await this._setActiveVersion(CODEX_VERSION)
    return binaryPath
  }

  async getVersionInfo(): Promise<ICodexBinaryVersionInfo> {
    const bundledVersion = CODEX_VERSION
    const { binName } = detectPlatformBinary()

    // The active version's dir name *is* its version; verify the binary still
    // exists before reporting it. Fall back to the pinned-version dir for trees
    // written before the `.active` pointer scheme.
    let installedVersion: string | null = null
    const active = await this._readActiveVersion()
    if (active && (await pathExists(this._binaryIn(this._versionDir(active), binName)))) {
      installedVersion = active
    } else if (await pathExists(this._binaryIn(this._versionDir(bundledVersion), binName))) {
      installedVersion = bundledVersion
    }

    let latestVersion: string | null = null
    try {
      const res = await fetch(`${REGISTRY}/@openai/codex/latest`, {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      })
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
      if (await pathExists(this._binaryIn(path.join(root, version), binName))) return version
    }
    return null
  }

  async prefetch(): Promise<void> {
    const bundledVersion = CODEX_VERSION
    const { suffix, triple, binName } = detectPlatformBinary()

    // Prefer the latest release; fall back to the pinned version when the
    // registry is unreachable.
    let target = bundledVersion
    try {
      const res = await fetch(`${REGISTRY}/@openai/codex/latest`, {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      })
      if (res.ok) {
        const body = (await res.json()) as { version?: string }
        if (body.version) target = body.version
      }
    } catch {
      // network error — fall back to pinned
    }

    // Already the active version? Nothing worth prefetching.
    const active = (await this._readActiveVersion()) ?? bundledVersion
    if (
      active === target &&
      (await pathExists(this._binaryIn(this._versionDir(active), binName)))
    ) {
      return
    }

    // Already staged for this exact version? Done.
    const staged = this._prefetchDir(target)
    if (await pathExists(this._binaryIn(staged, binName))) {
      this._logger.info(`codex binary already prefetched ${target}`)
      return
    }

    // Clear any stale staging dirs (other versions) before fetching the target.
    await this._rmQuiet(path.join(this._baseDir(), '.prefetch'))
    this._logger.info(`prefetching codex binary ${target} in background`)
    await this._download(target, suffix, triple, binName, staged, true)
    this._logger.info(`codex binary prefetch ready ${target}`)
  }

  async forceDownload(version: string): Promise<ICodexBinaryResult> {
    const { suffix, triple, binName } = detectPlatformBinary()
    const versionDir = this._versionDir(version)
    const cached = this._binaryIn(versionDir, binName)

    // Clear inflight cache so the next resolve() call doesn't return the stale result.
    this._inflight.delete('download:')
    this._inflight.delete('download::noDownload')

    // Already the active, on-disk version — nothing to do. Re-downloading it would
    // target its own (possibly running, hence locked) tree.
    const active = await this._readActiveVersion()
    if (active === version && (await pathExists(cached))) {
      this._logger.info(`codex binary ${version} already active`)
      return { path: cached }
    }

    // Each version lives in its own tree, so the activation target never overlaps the
    // running binary's tree — no need to delete a locked, in-use exe (the EPERM trap).
    // The previously active tree is left in place; cleanup removes whatever isn't locked.
    const staged = this._prefetchDir(version)
    if (await pathExists(this._binaryIn(staged, binName))) {
      this._logger.info(`activating prefetched codex binary ${version}`)
      await this._rmQuiet(versionDir)
      await mkdir(this._baseDir(), { recursive: true })
      await this._renameWithRetry(staged, versionDir)
    } else {
      await this._rmQuiet(versionDir)
      await this._download(version, suffix, triple, binName, versionDir)
    }

    await this._setActiveVersion(version)
    // Don't clean up the previous version's tree here — it's still locked by the
    // running agent and removal would block the upgrade UI for seconds and risk a
    // partial delete. Stale trees are swept at next startup via cleanupStaleVersions().
    return { path: cached }
  }

  private async _download(
    version: string,
    suffix: string,
    triple: string,
    binName: string,
    destDir: string,
    silent = false,
  ): Promise<string> {
    // The codex binary ships as a platform version of `@openai/codex`, e.g.
    // `@openai/codex@0.141.0-win32-x64`. Registry coordinates are the base name
    // and the platform-suffixed version.
    const pkg = '@openai/codex'
    const platformVersion = `${version}-${suffix}`
    this._logger.info(
      `downloading codex binary ${pkg}@${platformVersion}${silent ? ' (background)' : ''}`,
    )

    const dist = await this._fetchDist(pkg, platformVersion)
    await mkdir(path.dirname(destDir), { recursive: true })

    // Stream the tarball straight through gunzip+untar into a temp dir — the
    // archive never lands on disk (see ClaudeBinaryMainService for the Windows
    // Defender rationale). Extract to a temp dir, verify, then atomically rename
    // so a crash never leaves a half-written tree that looks cached.
    const tmpDir = `${destDir}.extract.${process.pid}`
    await this._rmQuiet(tmpDir)
    await mkdir(tmpDir, { recursive: true })
    try {
      this._logger.info(`start downloading codex binary from ${dist.tarball}...`)
      await this._streamExtract(dist, tmpDir, triple, silent)
      const extracted = this._binaryIn(tmpDir, binName)
      this._logger.info(`downloading codex binary complete, extracted to ${tmpDir}`)
      if (!(await pathExists(extracted))) {
        throw new Error(
          `Tarball ${pkg}@${platformVersion} did not contain vendor/${triple}/bin/${binName}`,
        )
      }
      if (process.platform !== 'win32') await chmod(extracted, 0o755)
      await this._rmQuiet(destDir)
      await this._renameWithRetry(tmpDir, destDir)
      const cached = this._binaryIn(destDir, binName)
      this._logger.info(`codex binary ready at ${cached}`)
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
    triple: string,
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
    // The binary + its sibling runtime resources live under
    // `package/vendor/<triple>/` (npm prefixes every entry with `package/`; the
    // codex platform package nests everything under `vendor/<triple>/`). Strip
    // those three segments so `bin/<binName>`, `codex-resources/`, `codex-path/`
    // land directly in tmpDir with their original relative layout preserved.
    const prefix = `package/vendor/${triple}/`
    await pipeline(
      source,
      meter,
      tarExtract({ cwd: tmpDir, strip: 3, filter: (p) => p.startsWith(prefix) }),
    )

    this._verifyIntegrity(hash, dist, dist.tarball)
  }

  /** Best-effort recursive remove that survives transient Windows file locks. */
  private async _rmQuiet(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (err) {
      this._logger.warn(`codex binary cleanup failed for ${target}: ${String(err)}`)
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
