/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Auto-update service backed by electron-updater (VSCode-style). Distribution is
 *  a generic provider pointing at an internal static server (see
 *  electron-builder.yml). autoDownload is off — the renderer prompts before
 *  downloading and again before restarting.
 *
 *  This service owns the scheduling too (a single application-singleton, unlike the
 *  former per-window renderer contribution that would check once per window). It
 *  reads `update.mode` / `update.checkIntervalMinutes` straight from the active
 *  settings.json (there is no main-side IConfigurationService) and reschedules when
 *  the config directory changes.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
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
import { IEnvironmentMainService } from '../../environment/environmentMainService.js'
import { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import type { ConfigLocationMainService } from '../configLocation/configLocationMainService.js'
import type { IUpdateService, UpdateState } from '../../../shared/ipc/updateService.js'

const { autoUpdater } = electronUpdater

type UpdateMode = 'none' | 'manual' | 'start' | 'default'
const DEFAULT_MODE: UpdateMode = 'default'
const DEFAULT_INTERVAL_MINUTES = 1440
/** Delay before the first automatic check, so it doesn't compete with startup. */
const FIRST_CHECK_DELAY_MS = 30_000

/** Minimal view of EnvironmentMainService needed here; keeps the unit test light. */
export interface IUpdateEnvironment {
  readonly updateUrl: string | undefined
}

export class UpdateMainService implements IUpdateService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeState = new Emitter<UpdateState>()
  readonly onDidChangeState: Event<UpdateState> = this._onDidChangeState.event

  private readonly _currentVersion = app.getVersion()
  private _state: UpdateState = { type: 'idle', currentVersion: this._currentVersion }

  private readonly _logger: ILogger
  private readonly _timers = new Set<ReturnType<typeof setTimeout>>()
  private _configDirSub: IDisposable | undefined
  private _disposed = false
  /** Shutdown-veto gate run before installing (running-session guard). Wired by
   *  the app entry once WindowMainService exists; absent → install proceeds. */
  private _quitConfirmer: (() => Promise<boolean>) | undefined

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
  setQuitConfirmer(confirm: () => Promise<boolean>): void {
    this._quitConfirmer = confirm
  }

  async checkForUpdates(explicit: boolean): Promise<void> {
    if (this._state.type === 'disabled' && !explicit) return
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
    this._setState({
      type: 'downloading',
      currentVersion: this._currentVersion,
      version: this._state.version,
      percent: 0,
    })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this._setIdle({ error: (err as Error).message, explicit: true })
    }
  }

  async quitAndInstall(): Promise<void> {
    if (this._state.type !== 'downloaded') return
    // Run the same shutdown-veto chain a normal quit would (running-session
    // guard). electron-updater's quitAndInstall spawns the installer BEFORE it
    // calls app.quit(), so before-quit's veto can no longer stop it — the check
    // must happen here, or a cancelled prompt still installs the update.
    if (this._quitConfirmer) {
      const ok = await this._quitConfirmer()
      if (!ok) {
        this._logger.info('quitAndInstall vetoed (running sessions)')
        return
      }
    }
    // isSilent=true → the NSIS installer runs with /S: reinstalls into the same
    // INSTDIR without the directory-picker, and installer.nsh's IfSilent guards skip
    // the Defender-exclusion UAC prompt (the first-install exclusion is path-based
    // and still applies). isForceRunAfter=true relaunches the app after install.
    autoUpdater.quitAndInstall(true, true)
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

  // --- state ----------------------------------------------------------------

  private _wireEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      if (this._state.type !== 'checking') {
        this._setState({ type: 'checking', currentVersion: this._currentVersion, explicit: false })
      }
    })
    autoUpdater.on('update-available', (info) => {
      const explicit = this._state.type === 'checking' ? this._state.explicit : false
      this._setState({
        type: 'available',
        currentVersion: this._currentVersion,
        version: info.version,
        explicit,
      })
    })
    autoUpdater.on('update-not-available', () => {
      const explicit = this._state.type === 'checking' ? this._state.explicit : false
      this._setIdle({ notAvailable: true, explicit })
    })
    autoUpdater.on('download-progress', (progress) => {
      const version = this._state.type === 'downloading' ? this._state.version : ''
      this._setState({
        type: 'downloading',
        currentVersion: this._currentVersion,
        version,
        percent: Math.round(progress.percent),
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this._setState({
        type: 'downloaded',
        currentVersion: this._currentVersion,
        version: info.version,
      })
    })
    autoUpdater.on('error', (err) => {
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
