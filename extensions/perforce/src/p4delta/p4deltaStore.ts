/**
 * The managed copy of δ: a per-version directory under `root`, a pointer file
 * naming the version in use, and the download that fills it.
 *
 * Layout (`root` is `<globalStoragePath>/p4delta`, shared by every window of
 * this install):
 *
 *     <root>/<version>/p4delta.exe      one directory per version; the dir name IS the version
 *     <root>/<version>.zip.<pid>.<n>    download staging
 *     <root>/<version>.extract.<pid>.<n> extraction staging
 *     <root>/.active                    "0.1.10" — the one source of truth for what runs
 *     <root>/.check                     throttle stamp + last result + last-seen latest
 *
 * Upgrading is "drop a new directory, move the pointer": a running binary is
 * never overwritten (Windows holds a lock on it) and rolling back is moving the
 * pointer back. The cost is a few MB of redundancy, recycled by the keep set.
 *
 * Three deliberate design points, each mirroring the agent-binary store
 * (`packages/node-services/src/agentBinary`) because the same forces apply:
 *
 *  - **No lock file.** Concurrent editors on one machine are handled by four
 *    invariants instead: (1) a version already on disk is adopted with zero
 *    network, (2) a failed rename whose destination is already usable counts as
 *    SUCCESS — another window finished the same job, and its copy is just as
 *    good as ours, (3) staging names carry pid + an in-process counter, and (4)
 *    concurrent `sync()` calls in one process share a single promise. Invariant
 *    2 is a correctness requirement, not resilience polish: dropping it turns a
 *    benign race into a reported failure.
 *  - **Never throws.** Every failure is a `failed` outcome with a reason. The
 *    caller runs this in the background of an optional optimization; there is
 *    nobody to catch an exception.
 *  - **No version floor.** Unlike the agent binaries, a binary that answers the
 *    contract is driven on existence alone (`resolveP4deltaEngine`); an old or
 *    half-installed build is left to the client's failure ladder. Do not add a
 *    `--version` probe here "while we are at it" — that decision was made
 *    deliberately in the extension, see `docs/reconcile.md`.
 */
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import AdmZip from 'adm-zip'
import {
  assetNameFor,
  assetUrl,
  latestUrl,
  latestVersionFrom,
  p4deltaTargetTriple,
  parseSha256Sums,
  releaseBaseUrl,
  type P4deltaSource,
} from './p4deltaUpstream.js'
import {
  compareP4deltaVersion,
  formatP4deltaVersion,
  parseP4deltaVersion,
  type P4deltaVersion,
} from './p4deltaVersion.js'

/** The only executable name a managed copy ever has (upstream publishes win32-x64). */
export const P4DELTA_EXE_NAME = 'p4delta.exe'

const ACTIVE_POINTER = '.active'
const CHECK_RECORD = '.check'

/** How long a successful upstream check is trusted. GitHub allows 60 unauthenticated requests/hour per IP. */
const SUCCESS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Backoff after a failed check (offline, DNS, 5xx). */
const FAILURE_RETRY_INTERVAL_MS = 60 * 60 * 1000
/** Upper bound for an honoured `Retry-After` — a rate limit must not park the check for days. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000
/** Bounds the connect/headers phase only; once headers arrive the body streams unbounded. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
/**
 * A p4delta zip is a few MB. This is a "the mirror answered with something
 * else entirely" guard, not a size budget.
 */
const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
/** `rename` has no built-in retry; antivirus can hold the source for a moment. */
const RENAME_ATTEMPTS = 5
/** Staging left behind by a crashed process is swept once it is this old. */
const STALE_STAGING_MS = 60 * 60 * 1000

const USER_AGENT = 'universe-editor-perforce'

export interface P4deltaStoreOptions {
  /** `<globalStoragePath>/p4delta`; the empty string disables the store. */
  readonly root: string
  readonly source: P4deltaSource
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly log?: (msg: string) => void
  readonly connectTimeoutMs?: number
  readonly maxDownloadBytes?: number
  /** Download progress, for the manual command's notification. Never called by the background path. */
  readonly onProgress?: (received: number, total: number | undefined) => void
}

/** What one `sync()` did. Every branch is a settle, not a throw. */
export type P4deltaSyncOutcome =
  | { readonly kind: 'installed'; readonly version: string; readonly previousVersion?: string }
  | { readonly kind: 'up-to-date'; readonly version: string }
  | { readonly kind: 'throttled'; readonly nextCheckAt: number }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  /** The caller's signal fired. Distinct from `failed`: see the catch blocks. */
  | { readonly kind: 'cancelled' }

