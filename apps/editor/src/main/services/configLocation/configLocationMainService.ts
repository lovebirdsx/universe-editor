/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process owner of the active config directory (where user settings.json /
 *  keybindings.json load from). Holds the authoritative runtime value, persists
 *  the pointer to <userData>/config-location.json, and broadcasts changes so each
 *  window's UserDataMainService can relocate its slots and hot-reload.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  Disposable,
  Emitter,
  type Event,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type {
  IConfigLocationInfo,
  IConfigLocationService,
} from '../../../shared/ipc/configLocationService.js'
import { IEnvironmentMainService } from '../../environment/environmentMainService.js'
import type { EnvironmentMainService } from '../../environment/environmentMainService.js'

const CONFIG_LOCATION_FILE = 'config-location.json'
const COPY_FILES = ['settings.json', 'keybindings.json'] as const

export class ConfigLocationMainService extends Disposable implements IConfigLocationService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeConfigDir = this._register(new Emitter<string>())
  readonly onDidChangeConfigDir: Event<string> = this._onDidChangeConfigDir.event

  private readonly _logger: ILogger
  private readonly _userDataDir: string
  private readonly _locked: boolean
  private readonly _initialOrigin: string
  private _currentDir: string

  constructor(
    @IEnvironmentMainService env: EnvironmentMainService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'configLocation',
      name: 'ConfigLocation',
    })
    this._userDataDir = env.userDataDir || app.getPath('userData')
    this._currentDir = env.configDir || this._userDataDir
    // cli/env overrides win over the persisted pointer and can't be changed by UI.
    const origin = env.configDirOrigin
    this._locked = origin === 'cli' || origin === 'env'
    this._initialOrigin = origin
  }

  async getInfo(): Promise<IConfigLocationInfo> {
    const isDefault = this._currentDir === this._userDataDir
    const origin = this._locked ? this._initialOrigin : isDefault ? 'default' : 'file'
    return { dir: this._currentDir, origin, locked: this._locked }
  }

  async setConfigDir(dir: string, copyCurrent: boolean): Promise<boolean> {
    if (this._locked) return false
    if (dir === this._currentDir) return true
    if (copyCurrent) await this._copyExisting(this._currentDir, dir)
    await this._writePointer({ configDir: dir })
    this._apply(dir)
    return true
  }

  async resetToDefault(): Promise<boolean> {
    if (this._locked) return false
    if (this._currentDir === this._userDataDir) return true
    await this._writePointer({})
    this._apply(this._userDataDir)
    return true
  }

  async isDirNonEmpty(dir: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dir)
      return entries.length > 0
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  /** Current directory, for synchronous wiring (e.g. UserDataMainService init). */
  get currentDir(): string {
    return this._currentDir
  }

  private _apply(dir: string): void {
    this._currentDir = dir
    this._logger.info(`config dir -> ${dir}`)
    this._onDidChangeConfigDir.fire(dir)
  }

  private async _writePointer(data: { configDir?: string }): Promise<void> {
    const path = join(this._userDataDir, CONFIG_LOCATION_FILE)
    if (!data.configDir) {
      await fs.rm(path, { force: true })
      return
    }
    const tmp = `${path}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, path)
  }

  private async _copyExisting(from: string, to: string): Promise<void> {
    await fs.mkdir(to, { recursive: true })
    for (const name of COPY_FILES) {
      const src = join(from, name)
      const dst = join(to, name)
      try {
        await fs.copyFile(src, dst, fs.constants.COPYFILE_EXCL)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // EEXIST: keep the destination's own file. ENOENT: nothing to copy.
        if (code !== 'EEXIST' && code !== 'ENOENT') {
          this._logger.warn(`copy ${name} failed: ${String(err)}`)
        }
      }
    }
  }
}
