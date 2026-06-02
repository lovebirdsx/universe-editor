/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reads the release-notes.json bundled with the app and exposes it to the
 *  renderer. The file is generated at build time from git history and shipped via
 *  electron-builder extraResources; dev/E2E read the in-repo source. A missing or
 *  malformed file degrades to an empty list rather than crashing startup.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { createNamedLogger, type ILogger, ILoggerService } from '@universe-editor/platform'
import type {
  IReleaseNote,
  IReleaseNotesData,
  IReleaseNotesService,
} from '../../../shared/ipc/releaseNotesService.js'

/** Packaged location, under `resourcesPath` (see electron-builder.yml). */
const RELEASE_NOTES_PACKAGED = 'release-notes.json'
/** Dev/E2E location, relative to `app.getAppPath()` (== `apps/editor`). */
const RELEASE_NOTES_DEV = 'resources/release-notes.json'

export type ReleaseNotesPathResolver = () => string

const defaultResolvePath: ReleaseNotesPathResolver = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, RELEASE_NOTES_PACKAGED)
    : path.resolve(app.getAppPath(), RELEASE_NOTES_DEV)

export class ReleaseNotesMainService implements IReleaseNotesService {
  declare readonly _serviceBrand: undefined

  private readonly _currentVersion = app.getVersion()
  private readonly _logger: ILogger
  private _notes: readonly IReleaseNote[] | undefined

  constructor(
    private readonly _resolvePath: ReleaseNotesPathResolver = defaultResolvePath,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'releaseNotes', name: 'Release Notes' })
  }

  async getReleaseNotes(): Promise<IReleaseNotesData> {
    return { currentVersion: this._currentVersion, notes: this._load() }
  }

  private _load(): readonly IReleaseNote[] {
    if (this._notes) return this._notes
    const file = this._resolvePath()
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      this._notes = Array.isArray(parsed) ? (parsed as IReleaseNote[]) : []
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this._logger.warn(`failed to read ${file}: ${(err as Error).message}`)
      }
      this._notes = []
    }
    return this._notes
  }
}