export interface P4deltaStore {
  sync(force?: boolean, opts?: { signal?: AbortSignal }): Promise<P4deltaSyncOutcome>
  /** The managed executable the pointer names right now, or undefined. */
  activeExe(): string | undefined
  cleanup(): Promise<void>
}

/**
 * The managed executable the pointer names, or undefined when there is none.
 *
 * Synchronous and total by contract: the admission gate (`resolveP4deltaEngine`)
 * runs on every configuration change and must be able to ask this without
 * awaiting anything. A missing, unreadable or malformed pointer is "no managed
 * copy", never an exception.
 */
export function activeManagedP4delta(root: string): string | undefined {
  if (root === '') return undefined
  const version = readActiveVersion(root)
  if (version === undefined) return undefined
  const exe = join(root, version, P4DELTA_EXE_NAME)
  return existsSync(exe) ? exe : undefined
}

function readActiveVersion(root: string): string | undefined {
  try {
    const raw = readFileSync(join(root, ACTIVE_POINTER), 'utf8').trim()
    return parseP4deltaVersion(raw) === undefined ? undefined : raw
  } catch {
    return undefined
  }
}

interface CheckRecord {
  /** Epoch ms before which no new check may run. */
  readonly nextCheckAt: number
  readonly ok: boolean
  /** Last latest-release version seen — kept so the keep set can name it without network. */
  readonly version?: string
}

function readCheckRecord(root: string): CheckRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, CHECK_RECORD), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { nextCheckAt?: unknown; ok?: unknown; version?: unknown }
    if (typeof record.nextCheckAt !== 'number' || !Number.isFinite(record.nextCheckAt)) {
      return undefined
    }
    return {
      nextCheckAt: record.nextCheckAt,
      ok: record.ok === true,
      ...(typeof record.version === 'string' ? { version: record.version } : {}),
    }
  } catch {
    // Missing or corrupt: behave as "never checked", which only costs one query.
    return undefined
  }
}

/** Write-temp-then-rename: a reader never sees a half-written pointer. */
function writeFileAtomicSync(target: string, text: string): void {
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, target)
  } catch (err) {
    rmQuiet(tmp)
    throw err
  }
}

/** Best-effort recursive remove that survives transient Windows file locks. */
function rmQuiet(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // A locked file is swept by a later session; nothing here is load-bearing.
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const code = (err as NodeJS.ErrnoException).code
  return code ? `${code} — ${err.message}` : err.message
}

/** An HTTP response that was not ok, with the rate-limit hint when there is one. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
    message: string,
  ) {
    super(message)
  }
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

/** In-process de-duplication: two `sync()` calls for one root share a single run. */
const inflightSyncs = new Map<string, Promise<P4deltaSyncOutcome>>()

/** Distinguishes staging names within one process (two stores, one root). */
let stagingSeq = 0

function nextStagingSuffix(): string {
  stagingSeq += 1
  return `${process.pid}.${stagingSeq}`
}

export function openP4deltaStore(options: P4deltaStoreOptions): P4deltaStore {
  return new P4deltaStoreImpl(options)
}

class P4deltaStoreImpl implements P4deltaStore {
  private readonly _root: string
  private readonly _source: P4deltaSource
  private readonly _platform: NodeJS.Platform
  private readonly _arch: string
  private readonly _fetch: typeof fetch
  private readonly _now: () => number
  private readonly _log: (msg: string) => void
  private readonly _connectTimeoutMs: number
  private readonly _maxDownloadBytes: number
  private readonly _onProgress: ((received: number, total: number | undefined) => void) | undefined
  /** Versions this session switched away from: still worth keeping until the process ends. */
  private readonly _retained = new Set<string>()
  private _cleaned = false

  constructor(options: P4deltaStoreOptions) {
    this._root = options.root
    this._source = options.source
    this._platform = options.platform ?? process.platform
    this._arch = options.arch ?? process.arch
    this._fetch = options.fetchImpl ?? globalThis.fetch
    this._now = options.now ?? Date.now
    // The log sink is caller code reached from background work; swallowing a
    // throw here keeps one bad sink from failing an install.
    this._log = (message) => {
      try {
        options.log?.(message)
      } catch {
        // best-effort
      }
    }
    this._connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this._maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
    this._onProgress = options.onProgress
  }

  activeExe(): string | undefined {
    return activeManagedP4delta(this._root)
  }

