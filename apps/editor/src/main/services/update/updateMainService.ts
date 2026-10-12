/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Auto-update service backed by electron-updater (VSCode-style). Distribution is
 *  a generic provider pointing at an internal static server (see
 *  electron-builder.yml). autoDownload is off — the renderer prompts before
 *  downloading and again before restarting. The one exception is a release flagged
 *  `urgency: important` in the feed's notes/index.json: those are fetched in the
 *  background so a fix users are blocked on does not sit behind an unclicked prompt.
 *
 *  This service owns the scheduling too (a single application-singleton, unlike the
 *  former per-window renderer contribution that would check once per window). It
 *  reads `update.mode` / `update.checkIntervalMinutes` straight from the active
 *  settings.json (there is no main-side IConfigurationService) and reschedules when
 *  the config directory changes.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { getAppVersion } from '../../appVersion.js'
// electron-updater is CommonJS; default-import then destructure (electron-vite convention).
import electronUpdater from 'electron-updater'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import {
  createNamedLogger,
  Emitter,
  Event,
  isHttpUrl,
  type IDisposable,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import { compareVersions } from '@universe-editor/extensions-common'
import { IEnvironmentMainService } from '../../environment/environmentMainService.js'
import { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import type { ConfigLocationMainService } from '../configLocation/configLocationMainService.js'
import type {
  IUpdateService,
  UpdateState,
  UpdateUrgency,
} from '../../../shared/ipc/updateService.js'
import { beginShutdownTrace, recordShutdownMark } from './updateShutdownTrace.js'
import {
  feedUrlFromUpdateConfig,
  fetchUrgencyFromSiteIndex,
  siteIndexUrl,
  updaterConfigPath,
} from './updateUrgency.js'

const { autoUpdater } = electronUpdater

type UpdateMode = 'none' | 'manual' | 'start' | 'default'
const DEFAULT_MODE: UpdateMode = 'default'
const DEFAULT_INTERVAL_MINUTES = 1440
/** Delay before the first automatic check, so it doesn't compete with startup. */
const FIRST_CHECK_DELAY_MS = 30_000

/** Urgency as carried by a state, if that state carries one at all. */
function urgencyOf(state: UpdateState): UpdateUrgency | undefined {
  switch (state.type) {
    case 'available':
    case 'downloading':
    case 'downloaded':
      return state.urgency
    default:
      return undefined
  }
}

/** Minimal view of EnvironmentMainService needed here; keeps the unit test light. */
export interface IUpdateEnvironment {
  readonly updateUrl: string | undefined
}

export class UpdateMainService implements IUpdateService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeState = new Emitter<UpdateState>()
  readonly onDidChangeState: Event<UpdateState> = this._onDidChangeState.event

  private readonly _currentVersion = getAppVersion()
  private _state: UpdateState = { type: 'idle', currentVersion: this._currentVersion }

  private readonly _logger: ILogger
  private readonly _timers = new Set<ReturnType<typeof setTimeout>>()
  private _configDirSub: IDisposable | undefined
  private _disposed = false
  private _rechecking = false
  /** Feed base URL for the urgency lookup — resolved once, then cached. */
  private _feedBaseUrlResolved = false
  private _feedBaseUrl: string | undefined
  /** Only successfully read answers are memoized; a failed fetch retries next check. */
  private readonly _urgencyByVersion = new Map<string, UpdateUrgency>()
  /** Versions whose silent download already ran this session (never loop on retry). */
  private readonly _autoDownloadAttempted = new Set<string>()
  /** The version an unattended download is currently fetching, if any. */
  private _autoDownloadVersion: string | undefined
  /** Shutdown-veto gate run before installing (running-session guard). Wired by
   *  the app entry once WindowMainService exists; absent → install proceeds. */
  private _quitConfirmer: ((requestingWindowId?: number) => Promise<boolean>) | undefined

  constructor(
    @IEnvironmentMainService private readonly _environment: IUpdateEnvironment,
    @IConfigLocationService private readonly _configLocation: ConfigLocationMainService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'update', name: 'Update' })
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    // Allow exercising the flow against a local feed (dev-app-update.yml) when
    // running an unpackaged build during development.
    if (!app.isPackaged) {
      autoUpdater.forceDevUpdateConfig = true
    } else {
      // Packaged builds can retarget the feed at runtime (CLI / env / userData
      // config file) without repackaging. Dev/E2E keep dev-app-update.yml.
      const feedUrl = this._environment.updateUrl
      if (feedUrl && isHttpUrl(feedUrl)) {
        autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
        this._logger.info(`update feed override: ${feedUrl}`)
      }
    }
    autoUpdater.logger = {
      info: (m) => this._logger.info(String(m)),
      warn: (m) => this._logger.warn(String(m)),
      error: (m) => this._logger.error(m instanceof Error ? (m.stack ?? m.message) : String(m)),
      debug: (m) => this._logger.debug(String(m)),
    }
    this._wireEvents()
    void this._schedule()
    this._configDirSub = this._configLocation.onDidChangeConfigDir(() => void this._schedule())
  }

  async getState(): Promise<UpdateState> {
    return this._state
  }

  /**
   * Register the shutdown-veto gate (running-session guard). quitAndInstall runs
   * it before spawning the installer so "cancel" actually aborts the update.
   */
  setQuitConfirmer(confirm: (requestingWindowId?: number) => Promise<boolean>): void {
    this._quitConfirmer = confirm
  }

  async checkForUpdates(explicit: boolean): Promise<void> {
    if (this._state.type === 'disabled' && !explicit) return
    if (this._rechecking) return
    if (this._state.type === 'checking' || this._state.type === 'downloading') return
    this._setState({ type: 'checking', currentVersion: this._currentVersion, explicit })
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this._setIdle({ error: (err as Error).message, explicit })
    }
  }

  async downloadUpdate(): Promise<void> {
    if (this._state.type !== 'available') return
    const knownVersion = this._state.version
    const urgency = this._state.urgency
    const latest = await this._recheckLatest()
    const targetVersion = latest ?? knownVersion
    if (latest && compareVersions(latest, knownVersion) > 0) {
      this._logger.info(`download: ${knownVersion} is stale, re-downloading ${latest}`)
    }
    return this._download(targetVersion, { urgency })
  }

  async quitAndInstall(requestingWindowId?: number): Promise<void> {
    if (this._state.type !== 'downloaded') return
    // Stamp the click moment before the recheck round-trip so the shutdown trace
    // keeps measuring click → relaunch, not click + recheck latency.
    beginShutdownTrace()
    const downloadedVersion = this._state.version
    const urgency = this._state.urgency
    const latest = await this._recheckLatest()
    if (latest && compareVersions(latest, downloadedVersion) > 0) {
      // The downloaded build is stale — re-download the newest one instead. The
      // ensuing update-downloaded event re-prompts "Version {latest} is ready to
      // install".
      this._logger.info(`install: ${downloadedVersion} is stale, re-downloading ${latest}`)
      await this._download(latest, { urgency })
      return
    }
    return this._doInstall(requestingWindowId)
  }

  /**
   * Re-confirm the latest version on the server without mutating the state
   * machine. Returns the latest version, or null when there is no update or the
   * check failed (the caller then falls back to the already-known version).
   */
  private async _recheckLatest(): Promise<string | null> {
    this._rechecking = true
    try {
      const result = await autoUpdater.checkForUpdates()
      return result && result.isUpdateAvailable ? result.updateInfo.version : null
    } catch (err) {
      this._logger.warn(`recheck for latest version failed: ${String(err)}`)
      return null
    } finally {
      this._rechecking = false
    }
  }

  /**
   * `auto` marks a download nobody asked for (an important update fetched in the
   * background). It only changes failure handling: an unattended download must not
   * throw an error prompt at the user, but must still leave them a way to get the fix.
   */
  private async _download(
    version: string,
    opts: { auto?: boolean; urgency?: UpdateUrgency | undefined } = {},
  ): Promise<void> {
    const { auto = false, urgency } = opts
    this._autoDownloadVersion = auto ? version : undefined
    this._setState({
      type: 'downloading',
      currentVersion: this._currentVersion,
      version,
      percent: 0,
      ...(urgency !== undefined ? { urgency } : {}),
    })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      // electron-updater both dispatches 'error' and rejects, so this may already
      // have been settled by the event handler; `_settleDownloadFailure` is idempotent.
      this._settleDownloadFailure((err as Error).message)
    }
  }

  /**
   * Settle a failed download. A user-initiated one reports the error; an auto-download
   * falls back to the `available` prompt instead — nobody asked for it, so an error
   * toast is noise, but going quiet would hide the fix entirely.
   */
  private _settleDownloadFailure(message: string): void {
    const prev = this._state
    if (prev.type !== 'downloading') return
    const auto =
      this._autoDownloadVersion !== undefined && prev.version === this._autoDownloadVersion
    if (!auto) {
      this._setIdle({ error: message, explicit: true })
      return
    }
    this._logger.warn(`auto-download of ${prev.version} failed: ${message}`)
    this._setState({
      type: 'available',
      currentVersion: this._currentVersion,
      version: prev.version,
      explicit: false,
      ...(prev.urgency !== undefined ? { urgency: prev.urgency } : {}),
    })
  }

  private async _doInstall(requestingWindowId?: number): Promise<void> {
    // Run the same shutdown-veto chain a normal quit would (running-session
    // guard). electron-updater's quitAndInstall spawns the installer BEFORE it
    // calls app.quit(), so before-quit's veto can no longer stop it — the check
    // must happen here, or a cancelled prompt still installs the update.
    if (this._quitConfirmer) {
      const ok = await this._quitConfirmer(requestingWindowId)
      if (!ok) {
        this._logger.info('quitAndInstall vetoed (running sessions)')
        return
      }
    }
    recordShutdownMark('confirmed')
    // isSilent=false → the assisted installer runs visibly so users see a progress
    // page during the multi-second install instead of a silent blackout. All
    // interactive pages are still skipped: --updated skips license/directory
    // (skipPageIfUpdated), installer.nsh's customInstallMode skips the install-mode
    // page, customFinishPage auto-relaunches and closes, and the Defender prompt is
    // guarded by isUpdated. isForceRunAfter=true covers the silent fallback paths.
    autoUpdater.quitAndInstall(false, true)
    recordShutdownMark('afterQuitAndInstall')
  }

  dispose(): void {
    this._disposed = true
    this._clearTimers()
    this._configDirSub?.dispose()
    this._configDirSub = undefined
    autoUpdater.removeAllListeners()
    this._onDidChangeState.dispose()
  }

  // --- scheduling -----------------------------------------------------------

  private async _schedule(): Promise<void> {
    this._clearTimers()
    const { mode, intervalMinutes } = await this._readConfig()
    this._logger.info(`update mode=${mode} interval=${intervalMinutes}min`)

    if (mode === 'none') {
      this._setState({ type: 'disabled', currentVersion: this._currentVersion, reason: 'none' })
      return
    }
    if (mode === 'manual') {
      this._setState({ type: 'disabled', currentVersion: this._currentVersion, reason: 'manual' })
      return
    }
    // start / default: leave the state idle so manual + automatic checks both work.
    if (this._state.type === 'disabled') {
      this._setState({ type: 'idle', currentVersion: this._currentVersion })
    }
    this._defer(() => void this.checkForUpdates(false), FIRST_CHECK_DELAY_MS)
    if (mode === 'default' && intervalMinutes > 0) {
      const handle = setInterval(() => void this.checkForUpdates(false), intervalMinutes * 60_000)
      this._timers.add(handle)
    }
  }

  private async _readConfig(): Promise<{ mode: UpdateMode; intervalMinutes: number }> {
    let raw: Record<string, unknown> | undefined
    try {
      const text = await fs.readFile(join(this._configLocation.currentDir, 'settings.json'), 'utf8')
      if (text.trim() !== '') raw = parse(text) as Record<string, unknown> | undefined
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this._logger.warn(`read settings.json failed: ${String(err)}`)
      }
    }
    const modeValue = raw?.['update.mode']
    const mode: UpdateMode =
      modeValue === 'none' ||
      modeValue === 'manual' ||
      modeValue === 'start' ||
      modeValue === 'default'
        ? modeValue
        : DEFAULT_MODE
    const intervalValue = raw?.['update.checkIntervalMinutes']
    const intervalMinutes =
      typeof intervalValue === 'number' && intervalValue >= 0
        ? intervalValue
        : DEFAULT_INTERVAL_MINUTES
    return { mode, intervalMinutes }
  }

  private _defer(fn: () => void, ms: number): void {
    const handle = setTimeout(() => {
      this._timers.delete(handle)
      fn()
    }, ms)
    this._timers.add(handle)
  }

  private _clearTimers(): void {
    for (const handle of this._timers) {
      clearTimeout(handle)
      clearInterval(handle)
    }
    this._timers.clear()
  }

  // --- important updates ------------------------------------------------------

  /**
   * Publish `available` only once the urgency is known: announcing first and upgrading
   * the state afterwards would flash a normal prompt and then replace it. Waiting costs
   * one local file read plus, at most, a 2s fetch — and only when there IS an update.
   */
  private async _onUpdateAvailable(version: string): Promise<void> {
    if (this._rechecking) return
    const explicit = this._state.type === 'checking' ? this._state.explicit : false
    const urgency = await this._resolveUrgency(version)
    if (this._disposed) return
    // The await opens a window: a re-check may already have moved us on, or the user
    // may have started the download. Never regress a state that is already ahead.
    const current = this._state
    if (
      (current.type === 'downloading' || current.type === 'downloaded') &&
      current.version === version
    ) {
      return
    }
    const auto = urgency === 'important' && !this._autoDownloadAttempted.has(version)
    const autoDownload = auto && (await this._shouldAutoDownload())
    if (this._disposed) return
    this._setState({
      type: 'available',
      currentVersion: this._currentVersion,
      version,
      explicit,
      urgency,
      ...(autoDownload ? { autoDownload: true } : {}),
    })
    if (autoDownload) void this._autoDownload(version)
  }

  /**
   * `none` / `manual` mean the user drives updates. Downloading behind their back would
   * also silently install on the next normal quit (autoInstallOnAppQuit), which is
   * precisely what those modes opt out of — so they keep the loud prompt instead.
   */
  private async _shouldAutoDownload(): Promise<boolean> {
    const { mode } = await this._readConfig()
    return mode === 'start' || mode === 'default'
  }

  private async _autoDownload(version: string): Promise<void> {
    const current = this._state
    if (current.type !== 'available' || current.version !== version) return
    // Register before awaiting so a concurrent check cannot start a second download.
    this._autoDownloadAttempted.add(version)
    this._logger.info(`important update ${version}: downloading without waiting for a click`)
    await this._download(version, { auto: true, urgency: 'important' })
  }

  private async _resolveUrgency(version: string): Promise<UpdateUrgency> {
    const cached = this._urgencyByVersion.get(version)
    if (cached !== undefined) return cached
    const baseUrl = await this._feedBaseUrlForNotes()
    const url = baseUrl === undefined ? undefined : siteIndexUrl(baseUrl)
    if (url === undefined) {
      this._logger.debug(`urgency: no usable feed url, treating ${version} as normal`)
      return 'normal'
    }
    const urgency = await fetchUrgencyFromSiteIndex({ url, version })
    if (urgency === undefined) {
      this._logger.debug(`urgency: ${url} did not answer for ${version}, treating it as normal`)
    } else {
      // Only a readable index is worth remembering; a failed fetch gets another chance
      // on the next check rather than being pinned to `normal` for the session.
      this._urgencyByVersion.set(version, urgency)
    }
    return urgency ?? 'normal'
  }

  /**
   * The feed the updater is actually pointed at. A runtime override only takes effect on
   * packaged builds (dev / E2E always read dev-app-update.yml), so mirror that here —
   * resolving a different URL than the one being checked would mislabel a version.
   */
  private async _feedBaseUrlForNotes(): Promise<string | undefined> {
    if (this._feedBaseUrlResolved) return this._feedBaseUrl
    const override = this._environment.updateUrl
    if (app.isPackaged && override !== undefined && isHttpUrl(override)) {
      this._feedBaseUrl = override
      this._feedBaseUrlResolved = true
      return this._feedBaseUrl
    }
    try {
      const text = await fs.readFile(
        updaterConfigPath({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
        }),
        'utf8',
      )
      // A readable config is final even when it carries no `url:` line; an unreadable
      // one is not cached, so a transient failure recovers on the next check.
      this._feedBaseUrl = feedUrlFromUpdateConfig(text)
      this._feedBaseUrlResolved = true
    } catch (err) {
      this._feedBaseUrl = undefined
      this._logger.debug(`urgency: no feed config to read (${String(err)})`)
    }
    return this._feedBaseUrl
  }

  // --- state ----------------------------------------------------------------

  private _wireEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      if (this._rechecking) return
      if (this._state.type !== 'checking') {
        this._setState({ type: 'checking', currentVersion: this._currentVersion, explicit: false })
      }
    })
    autoUpdater.on('update-available', (info) => void this._onUpdateAvailable(info.version))
    autoUpdater.on('update-not-available', () => {
      if (this._rechecking) return
      const explicit = this._state.type === 'checking' ? this._state.explicit : false
      this._setIdle({ notAvailable: true, explicit })
    })
    autoUpdater.on('download-progress', (progress) => {
      if (this._rechecking) return
      const prev = this._state
      const version = prev.type === 'downloading' ? prev.version : ''
      const urgency = urgencyOf(prev)
      this._setState({
        type: 'downloading',
        currentVersion: this._currentVersion,
        version,
        percent: Math.round(progress.percent),
        ...(urgency !== undefined ? { urgency } : {}),
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      if (this._rechecking) return
      const prev = this._state
      const urgency =
        prev.type === 'downloading' && prev.version === info.version ? prev.urgency : undefined
      this._autoDownloadVersion = undefined
      this._setState({
        type: 'downloaded',
        currentVersion: this._currentVersion,
        version: info.version,
        ...(urgency !== undefined ? { urgency } : {}),
      })
    })
    autoUpdater.on('error', (err) => {
      if (this._rechecking) return
      // A failure while downloading belongs to that download, not to a check.
      if (this._state.type === 'downloading') {
        this._settleDownloadFailure(err.message)
        return
      }
      const explicit = this._state.type === 'checking' ? this._state.explicit : true
      this._setIdle({ error: err.message, explicit })
    })
  }

  private _setIdle(extra: { error?: string; notAvailable?: boolean; explicit?: boolean }): void {
    this._setState({ type: 'idle', currentVersion: this._currentVersion, ...extra })
  }

  private _setState(state: UpdateState): void {
    if (this._disposed) return
    this._state = state
    this._onDidChangeState.fire(state)
    // Clear the one-shot idle flags right after broadcasting so a window opened
    // later never reads a stale error / "no update" prompt (VSCode behaviour).
    if (state.type === 'idle' && (state.error !== undefined || state.notAvailable)) {
      this._state = { type: 'idle', currentVersion: this._currentVersion }
    }
  }
}

/** Bind the application update singleton to the BrowserWindow serving one IPC channel. */
export function createWindowScopedUpdateService(
  update: UpdateMainService,
  windowId: number,
): IUpdateService {
  return {
    _serviceBrand: undefined,
    onDidChangeState: update.onDidChangeState,
    getState: () => update.getState(),
    checkForUpdates: (explicit) => update.checkForUpdates(explicit),
    downloadUpdate: () => update.downloadUpdate(),
    quitAndInstall: () => update.quitAndInstall(windowId),
  }
}
