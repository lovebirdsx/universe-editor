/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Auto-update service backed by electron-updater. Distribution is a generic
 *  provider pointing at an internal static server (see electron-builder.yml).
 *  autoDownload is off — the renderer prompts the user before downloading and
 *  again before restarting to install (VSCode-style flow).
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
// electron-updater is CommonJS; default-import then destructure (electron-vite convention).
import electronUpdater from 'electron-updater'
import {
  createNamedLogger,
  Emitter,
  Event,
  isHttpUrl,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import { IEnvironmentMainService } from '../../environment/environmentMainService.js'
import type {
  IUpdateService,
  UpdateState,
  UpdateStatus,
} from '../../../shared/ipc/updateService.js'

const { autoUpdater } = electronUpdater

type StateExtra = Omit<Partial<UpdateState>, 'status' | 'currentVersion'>

/** Minimal view of EnvironmentMainService needed here; keeps the unit test light. */
export interface IUpdateEnvironment {
  readonly updateUrl: string | undefined
}

export class UpdateMainService implements IUpdateService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeState = new Emitter<UpdateState>()
  readonly onDidChangeState: Event<UpdateState> = this._onDidChangeState.event

  private readonly _currentVersion = app.getVersion()
  private _state: UpdateState = { status: 'idle', currentVersion: this._currentVersion }

  private readonly _logger: ILogger

  constructor(
    @IEnvironmentMainService environment: IUpdateEnvironment,
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
      const feedUrl = environment.updateUrl
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
  }

  async getState(): Promise<UpdateState> {
    return this._state
  }

  async checkForUpdates(): Promise<void> {
    if (this._state.status === 'checking' || this._state.status === 'downloading') return
    this._setState('checking')
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this._setState('error', { error: (err as Error).message })
    }
  }

  async downloadUpdate(): Promise<void> {
    if (this._state.status !== 'available') return
    this._setState('downloading', { percent: 0, ...versionOf(this._state) })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this._setState('error', { error: (err as Error).message })
    }
  }

  async quitAndInstall(): Promise<void> {
    if (this._state.status !== 'downloaded') return
    // isSilent=false (show NSIS progress), isForceRunAfter=true (relaunch app).
    autoUpdater.quitAndInstall(false, true)
  }

  dispose(): void {
    autoUpdater.removeAllListeners()
    this._onDidChangeState.dispose()
  }

  private _wireEvents(): void {
    autoUpdater.on('checking-for-update', () => this._setState('checking'))
    autoUpdater.on('update-available', (info) =>
      this._setState('available', { version: info.version }),
    )
    autoUpdater.on('update-not-available', () => this._setState('not-available'))
    autoUpdater.on('download-progress', (progress) =>
      this._setState('downloading', {
        percent: Math.round(progress.percent),
        ...versionOf(this._state),
      }),
    )
    autoUpdater.on('update-downloaded', (info) =>
      this._setState('downloaded', { version: info.version }),
    )
    autoUpdater.on('error', (err) => this._setState('error', { error: err.message }))
  }

  private _setState(status: UpdateStatus, extra: StateExtra = {}): void {
    this._state = { status, currentVersion: this._currentVersion, ...extra }
    this._onDidChangeState.fire(this._state)
  }
}

function versionOf(state: UpdateState): StateExtra {
  return state.version !== undefined ? { version: state.version } : {}
}