  sync(force = false, opts?: { signal?: AbortSignal }): Promise<P4deltaSyncOutcome> {
    const existing = inflightSyncs.get(this._root)
    // A forced call is a user asking for this NOW, carrying their own progress
    // and cancel: it must not be answered by another caller's run. That run's
    // throttle decision is exactly what `force` exists to skip, and its callbacks
    // are the other caller's. Let it settle, then go ourselves.
    if (existing !== undefined) {
      if (!force) return existing
      return existing.then(() => this.sync(force, opts))
    }
    // The catch is the never-throws contract's last line: everything below is
    // already converted to an outcome, but a filesystem surprise in the
    // activation path must not become a rejection either.
    const run = this._sync(force, opts)
      .catch((err: unknown): P4deltaSyncOutcome => ({ kind: 'failed', reason: describeError(err) }))
      .finally(() => {
        if (inflightSyncs.get(this._root) === run) inflightSyncs.delete(this._root)
      })
    inflightSyncs.set(this._root, run)
    return run
  }

  private async _sync(
    force: boolean,
    opts?: { signal?: AbortSignal },
  ): Promise<P4deltaSyncOutcome> {
    if (this._root === '') return { kind: 'skipped', reason: 'no managed root' }
    const triple = p4deltaTargetTriple(this._platform, this._arch)
    if (triple === undefined) {
      return { kind: 'skipped', reason: `no p4delta build for ${this._platform}-${this._arch}` }
    }

    const now = this._now()
    const check = readCheckRecord(this._root)
    if (!force && check !== undefined && now < check.nextCheckAt) {
      this._log(
        `p4delta: upstream check skipped until ${new Date(check.nextCheckAt).toISOString()}`,
      )
      return { kind: 'throttled', nextCheckAt: check.nextCheckAt }
    }

    let latest: P4deltaVersion
    try {
      const json = await this._fetchJson(latestUrl(this._source), opts?.signal)
      const parsed = latestVersionFrom(this._source, json)
      if (parsed === undefined) throw new Error('latest-release document names no version')
      latest = parsed
    } catch (err) {
      // A user cancel says nothing about the upstream, so it must not stamp the
      // failure backoff — the next background check should still go out.
      if (opts?.signal?.aborted === true) return { kind: 'cancelled' }
      const retryAfterMs = err instanceof HttpError ? err.retryAfterMs : undefined
      this._writeCheck(now + this._backoffMs(retryAfterMs), false, check?.version)
      return { kind: 'failed', reason: describeError(err) }
    }

    const latestText = formatP4deltaVersion(latest)
    const active = readActiveVersion(this._root)
    if (active !== undefined) {
      const activeVersion = parseP4deltaVersion(active)
      if (activeVersion !== undefined && compareP4deltaVersion(latest, activeVersion) <= 0) {
        this._log(`p4delta: managed copy ${active} is up to date`)
        this._writeCheck(now + SUCCESS_CHECK_INTERVAL_MS, true, latestText)
        await this._cleanupOnce()
        return { kind: 'up-to-date', version: active }
      }
    }

    const destExe = join(this._root, latestText, P4DELTA_EXE_NAME)
    if (existsSync(destExe)) {
      // Another window (or an earlier session) already downloaded it.
      this._log(`p4delta: adopting ${latestText} already on disk`)
      this._activate(latestText, active)
      this._writeCheck(now + SUCCESS_CHECK_INTERVAL_MS, true, latestText)
      await this._cleanupOnce()
      return {
        kind: 'installed',
        version: latestText,
        ...(active !== undefined ? { previousVersion: active } : {}),
      }
    }

    try {
      this._log(`p4delta: downloading ${latestText} (${assetNameFor(latestText, triple)})`)
      await this._downloadVersion(latestText, triple, opts?.signal)
    } catch (err) {
      if (opts?.signal?.aborted === true) return { kind: 'cancelled' }
      const retryAfterMs = err instanceof HttpError ? err.retryAfterMs : undefined
      this._writeCheck(now + this._backoffMs(retryAfterMs), false, check?.version)
      return { kind: 'failed', reason: describeError(err) }
    }

    this._activate(latestText, active)
    this._writeCheck(now + SUCCESS_CHECK_INTERVAL_MS, true, latestText)
    this._log(`p4delta: activated ${latestText}${active !== undefined ? ` (was ${active})` : ''}`)
    await this._cleanupOnce()
    return {
      kind: 'installed',
      version: latestText,
      ...(active !== undefined ? { previousVersion: active } : {}),
    }
  }

  private _backoffMs(retryAfterMs: number | undefined): number {
    const requested = retryAfterMs ?? FAILURE_RETRY_INTERVAL_MS
    return Math.min(Math.max(requested, FAILURE_RETRY_INTERVAL_MS), MAX_RETRY_AFTER_MS)
  }

