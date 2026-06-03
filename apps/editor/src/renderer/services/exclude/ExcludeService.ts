/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExcludeService — single source of truth for VSCode-style file exclusions.
 *
 *  Resolves `files.exclude` / `search.exclude` / `files.watcherExclude` by
 *  merging every configuration layer (Default → User → .vscode → .universe-editor),
 *  compiles glob matchers once per change, and pushes the resolved watcher globs
 *  down to the main-process file watcher.
 *
 *  Consumer mapping (mirrors VSCode):
 *    - Explorer            → files.exclude              (kind: 'files')
 *    - Search / QuickOpen  → files.exclude ∪ search.exclude (kind: 'search')
 *    - File watcher (main) → files.watcherExclude       (pushed via setExcludes)
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  IConfigurationService,
  IFileWatcherService,
  ILoggerService,
  InstantiationType,
  createDecorator,
  createNamedLogger,
  makeExcludeMatcher,
  registerSingleton,
  type Event,
  type IConfigurationService as IConfigurationServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
} from '@universe-editor/platform'

export type ExcludeKind = 'files' | 'search'

const FILES_EXCLUDE = 'files.exclude'
const SEARCH_EXCLUDE = 'search.exclude'
const WATCHER_EXCLUDE = 'files.watcherExclude'

export interface IExcludeService {
  readonly _serviceBrand: undefined

  /**
   * Whether a workspace-relative, forward-slash path is excluded. `kind` selects
   * the rule set: 'files' uses files.exclude (Explorer); 'search' uses the union
   * of files.exclude and search.exclude (search / quick open / @-mention).
   */
  isExcluded(relPath: string, kind: ExcludeKind): boolean

  /**
   * Bare directory-name globs (no separator, no wildcard) drawn from the search
   * rule set, e.g. ['node_modules', 'dist']. Lets traversal-time callers short
   * out big directories cheaply before the full glob pass.
   */
  getDirNameIgnores(): string[]

  /** Currently-active `files.watcherExclude` globs, for seeding watch(). */
  readonly currentWatcherGlobs: readonly string[]

  /** Fires after any of the three exclude settings is recomputed. */
  readonly onDidChange: Event<void>
}

export const IExcludeService = createDecorator<IExcludeService>('excludeService')

export class ExcludeService extends Disposable implements IExcludeService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  private _filesMatcher: ((rel: string) => boolean) | null = null
  private _searchMatcher: ((rel: string) => boolean) | null = null
  private _watcherGlobs: string[] = []
  private _dirNameIgnores: string[] = []

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  constructor(
    @IConfigurationService private readonly _config: IConfigurationServiceType,
    @IFileWatcherService private readonly _watcher: IFileWatcherServiceType,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'exclude', name: 'Exclude' })
    this._recompute(false)
    this._register(
      this._config.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(FILES_EXCLUDE) ||
          e.affectsConfiguration(SEARCH_EXCLUDE) ||
          e.affectsConfiguration(WATCHER_EXCLUDE)
        ) {
          this._recompute(true)
        }
      }),
    )
  }

  isExcluded(relPath: string, kind: ExcludeKind): boolean {
    const matcher = kind === 'files' ? this._filesMatcher : this._searchMatcher
    return matcher ? matcher(relPath) : false
  }

  getDirNameIgnores(): string[] {
    return this._dirNameIgnores
  }

  get currentWatcherGlobs(): readonly string[] {
    return this._watcherGlobs
  }

  private _recompute(push: boolean): void {
    const files = this._config.getMerged<Record<string, unknown>>(FILES_EXCLUDE)
    const search = this._config.getMerged<Record<string, unknown>>(SEARCH_EXCLUDE)
    const watcher = this._config.getMerged<Record<string, unknown>>(WATCHER_EXCLUDE)

    this._filesMatcher = makeExcludeMatcher(files)
    // Search excludes are additive on top of files excludes (VSCode behaviour).
    this._searchMatcher = makeExcludeMatcher({ ...files, ...search })

    const nextWatcherGlobs = activeKeys(watcher)
    const watcherChanged = !sameStringSet(nextWatcherGlobs, this._watcherGlobs)
    this._watcherGlobs = nextWatcherGlobs
    this._dirNameIgnores = activeKeys({ ...files, ...search }).filter(isBareDirName)

    if (push && watcherChanged) {
      void this._watcher.setExcludes(this._watcherGlobs).catch((err) => {
        this._logger.warn('setExcludes failed', err instanceof Error ? err.message : String(err))
      })
    }
    this._onDidChange.fire()
  }
}

function activeKeys(globs: Record<string, unknown>): string[] {
  return Object.keys(globs).filter((k) => globs[k] === true)
}

/** A glob like `node_modules` — a single segment with no path separator or wildcard. */
function isBareDirName(glob: string): boolean {
  return !/[/\\*?{}]/.test(glob)
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((x) => set.has(x))
}

registerSingleton(IExcludeService, ExcludeService, InstantiationType.Eager)
