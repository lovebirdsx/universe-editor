/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reads the built-in user guide documents (docs/user/<locale>/**\/*.md) from disk
 *  and exposes them to the renderer. The files ship beside app.asar via
 *  electron-builder extraResources (staged into .runtime-resources/docs by
 *  scripts/release/runtime-resources.mjs); dev/E2E read the in-repo source at the
 *  repo root. Keeping them as plain files (rather than inlining via Vite ?raw)
 *  lets external agents read the guides straight off disk. A missing directory
 *  degrades to an empty map rather than crashing startup.
 *--------------------------------------------------------------------------------------------*/

import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { createNamedLogger, type ILogger, ILoggerService } from '@universe-editor/platform'
import { SUPPORTED_LOCALES, type SupportedLocale } from '../../../shared/i18n/availableLocales.js'
import type { DocsByLocale, IDocsService } from '../../../shared/ipc/docsService.js'

/** Packaged location of the docs root, under `resourcesPath` (see electron-builder.yml). */
const DOCS_PACKAGED = 'docs/user'
/** Repo-relative docs root in the dev tree. */
const DOCS_DEV = 'docs/user'

export type DocsRootResolver = () => string

/**
 * Walk up from `app.getAppPath()` looking for a repo-relative path. Tolerates
 * both `electron .` (appPath = apps/editor) and the e2e `electron out/main/index.js`
 * layout (appPath points deeper), same approach as the extension host / tsserver.
 */
function resolveFromRepo(relative: string): string {
  let dir = app.getAppPath()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, relative)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(app.getAppPath(), '../..', relative)
}

const defaultResolveRoot: DocsRootResolver = () =>
  app.isPackaged ? path.join(process.resourcesPath, DOCS_PACKAGED) : resolveFromRepo(DOCS_DEV)

export class DocsMainService implements IDocsService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private _docs: DocsByLocale | undefined

  constructor(
    private readonly _resolveRoot: DocsRootResolver = defaultResolveRoot,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'docs', name: 'User Docs' })
  }

  async getDocs(): Promise<DocsByLocale> {
    if (this._docs) return this._docs
    const root = this._resolveRoot()
    const docs: DocsByLocale = {}
    for (const locale of SUPPORTED_LOCALES) {
      docs[locale] = this._readLocale(root, locale)
    }
    this._docs = docs
    return docs
  }

  private _readLocale(root: string, locale: SupportedLocale): Record<string, string> {
    const localeRoot = path.join(root, locale)
    const map: Record<string, string> = {}
    for (const abs of this._walk(localeRoot)) {
      const docId = path.relative(localeRoot, abs).split(path.sep).join('/').replace(/\.md$/, '')
      try {
        map[docId] = readFileSync(abs, 'utf8')
      } catch (err) {
        this._logger.warn(`failed to read ${abs}: ${(err as Error).message}`)
      }
    }
    return map
  }

  /** Recursively yield every `.md` file under `dir`. Absent dir → nothing. */
  private *_walk(dir: string): Generator<string> {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this._logger.warn(`failed to list ${dir}: ${(err as Error).message}`)
      }
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        yield* this._walk(abs)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        yield abs
      }
    }
  }
}