  private _writeCheck(nextCheckAt: number, ok: boolean, version: string | undefined): void {
    const record: CheckRecord = { nextCheckAt, ok, ...(version !== undefined ? { version } : {}) }
    try {
      // A failed check on a machine that never installed anything has no root
      // yet; creating it here keeps the throttle record writable from the very
      // first (failing) query, so an offline machine is not re-queried by every
      // window on every start.
      mkdirSync(this._root, { recursive: true })
      writeFileAtomicSync(join(this._root, CHECK_RECORD), JSON.stringify(record))
    } catch (err) {
      // Losing the throttle record costs one extra query next session; it must
      // not turn a successful install into a failure.
      this._log(`p4delta: could not write ${CHECK_RECORD}: ${describeError(err)}`)
    }
  }

  private _activate(version: string, previous: string | undefined): void {
    try {
      mkdirSync(this._root, { recursive: true })
      writeFileAtomicSync(join(this._root, ACTIVE_POINTER), version)
    } catch (err) {
      throw new Error(`could not activate ${version}: ${describeError(err)}`)
    }
    if (previous !== undefined && previous !== version) this._retained.add(previous)
  }

  private async _downloadVersion(
    version: string,
    triple: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const assetName = assetNameFor(version, triple)
    const base = releaseBaseUrl(this._source, version)
    const staging = nextStagingSuffix()
    const zipPath = join(this._root, `${version}.zip.${staging}`)
    const stagingDir = join(this._root, `${version}.extract.${staging}`)
    const destDir = join(this._root, version)
    try {
      mkdirSync(this._root, { recursive: true })
      // The checksum list comes first: a release that has no digest for the
      // asset is refused before the download is paid for.
      const sums = await this._fetchText(assetUrl(base, 'SHA256SUMS'), signal)
      const expected = parseSha256Sums(sums, assetName)
      if (expected === undefined) throw new Error(`SHA256SUMS does not list ${assetName}`)

      const actual = await this._downloadFile(assetUrl(base, assetName), zipPath, signal)
      if (actual !== expected) {
        throw new Error(`checksum mismatch for ${assetName} (expected ${expected}, got ${actual})`)
      }

      mkdirSync(stagingDir, { recursive: true })
      extractExe(zipPath, join(stagingDir, P4DELTA_EXE_NAME))
      await this._place(stagingDir, destDir)
    } finally {
      // Failure must not leave staging behind: a half-written zip would be
      // adopted by the next run's "is it on disk?" check for the same version.
      rmQuiet(zipPath)
      rmQuiet(stagingDir)
    }
  }

