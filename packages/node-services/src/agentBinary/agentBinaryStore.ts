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
 *  same version share one fetch. A third pointer, `.bundled`, records the pinned
 *  version the tree was last aligned to — `syncBundled` re-activates the pin when
 *  it changes (an editor upgrade) without ever touching a user's chosen version.
 *
 *  Which version the tree runs is the caller's call, carried as an
 *  `AgentBinaryVersionPolicy`: `'manual'` honours the `.active` pointer (a version
 *  the user picked), `'pinned'` ignores it and always runs the pin — the editor's
 *  default, so a hand-picked version cannot outlive an editor upgrade. Under
 *  `'manual'` the pin is still a *floor*, not just an idle-time alignment target:
 *  resolving never serves a binary older than `bundledVersion()`, replacing such
 *  an `.active` with the pin (from disk, or by downloading it). See
 *  `_resolveDownload`.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import * as path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extract as tarExtract } from 'tar'
import {
  type AgentBinaryVersionPolicy,
  createNamedLogger,
  Disposable,
  Emitter,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import type { AgentBinaryFlavor, AgentBinaryPlatform } from './flavors.js'
import { compareBinaryVersions, parseBinaryVersion } from './binaryVersion.js'

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

  private readonly _onDidChangeActiveVersion = this._register(new Emitter<void>())
  /**
   * Fires whenever `.active` is (re)written. Anything caching a resolved path must
   * drop it here: the pointer moving is what makes such a cache stale, and under
   * the locked policy it moves with no download at all (`_reconcilePinnedActive`).
   */
  readonly onDidChangeActiveVersion = this._onDidChangeActiveVersion.event

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
  /**
   * The version a switch moved away from, kept out of the sweep for the rest of
   * this process. A session may still be running it (and hold its dir locked on
   * Windows), and reverting to it offline needs it on disk — a *second window*
   * opened later sweeps after `.active` has already moved on, so its keep-set
   * would no longer name the dir. One slot is enough: the pin changes at most
   * once per build.
   */
  private _retainedVersion: string | undefined
  /**
  /**
   * Floor-related warnings already logged, keyed by cause. Every one of them
   * describes a state that persists (a corrupt pointer, a stale binary) while the
   * silent resolve path runs on every session connect — without this, one broken
   * pointer would write a warning per connect for the rest of the session.
   */
  private readonly _warnedFloorMessages = new Set<string>()
  /**
   * The pin whose `.active` reconcile already ran in this process. The reconcile
   * only ever has work to do once per pin, and `resolveDownload` runs on every
   * session spawn — without this, each spawn would pay a pointer-file read.
   */
  private _pinnedActiveReconciled: string | undefined

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

  private _bundledFile(): string {
    return path.join(this._baseDir, '.bundled')
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
    this._onDidChangeActiveVersion.fire()
  }

  /**
   * Keeps `.active` naming the pin while the locked policy is in force. Call only
   * where the pin's binary was just verified on disk. Without this, a version the
   * user picked before locking would stay in the pointer — pinned ignores it, but
   * unlocking again would silently resume that version instead of the pin. Pure
   * bookkeeping: a failed pointer write must not fail the resolve that found it.
   */
  private async _reconcilePinnedActive(pin: string): Promise<void> {
    if (this._pinnedActiveReconciled === pin) return
    try {
      if ((await this._readActiveVersion()) !== pin) await this._setActiveVersion(pin)
      this._pinnedActiveReconciled = pin
    } catch (err) {
      this._logger.warn(`${this._flavor.id} binary .active reconcile failed: ${String(err)}`)
    }
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

  /**
   * The pin this tree was last aligned to — deliberately *not* the current pin
   * (`bundledVersion()`). A missing file means "never aligned": the first idle
   * sweep after an upgrade aligns once, and a user's hand-picked version is left
   * alone until the pin itself changes again.
   */
  private async _readAlignedPin(): Promise<string | null> {
    try {
      const v = (await readFile(this._bundledFile(), 'utf8')).trim()
      return v || null
    } catch {
      return null
    }
  }

  /**
   * Written only after an alignment actually landed, so a failed one retries next
   * session. Deliberately absent from the cleanup keep-set: it names a version
   * `bundledVersion()` already keeps, and the pointer file itself is a dotfile the
   * sweep skips.
   */
  private async _rememberAlignedPin(version: string): Promise<void> {
    await mkdir(this._baseDir, { recursive: true })
    await writeFile(this._bundledFile(), version, 'utf8')
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
   * rejection to a concurrent caller that actually wants to download, and the
   * policy is part of the key so flipping it mid-session (the user unlocking or
   * locking version selection) can never reuse the other mode's resolved path.
   */
  resolveDownload(allowDownload: boolean, policy: AgentBinaryVersionPolicy): Promise<string> {
    const key = `${policy}:${allowDownload ? 'download' : 'noDownload'}`
    let pending = this._inflightResolves.get(key)
    if (!pending) {
      pending = this._resolveDownload(allowDownload, policy).finally(() => {
        this._inflightResolves.delete(key)
      })
      this._inflightResolves.set(key, pending)
    }
    return pending
  }

  private async _resolveDownload(
    allowDownload: boolean,
    policy: AgentBinaryVersionPolicy,
  ): Promise<string> {
    const version = await this._flavor.bundledVersion()
    const platform = this._flavor.detectPlatform()
    const active = await this._readActiveVersion()

    // Under `'manual'` the pointer is honoured — but never below the pin. The pin
    // is a *floor*, not just an idle-time alignment target: an editor upgrade moves
    // it and the idle alignment (syncBundled) may not have run yet, yet no session
    // may launch the stale binary in between. A version *above* the pin is a
    // deliberate user choice and is left alone.
    if (policy === 'manual' && active !== null && !this._isBelowLocked(active, version)) {
      const activeBinary = this._binaryIn(this._versionDir(active), platform)
      if (await pathExists(activeBinary)) {
        this._logger.info(`${this._flavor.id} binary cache hit ${activeBinary}`)
        return activeBinary
      }
    }

    // Everything else runs the pin: under `'pinned'` the pointer is deliberately
    // ignored, so a version a user picked by hand can never outlive the editor
    // upgrade that changed the pin; under `'manual'` it was missing, below the
    // floor, or its dir had vanished. The pin itself is on disk — switch to it with
    // zero network.
    const pinnedBinary = this._binaryIn(this._versionDir(version), platform)
    if (await pathExists(pinnedBinary)) {
      if (policy === 'pinned') {
        // Pure bookkeeping here — the pointer merely has to name the pin before the
        // user unlocks again, and a failed write must not fail a resolve that found
        // a usable binary. A real switch (below) retains the outgoing dir instead.
        await this._reconcilePinnedActive(version)
      } else {
        await this._activate(version, active)
      }
      this._logger.info(`${this._flavor.id} binary activated pinned ${version} from disk`)
      return pinnedBinary
    }

    if (this._devBinaryFallback) {
      const vendor = await this._devBinaryFallback()
      if (vendor) {
        this._logger.info(`dev reuse of vendored ${this._flavor.id} binary ${vendor}`)
        return vendor
      }
    }

    if (!allowDownload) {
      // A background/speculative caller (session hydrate) must never fetch, yet
      // under `'manual'` a stale-but-present pick still beats failing outright:
      // fall back to it and warn once, so the downgrade is visible instead of
      // silent. `'pinned'` has no such fallback — anything but the pin is a version
      // that mode may not run at all, so it fails fast rather than quietly running
      // below the lock.
      if (policy === 'manual' && active !== null) {
        const stale = this._binaryIn(this._versionDir(active), platform)
        if (await pathExists(stale)) {
          this._warnBelowFloorFallback(active, version)
          return stale
        }
      }
      throw new Error(
        `${this._displayName()} binary is not downloaded yet — background probes never trigger a download; ` +
          `start a ${this._displayName()} session or download it explicitly to fetch it.`,
      )
    }

    // The pin is not on disk: fetch exactly it. Never settle for the old binary
    // here — a failed download must surface, not quietly run below the floor.
    const binaryPath = await this._ensureVersion(version, false)
    await this._activate(version, active)
    return binaryPath
  }

  /**
   * Points `.active` at `next`, keeping the outgoing version's dir alive for the
   * rest of this process (a live session may still run it, and an offline revert
   * needs it on disk). `_activating` is deliberately not involved: the only
   * versions activated without an `_ensureVersion` of their own are the pin and
   * `forceDownload`'s target, and the pin is always in the cleanup keep-set.
   */
  private async _activate(next: string, previous: string | null): Promise<void> {
    if (previous === next) return
    if (previous !== null) this._retainedVersion = previous
    await this._setActiveVersion(next)
  }

  /**
   * Whether a version dir name is older than the pin — the runtime floor for the
   * download source, the download source's `.active` never being trusted below
   * it. An unparseable candidate counts as *below*: a corrupt pointer must not
   * buy a launch, and re-activating the pin is the only sensible repair. An
   * unparseable pin disables the floor instead — nothing can be compared to it.
   */
  private _isBelowLocked(candidate: string, locked: string): boolean {
    const lockedVersion = parseBinaryVersion(locked)
    if (lockedVersion === null) {
      this._warnFloorOnce(
        `pin:${locked}`,
        `${this._flavor.id} binary: pinned version "${locked}" is not a version, skipping the version floor`,
      )
      return false
    }
    const candidateVersion = parseBinaryVersion(candidate)
    if (candidateVersion === null) {
      this._warnFloorOnce(
        `active:${candidate}->${locked}`,
        `${this._flavor.id} binary: active version "${candidate}" is not a version, treating it as below ${locked}`,
      )
      return true
    }
    return compareBinaryVersions(candidateVersion, lockedVersion) < 0
  }

  private _warnBelowFloorFallback(found: string, required: string): void {
    this._warnFloorOnce(
      `fallback:${found}->${required}`,
      `${this._flavor.id} binary ${found} is below the pinned ${required} and downloading is not ` +
        `allowed on this path; running the older binary for now — start a foreground ` +
        `${this._displayName()} session to upgrade it.`,
    )
  }

  private _warnFloorOnce(key: string, message: string): void {
    if (this._warnedFloorMessages.has(key)) return
    this._warnedFloorMessages.add(key)
    this._logger.warn(message)
  }

  /**
   * Version metadata for the panels. Under `'pinned'` the *effective* version is
   * the pin — `.active` is not consulted at all, so a hand-picked version left on
   * disk reads as "not installed" (the panel must not claim the user is running a
   * binary that resolve would never hand out), and the registry's latest is left
   * unqueried because a pinned tree can never switch to it. Seeing the pin on disk
   * also reconciles `.active` to it — see `_reconcilePinnedActive`.
   */
  async getVersionInfo(policy: AgentBinaryVersionPolicy): Promise<AgentBinaryVersionInfo> {
    const bundledVersion = await this._flavor.bundledVersion()
    const platform = this._flavor.detectPlatform()

    // The effective version's dir name *is* its version; verify the binary still
    // exists before reporting it. Fall back to the pin's dir for trees written
    // before the `.active` pointer scheme.
    let installedVersion: string | null = null
    const candidate = policy === 'pinned' ? bundledVersion : await this._readActiveVersion()
    if (candidate && (await pathExists(this._binaryIn(this._versionDir(candidate), platform)))) {
      installedVersion = candidate
    } else if (
      candidate !== bundledVersion &&
      (await pathExists(this._binaryIn(this._versionDir(bundledVersion), platform)))
    ) {
      installedVersion = bundledVersion
    }

    if (policy === 'pinned' && installedVersion === bundledVersion) {
      await this._reconcilePinnedActive(bundledVersion)
    }

    const latestVersion = policy === 'pinned' ? null : await this._queryLatest()
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
   * Background-prefetches the most desirable version into its own version dir
   * without flipping `.active`, so a later `forceDownload` activates it without a
   * network fetch: the registry's latest under `'manual'`, the pin itself under
   * `'pinned'` (which never consults the registry — that mode can only ever run
   * the pin). Under `'pinned'` the pointer is reconciled to the pin as well: there
   * it names the only version the mode can run, not a user choice. Never throws —
   * a failed prefetch must not disrupt the caller.
   */
  async prefetch(policy: AgentBinaryVersionPolicy): Promise<void> {
    try {
      await this._prefetchImpl(policy)
    } catch (err) {
      this._logger.warn(`${this._flavor.id} binary prefetch failed: ${String(err)}`)
    }
  }

  private async _prefetchImpl(policy: AgentBinaryVersionPolicy): Promise<void> {
    const bundledVersion = await this._flavor.bundledVersion()
    const platform = this._flavor.detectPlatform()

    const latest = policy === 'pinned' ? null : await this._queryLatest()
    if (latest) await this._rememberLatest(latest)
    const target = latest ?? bundledVersion

    // Already the effective version? Nothing worth prefetching.
    const active =
      policy === 'pinned' ? bundledVersion : ((await this._readActiveVersion()) ?? bundledVersion)
    if (
      active === target &&
      (await pathExists(this._binaryIn(this._versionDir(active), platform)))
    ) {
      if (policy === 'pinned') await this._reconcilePinnedActive(bundledVersion)
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
    if (policy === 'pinned') await this._reconcilePinnedActive(target)
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
    // Stale dirs are swept at next startup via cleanupStaleVersions() — except the
    // outgoing version, which `_retainedVersion` protects for this whole process.
    const outgoing = await this._readActiveVersion()
    this._activating.add(version)
    try {
      const binaryPath = await this._ensureVersion(version, false)
      await this._activate(version, outgoing)
      return binaryPath
    } finally {
      this._activating.delete(version)
    }
  }

  /**
   * Aligns a managed-download tree with the current pin: after an editor upgrade
   * changed `bundledVersion()`, the `.active` pointer still names the previous pin
   * and the user would keep running the old binary forever. Runs at idle (never on
   * the resolve/spawn path) and only when the pin itself changed — a version the
   * user picked by hand under the same pin is preserved. Returns the version it
   * switched to, or null when there was nothing to do (also for every failure —
   * like `prefetch`, it never throws; the caller only uses the value to decide
   * whether to notify). Concurrent callers for one pin — two windows share a store
   * — report the switch only once.
   *
   * Only meaningful under the `'manual'` policy: a `'pinned'` resolve never reads
   * `.active` in the first place, so this pass exists there to pre-download a
   * newly pinned version at idle (the switch itself is already implied).
   */
  async syncBundled(): Promise<string | null> {
    try {
      return await this._syncBundledImpl(await this._flavor.bundledVersion())
    } catch (err) {
      this._logger.warn(`${this._flavor.id} binary sync failed: ${String(err)}`)
      return null
    }
  }

  private async _syncBundledImpl(bundled: string): Promise<string | null> {
    if ((await this._readAlignedPin()) === bundled) return null

    // Nothing of ours to align: no managed version was ever downloaded (the pin
    // only needs recording so a *later* pin change is detected), or the pin is
    // already the active one. Either way no download is warranted.
    const active = await this._readActiveVersion()
    if (active === null || active === bundled) {
      await this._rememberAlignedPin(bundled)
      return null
    }

    // Dev convenience, mirroring _prefetchImpl: fetching the pin would only
    // re-download bytes the vendored binary already provides, and the vendored
    // binary *is* the pin. The activation is skipped as well, deliberately: resolve
    // prefers `.active` over the vendored binary, so a contributor who once
    // downloaded a version keeps running it rather than being moved to the vendored
    // one behind their back.
    if (this._devBinaryFallback && (await this._devBinaryFallback())) {
      await this._rememberAlignedPin(bundled)
      return null
    }

    this._logger.info(
      `${this._flavor.id} binary pinned version changed ${active} -> ${bundled}, aligning`,
    )
    await this.forceDownload(bundled)
    // Two windows share this store, and the other one may have landed the very same
    // alignment while this call was downloading; only the first announces the
    // switch, so a second window must not report it again.
    if ((await this._readAlignedPin()) === bundled) return null
    // Written only on success: a failed alignment leaves the pointer untouched so
    // the next session retries instead of silently staying on the old binary.
    await this._rememberAlignedPin(bundled)
    this._logger.info(`${this._flavor.id} binary aligned to pinned ${bundled}`)
    return bundled
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
    // A version an earlier switch moved away from: a live session may still run it
    // and an offline revert needs its dir, so it survives this process even when a
    // second window sweeps after `.active` has already moved on.
    if (this._retainedVersion !== undefined) keep.add(this._retainedVersion)
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
