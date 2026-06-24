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
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

  private async _resolveDownload(): Promise<string> {
    const version = await this._readSdkVersion()
    const { suffix, binName } = detectPlatformBinary()
    const cached = path.join(app.getPath('userData'), 'claude-bin', version, binName)
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

    return this._download(version, suffix, binName, cached)
  }

  private async _download(
    version: string,
    suffix: string,
    binName: string,
    cached: string,
  ): Promise<string> {
    const pkg = `@anthropic-ai/claude-agent-sdk-${suffix}`
    this._logger.info(`downloading claude binary ${pkg}@${version}`)

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
      await this._streamExtract(dist, tmpDir, binName)
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

  private async _streamExtract(dist: RegistryDist, tmpDir: string, binName: string): Promise<void> {
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
        this._onDidChangeProgress.fire({ received, total })
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
    const cacheDir = path.join(app.getPath('userData'), 'claude-bin', bundledVersion)
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
      const res = await fetch(`${REGISTRY}/@anthropic-ai/claude-agent-sdk/latest`)
      if (res.ok) {
        const body = (await res.json()) as { version?: string }
        latestVersion = body.version ?? null
      }
    } catch {
      // network error — leave latestVersion null
    }

    return { bundledVersion, installedVersion, latestVersion }
  }

  async forceDownload(version: string): Promise<IClaudeBinaryResult> {
    const bundledVersion = await this._readSdkVersion()
    const { suffix, binName } = detectPlatformBinary()
    const cacheDir = path.join(app.getPath('userData'), 'claude-bin', bundledVersion)
    const cached = path.join(cacheDir, binName)

    await this._rmQuiet(cached)
    // Clear inflight cache so the next resolve() call doesn't return the stale result.
    this._inflight.delete('download:')

    const binaryPath = await this._download(version, suffix, binName, cached)
    await writeFile(path.join(cacheDir, '.version'), version, 'utf8')
    return { path: binaryPath }
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