  /**
   * Move the extracted directory into place.
   *
   * Whatever sits at the destination is moved ASIDE rather than deleted, and put
   * back if we cannot take its place. That directory can be a complete copy
   * another window placed a moment ago — and `.active` may already name this
   * version, so deleting it and then failing would leave the pointer dangling,
   * which reads as "no managed copy at all" for the rest of the session.
   *
   * A rename that keeps failing while the destination holds the executable is a
   * SUCCESS: another window placed the same version while we were downloading,
   * and both copies are byte-identical by construction (the digest was verified
   * against the same release).
   */
  private async _place(from: string, to: string): Promise<void> {
    // Re-check right before the destructive step: the caller's adopt check ran
    // before the download, seconds ago.
    if (existsSync(join(to, P4DELTA_EXE_NAME))) return
    // The staging name is reused on purpose: if a restore below ever fails, the
    // sweeper collects this directory like any other leftover.
    const aside = `${to}.extract.${nextStagingSuffix()}`
    let stashed = false
    try {
      renameSync(to, aside)
      stashed = true
    } catch {
      // Nothing there to move, or it is locked — the rename below tells the truth.
    }
    let lastErr: unknown
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
      try {
        renameSync(from, to)
        if (stashed) rmQuiet(aside)
        return
      } catch (err) {
        lastErr = err
        if (existsSync(join(to, P4DELTA_EXE_NAME))) {
          if (stashed) rmQuiet(aside)
          return
        }
        if (attempt < RENAME_ATTEMPTS - 1) await delay(100 * (attempt + 1))
      }
    }
    if (stashed) {
      try {
        renameSync(aside, to)
      } catch {
        // Leave it on disk: a copy in the wrong directory beats no copy, and the
        // sweeper will collect it.
      }
    }
    throw lastErr
  }

  private async _fetchJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    const res = await this._fetchBounded(url, signal, 'application/vnd.github+json')
    return await res.json()
  }

  private async _fetchText(url: string, signal: AbortSignal | undefined): Promise<string> {
    const res = await this._fetchBounded(url, signal, 'text/plain')
    return await res.text()
  }

  /**
   * Fetch with the connect/headers phase bounded. Once the response arrives the
   * timer is cleared and the body streams unbounded — a slow connection is not a
   * failure (the same rule as the agent-binary store).
   */
  private async _fetchBounded(
    url: string,
    signal: AbortSignal | undefined,
    accept: string,
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`timed out connecting to ${url}`)),
      this._connectTimeoutMs,
    )
    timer.unref?.()
    const combined =
      signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
    let res: Response
    try {
      res = await this._fetch(url, {
        signal: combined,
        redirect: 'follow',
        headers: { accept, 'user-agent': USER_AGENT },
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      throw new HttpError(
        res.status,
        parseRetryAfter(res.headers.get('retry-after'), this._now()),
        `HTTP ${res.status} for ${url}`,
      )
    }
    return res
  }

  private async _downloadFile(
    url: string,
    dest: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const res = await this._fetchBounded(url, signal, 'application/octet-stream')
    if (res.body === null) throw new Error(`response for ${url} has no body`)
    const headerLength = Number(res.headers.get('content-length') ?? 0)
    const total = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : undefined
    let received = 0
    const hash = createHash('sha256')
    // Hash and progress ride a Transform rather than a `data` listener: adding
    // one would switch the stream to flowing mode and race the pipe, dropping
    // mid-stream bytes (the agent-binary store documents the same trap).
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        received += chunk.length
        if (received > this._maxDownloadBytes) {
          cb(new Error(`${url} exceeded ${this._maxDownloadBytes} bytes`))
          return
        }
        hash.update(chunk)
        // Same rule as the log sink: a caller's callback that throws must not
        // turn a download that is already verified into a reported failure.
        try {
          this._onProgress?.(received, total)
        } catch {
          // best-effort
        }
        cb(null, chunk)
      },
    })
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(source, meter, createWriteStream(dest))
    return hash.digest('hex')
  }

  /** At most one sweep per session, and only after a settled sync. */
  private async _cleanupOnce(): Promise<void> {
    if (this._cleaned) return
    this._cleaned = true
    await this.cleanup()
  }

  async cleanup(): Promise<void> {
    if (this._root === '') return
    const keep = new Set<string>()
    const active = readActiveVersion(this._root)
    if (active !== undefined) keep.add(active)
    const check = readCheckRecord(this._root)
    if (check?.version !== undefined) keep.add(check.version)
    for (const version of this._retained) keep.add(version)
    const highest = this._highestOnDisk()
    if (highest !== undefined) keep.add(highest)

    let entries: string[]
    try {
      entries = readdirSync(this._root)
    } catch {
      return
    }
    const now = this._now()
    for (const entry of entries) {
      const full = join(this._root, entry)
      if (isStagingName(entry)) {
        // Only stale staging: a live download in another window is seconds old.
        if (this._mtimeMs(full) < now - STALE_STAGING_MS) rmQuiet(full)
        continue
      }
      if (entry.startsWith('.')) continue
      if (keep.has(entry)) continue
      if (parseP4deltaVersion(entry) === undefined) continue
      this._log(`p4delta: removing stale managed copy ${entry}`)
      rmQuiet(full)
    }
  }

  private _highestOnDisk(): string | undefined {
    let best: P4deltaVersion | undefined
    let bestText: string | undefined
    try {
      for (const entry of readdirSync(this._root)) {
        const parsed = parseP4deltaVersion(entry)
        if (parsed === undefined) continue
        if (best === undefined || compareP4deltaVersion(parsed, best) > 0) {
          best = parsed
          bestText = entry
        }
      }
    } catch {
      // Unreadable root: nothing to keep, and nothing to sweep either.
    }
    return bestText
  }

  private _mtimeMs(path: string): number {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }
}

function isStagingName(entry: string): boolean {
  return /\.(zip|extract)\.\d+\.\d+$/.test(entry)
}

/**
 * Pull exactly `P4DELTA_EXE_NAME` out of the release zip.
 *
 * Only the one entry, by exact name: no path from the archive is ever joined
 * onto a destination, which is what makes the zip-slip class of bugs
 * unreachable here (the archive is also digest-verified before it gets this
 * far).
 */
function extractExe(zipPath: string, destFile: string): void {
  const zip = new AdmZip(zipPath)
  const entry = zip.getEntry(P4DELTA_EXE_NAME)
  if (entry === null) throw new Error(`archive does not contain ${P4DELTA_EXE_NAME}`)
  const data = zip.readFile(entry)
  if (data === null) throw new Error(`archive entry ${P4DELTA_EXE_NAME} is unreadable`)
  writeFileSync(destFile, data, { mode: 0o755 })
}
