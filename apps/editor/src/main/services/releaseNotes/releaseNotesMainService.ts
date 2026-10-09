/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Reads the release-notes.json bundled with the app and exposes it to the renderer. The
 *  file is a compiled artifact (docs/release-notes/*.md → scripts/release/release-notes/),
 *  shipped via electron-builder extraResources; dev/E2E read the in-repo source.
 *
 *  Validation is per field, not all-or-nothing: one malformed entry is dropped with a
 *  bounded diagnostic instead of blanking the whole tab, a malformed file degrades to an
 *  empty list, and a missing file is the expected "dev without resources" case (silent).
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { getAppVersion } from '../../appVersion.js'
import { createNamedLogger, type ILogger, ILoggerService } from '@universe-editor/platform'
import { resolveFromRepo } from '../../repoPaths.js'
import type {
  IReleaseNote,
  IReleaseNotesData,
  IReleaseNotesService,
} from '../../../shared/ipc/releaseNotesService.js'

/** Packaged location, under `resourcesPath` (see electron-builder.yml). */
const RELEASE_NOTES_PACKAGED = 'release-notes.json'
/** Dev/E2E location, repo-relative (see resolveFromRepo). */
const RELEASE_NOTES_DEV = 'resources/release-notes.json'

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** A corrupt file must not flood the log; the first few problems are the diagnosis. */
const MAX_DIAGNOSTICS = 5

export type ReleaseNotesPathResolver = () => string

const defaultResolvePath: ReleaseNotesPathResolver = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, RELEASE_NOTES_PACKAGED)
    : resolveFromRepo(RELEASE_NOTES_DEV)

/**
 * Shape-validate the compiled JSON. Returns the notes that can be trusted plus one
 * human-readable line per problem (bounded by the caller when logging).
 */
export function parseReleaseNotes(value: unknown): {
  readonly notes: readonly IReleaseNote[]
  readonly problems: readonly string[]
} {
  if (!Array.isArray(value)) return { notes: [], problems: ['顶层不是数组'] }
  const notes: IReleaseNote[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  value.forEach((raw, index) => {
    const where = `第 ${index + 1} 条`
    if (raw === null || typeof raw !== 'object') {
      problems.push(`${where}不是对象`)
      return
    }
    const entry = raw as Record<string, unknown>
    const version = entry.version
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
      problems.push(`${where}的 version 非法：${String(version)}`)
      return
    }
    if (seen.has(version)) {
      problems.push(`${where}的 version ${version} 重复`)
      return
    }
    const text: Record<string, string> = {}
    for (const key of ['title', 'summary', 'body'] as const) {
      const field = entry[key]
      if (typeof field !== 'string') {
        problems.push(`${where}（${version}）的 ${key} 不是字符串`)
        return
      }
      text[key] = field
    }
    let date: string | undefined
    if (entry.date !== undefined) {
      if (typeof entry.date === 'string' && DATE_PATTERN.test(entry.date)) date = entry.date
      else problems.push(`${where}（${version}）的 date 非法（已忽略）：${String(entry.date)}`)
    }
    seen.add(version)
    notes.push({
      version,
      ...(date !== undefined ? { date } : {}),
      title: text['title'] ?? '',
      summary: text['summary'] ?? '',
      body: text['body'] ?? '',
    })
  })
  return { notes, problems }
}

export class ReleaseNotesMainService implements IReleaseNotesService {
  declare readonly _serviceBrand: undefined

  private readonly _currentVersion = getAppVersion()
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
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const { notes, problems } = parseReleaseNotes(parsed)
      if (problems.length > 0) {
        const shown = problems.slice(0, MAX_DIAGNOSTICS).join('；')
        const rest =
          problems.length > MAX_DIAGNOSTICS
            ? `（其余 ${problems.length - MAX_DIAGNOSTICS} 处略）`
            : ''
        this._logger.warn(`${file}: ${shown}${rest}`)
      }
      this._notes = notes
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
