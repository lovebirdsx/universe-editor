/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  P4IgnoreService — the editor-side fallback for Perforce ignore rules.
 *
 *  Why it exists: the session-diff's inferred ("watched") entries are filtered
 *  through the owning SCM provider's `checkIgnore` command, and that delegation
 *  is the authority whenever it answers — but it goes silent in three states a
 *  user cannot tell apart from "nothing is ignored":
 *
 *    - the perforce extension is not installed or not activated (the incident
 *      this service came out of: `activation event onStartupFinished →
 *      [git, numbered-bookmarks]`, so the workspace's own provider never ran);
 *    - it is registered but offline — `checkIgnore` returns `[]` behind a
 *      connection guard while `_goOffline` keeps the source control registered;
 *    - the command is not registered yet (returns `undefined`, and the host
 *      caches the whole batch as "not ignored" without invalidation).
 *
 *  A workspace full of compiled artifacts then floods the session diff, and
 *  every entry is a file the change tracker reads whole. So this service reads
 *  the rule files itself and answers independently of the extension host.
 *
 *  The search is Perforce's: start at the candidate's own directory and walk
 *  upward, nearest rule file last. That is what makes a workspace which is a
 *  SUBDIRECTORY of the client root pick up the root's rule file — the case this
 *  whole layer was asked for.
 *
 *  Scope and known gaps (documented in docs/user/zh-CN/perforce/sync-and-status.md):
 *    - Armed only where Perforce could plausibly apply: a path owned by a
 *      registered perforce source control, or — when no such source control
 *      exists at all, the incident's exact state — any path. A pure git
 *      checkout therefore never inherits a stray ancestor rule file, as long as
 *      some perforce provider answered for the workspace.
 *    - `P4IGNORE` is read from the process environment and from the config files
 *      on the chain, not from the registry / ~/.p4enviro that `p4 set` writes.
 *    - Files already in the depot are not excluded the way the perforce
 *      extension's fstat round does, so a controlled file matching a rule is
 *      dropped here. Only inferred entries are affected; agent-reported edits
 *      never consult this layer.
 *
 *  Freshness, deliberately without a watcher of its own: rule CONTENT is
 *  re-validated by `stat` on every use, so an edited rule file takes effect on
 *  the next flush; only a rule file APPEARING or DISAPPEARING can lag, by up to
 *  DIR_CACHE_TTL_MS. Rule files above the workspace are therefore not watched.
 *  Arming one would be worse than the staleness it fixes: the main-side watcher
 *  realizes an out-of-workspace file as a NON-RECURSIVE watch on its DIRECTORY
 *  and re-classifies every registered file on any sibling change, so a client
 *  root with a build writing into it reports the rule file as `modified` over
 *  and over. Those events land on the very stream this filter cleans
 *  (`SessionWatchedChangesContribution`), i.e. the net would catch its own
 *  catches — observed as a `.p4ignore` row in the session-changes list.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  basename,
  createDecorator,
  dirname,
  Disposable,
  fsPathToWorkspaceUri,
  IConfigurationService,
  IFileService,
  IFileWatcherService,
  InstantiationType,
  isAbsolutePath,
  joinPath,
  ILoggerService,
  IUriIdentityService,
  IWorkspaceService,
  NullLogger,
  registerSingleton,
  URI,
  type IFileChangeEvent,
  type ILogger,
} from '@universe-editor/platform'
import { IEnvironmentSnapshotService } from '../../../shared/ipc/environmentSnapshotService.js'
import { currentRemoteAuthority } from '../remote/windowRemoteAuthority.js'
import { IScmService, scmProviderPathKey } from '../extensions/ScmService.js'
import {
  evaluateP4Ignore,
  P4_CONFIG_FILE_NAMES,
  P4_IGNORE_FILE_NAMES,
  parseP4IgnoreFile,
  parseP4IgnoreSetting,
  splitP4IgnoreSpec,
  type P4IgnoreLevel,
  type P4IgnorePattern,
} from './p4Ignore.js'

/** Source control id the perforce extension registers (see workbench/swarm/SwarmReviewsView). */
const PERFORCE_PROVIDER_ID = 'perforce'

/** Setting bounding the upward walk; 'filesystem' (default) also searches above
 *  the workspace, 'workspace' never leaves it. */
export const P4_IGNORE_SEARCH_CEILING_SETTING = 'scm.ignoreFiles.searchCeiling'

/** Lifespan of a directory probe / config read. Only the presence of a rule
 *  file (or a config setting) can be this stale: parsed rule content is
 *  re-validated by `stat` on every use. */
const DIR_CACHE_TTL_MS = 30_000

export interface IP4IgnoreService {
  readonly _serviceBrand: undefined
  /**
   * The subset of `paths` (absolute host paths, the path space SCM providers
   * use — the same strings handed to `checkIgnore`) that the built-in Perforce
   * ignore rules drop. Synchronous callers get a promise that never rejects; an
   * unusable chain yields an empty set.
   */
  resolveIgnored(paths: readonly string[]): Promise<ReadonlySet<string>>
}

export const IP4IgnoreService = createDecorator<IP4IgnoreService>('p4IgnoreService')

interface ParsedRuleFile {
  readonly uri: URI
  readonly mtime: number
  readonly size: number
  readonly patterns: ReturnType<typeof parseP4IgnoreFile>
}

/** One rule file on a candidate's chain, with the rules it declares. */
interface ChainRule {
  /** The rule file's directory — the base its patterns are relative to. */
  readonly dir: string
  readonly uri: URI
  readonly patterns: readonly P4IgnorePattern[]
}

/**
 * The rule files governing a directory, shallow → deep (increasing precedence).
 *
 * Deliberately holds no candidate path: the chain is shared by every path in
 * the directory, and a level's relative path is a property of the CANDIDATE,
 * not of the rule file. Caching it here would silently answer the second path
 * in a flush with the first one's relative path.
 */
interface IgnoreChain {
  readonly rules: readonly ChainRule[]
}

interface P4Env {
  /** The filename `P4CONFIG` selects, if the environment sets one. */
  readonly configName: string | undefined
  /** The `P4IGNORE` value from the environment, if any. */
  readonly ignoreSpec: string | undefined
}

export class P4IgnoreService extends Disposable implements IP4IgnoreService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  /** `<dir key>\n<name>` → does that rule file exist in that directory. */
  private readonly _probes = new Map<string, { present: boolean; expiresAt: number }>()
  /** `<dir key>` → the p4 config file's text there (null = no config file). */
  private readonly _configs = new Map<string, { text: string | null; expiresAt: number }>()
  /** `<rule file key>` → patterns plus the stat they were parsed from. */
  private readonly _parsed = new Map<string, ParsedRuleFile>()
  /** Names whose change invalidates everything; widened by `P4CONFIG`. */
  private readonly _watchedNames = new Set<string>([
    ...P4_IGNORE_FILE_NAMES,
    ...P4_CONFIG_FILE_NAMES,
  ])
  /** Bumped on every invalidation so an in-flight resolve drops stale results
   *  instead of writing them back into the caches it just cleared. */
  private _generation = 0
  private _env: Promise<P4Env> | undefined

  constructor(
    @IFileService private readonly _files: IFileService,
    @IFileWatcherService watcher: IFileWatcherService,
    @IScmService private readonly _scm: IScmService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IEnvironmentSnapshotService envSnapshot: IEnvironmentSnapshotService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'p4Ignore', name: 'P4 Ignore' }) ?? new NullLogger()

    this._env = envSnapshot
      .getSnapshot()
      .then((snapshot) => {
        const configName = snapshot.env['P4CONFIG']?.trim()
        if (configName !== undefined && configName !== '')
          this._watchedNames.add(configName.toLowerCase())
        return {
          configName: configName === '' ? undefined : configName,
          ignoreSpec: snapshot.env['P4IGNORE'],
        }
      })
      .catch((err): P4Env => {
        this._logger.warn('failed to read the environment snapshot; P4CONFIG/P4IGNORE ignored', err)
        return { configName: undefined, ignoreSpec: undefined }
      })

    this._register(watcher.onDidChangeFiles((events) => this._onFileEvents(events)))
    this._register(this._workspace.onDidChangeWorkspace(() => this._invalidate()))
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(P4_IGNORE_SEARCH_CEILING_SETTING)) this._invalidate()
      }),
    )
    // A perforce workspace appearing or disappearing arms/disarms the whole
    // layer, so every cached answer is suspect. Skip the first run: it fires
    // with whatever is registered at subscribe time, before the restored state
    // settles (same guard as ScmIgnoredResourcesService).
    let first = true
    this._register(
      autorun((reader) => {
        this._scm.sourceControls.read(reader)
        if (first) {
          first = false
          return
        }
        this._invalidate()
      }),
    )
  }

  async resolveIgnored(paths: readonly string[]): Promise<ReadonlySet<string>> {
    const ignored = new Set<string>()
    if (paths.length === 0) return ignored
    try {
      const env = await (this._env ??
        Promise.resolve<P4Env>({ configName: undefined, ignoreSpec: undefined }))
      const generation = this._generation
      // One chain serves every path that shares a directory, and a flush is
      // normally one workspace's worth of paths.
      const chains = new Map<string, IgnoreChain | null>()
      for (const fsPath of paths) {
        if (this._generation !== generation) return ignored
        const chain = await this._chainFor(fsPath, env, chains)
        if (chain === null) continue
        if (chain.rules.length === 0) continue
        const levels = this._levelsFor(chain, fsPath)
        const verdict = evaluateP4Ignore(levels, false)
        if (!verdict.ignored) continue
        ignored.add(fsPath)
        // The deciding rule and its file, so a surprise matches what
        // `p4 ignores -i -v <path>` would report.
        const by = verdict.by
        this._logger.debug(
          by === null
            ? `dropping p4-ignored path ${fsPath}`
            : `dropping p4-ignored path ${fsPath} (rule "${by.source}" in ${by.dir})`,
        )
      }
    } catch (err) {
      // Fail open, like every other filter in the watched-change chain: losing
      // a real change is worse than tracking an ignored one, and the tracker's
      // own read caps bound the cost.
      this._logger.warn('p4ignore resolution failed; keeping the batch unfiltered', err)
    }
    return ignored
  }

  private _onFileEvents(events: readonly IFileChangeEvent[]): void {
    for (const ev of events) {
      if (ev.resource.scheme !== 'file') continue
      if (this._watchedNames.has(basename(ev.resource.fsPath).toLowerCase())) {
        this._invalidate()
        return
      }
    }
  }

  private async _chainFor(
    fsPath: string,
    env: P4Env,
    cache: Map<string, IgnoreChain | null>,
  ): Promise<IgnoreChain | null> {
    const ceiling = this._ceilingFor(fsPath)
    if (ceiling === undefined) return null
    const key = `${ceiling ?? ''}\n${this._uriIdentity.getPathComparisonKey(dirname(fsPath))}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const chain = await this._buildChain(fsPath, ceiling, env)
    cache.set(key, chain)
    return chain
  }

  /**
   * The directory the walk must not go above, `null` for the filesystem root,
   * or `undefined` when Perforce cannot plausibly apply to this path at all.
   */
  private _ceilingFor(fsPath: string): string | null | undefined {
    const perforce = this._scm.sourceControls
      .get()
      .filter((sc) => sc.id === PERFORCE_PROVIDER_ID && sc.rootUri !== undefined)
    let natural: string | null
    if (perforce.length === 0) {
      // No Perforce anywhere: the incident's state, where the filter must still
      // work. Documented as the wider approximation of "search upward".
      natural = null
    } else {
      // Some Perforce answered for this window, so a path outside every client
      // root is a different repo (or none) and must not inherit p4 rules.
      const target = scmProviderPathKey(fsPath)
      let owner: string | undefined
      let ownerLength = -1
      for (const sc of perforce) {
        const root = scmProviderPathKey(sc.rootUri!)
        if (target !== root && !target.startsWith(`${root}/`)) continue
        if (root.length > ownerLength) {
          owner = sc.rootUri
          ownerLength = root.length
        }
      }
      if (owner === undefined) return undefined
      natural = owner
    }
    if (this._searchCeiling !== 'workspace') return natural
    const workspaceRoot = this._workspace.current?.folder
    if (workspaceRoot === undefined || workspaceRoot.scheme !== 'file') return natural
    const folder = workspaceRoot.fsPath
    // Clamp only when the workspace root actually bounds the path; a file
    // outside the workspace keeps its natural ceiling rather than losing the
    // chain entirely.
    if (this._uriIdentity.relativePathUnder(folder, fsPath) === null) return natural
    if (natural === null) return folder
    // Two ancestors of the same path are always comparable, so this picks the
    // deeper one — the setting may only narrow the search, never widen it.
    return this._uriIdentity.relativePathUnder(folder, natural) === null ? folder : natural
  }

  private get _searchCeiling(): string {
    return this._configuration.get<string>(P4_IGNORE_SEARCH_CEILING_SETTING) ?? 'filesystem'
  }

  private async _buildChain(
    fsPath: string,
    ceiling: string | null,
    env: P4Env,
  ): Promise<IgnoreChain | null> {
    const dirs = this._dirsUpTo(fsPath, ceiling)
    if (dirs.length === 0) return null
    const generation = this._generation

    // P4CONFIG first: it can widen the set of rule-file names, and the name set
    // has to be known before any directory is probed.
    const names = new Set<string>(P4_IGNORE_FILE_NAMES)
    const fixedPaths: string[] = []
    const addSpec = (spec: string, baseDir: string): void => {
      const { names: extraNames, paths } = splitP4IgnoreSpec(spec)
      for (const name of extraNames) names.add(name)
      for (const p of paths) {
        fixedPaths.push(isAbsolutePath(p, this._uriIdentity.platform) ? p : joinPath(baseDir, p))
      }
    }
    if (env.ignoreSpec !== undefined) addSpec(env.ignoreSpec, dirs[0]!)
    for (const dir of dirs) {
      const text = await this._configTextIn(dir, env, generation)
      if (this._generation !== generation) return null
      if (text === null) continue
      const spec = parseP4IgnoreSetting(text)
      if (spec !== null) addSpec(spec, dir)
    }

    // Nearest rule file last: deeper rules override shallower ones.
    const uriDirs: { uri: URI; relDir: string }[] = []
    for (const dir of dirs.reverse()) {
      for (const name of names) {
        const uri = await this._ruleFileIn(dir, name, generation)
        if (this._generation !== generation) return null
        if (uri !== null) uriDirs.push({ uri, relDir: dir })
      }
    }
    for (const p of fixedPaths) {
      const uri = this._uriFor(p)
      if (await this._isFile(uri)) uriDirs.push({ uri, relDir: dirname(p) })
    }

    const rules: ChainRule[] = []
    for (const { uri, relDir } of uriDirs) {
      const patterns = await this._patternsFor(uri, generation)
      if (this._generation !== generation) return null
      if (patterns === null) continue
      rules.push({ dir: relDir, uri, patterns })
    }
    return { rules }
  }

  /** Pair each chain rule with this candidate's path relative to it. */
  private _levelsFor(chain: IgnoreChain, fsPath: string): P4IgnoreLevel[] {
    const levels: P4IgnoreLevel[] = []
    for (const rule of chain.rules) {
      const relPath = this._uriIdentity.relativePathUnder(rule.dir, fsPath)
      // Every rule here was found by walking up from this path, so it is under
      // each of them; a null would mean a cross-root mismatch and is dropped
      // rather than guessed at.
      if (relPath === null) continue
      levels.push({ dir: rule.dir, relPath, patterns: rule.patterns })
    }
    return levels
  }

  /**
   * Directories from the candidate's own up to `ceiling` inclusive, nearest
   * first. `dirname` does not converge at every root — POSIX gives
   * `dirname('/') === '/'` and a Windows drive root collapses to `.` — so the
   * walk stops on no progress rather than trusting either shape.
   */
  private _dirsUpTo(fsPath: string, ceiling: string | null): string[] {
    const dirs: string[] = []
    const ceilingKey = ceiling === null ? null : this._uriIdentity.getPathComparisonKey(ceiling)
    let dir = dirname(fsPath)
    for (;;) {
      dirs.push(dir)
      const dirKey = this._uriIdentity.getPathComparisonKey(dir)
      if (ceilingKey !== null && dirKey === ceilingKey) break
      const parent = dirname(dir)
      if (parent === dir || parent === '.' || parent === '') break
      // Defensive: a ceiling that isn't an ancestor would otherwise let the
      // walk escape the client root it was armed for.
      if (ceilingKey !== null && !dirKey.startsWith(`${ceilingKey}/`)) break
      dir = parent
    }
    return dirs
  }

  private async _ruleFileIn(dir: string, name: string, generation: number): Promise<URI | null> {
    const key = `${this._uriIdentity.getPathComparisonKey(dir)}\n${name.toLowerCase()}`
    const cached = this._probes.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.present ? this._uriFor(joinPath(dir, name)) : null
    }
    const uri = this._uriFor(joinPath(dir, name))
    const present = await this._isFile(uri)
    if (this._generation !== generation) return null
    this._probes.set(key, { present, expiresAt: Date.now() + DIR_CACHE_TTL_MS })
    return present ? uri : null
  }

  private async _isFile(uri: URI): Promise<boolean> {
    try {
      return (await this._files.stat(uri)).isFile
    } catch {
      return false
    }
  }

  private async _configTextIn(dir: string, env: P4Env, generation: number): Promise<string | null> {
    const key = this._uriIdentity.getPathComparisonKey(dir)
    const cached = this._configs.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.text
    // P4CONFIG replaces the default names when set — that is `p4`'s own rule.
    const names = env.configName !== undefined ? [env.configName] : P4_CONFIG_FILE_NAMES
    let text: string | null = null
    for (const name of names) {
      const uri = this._uriFor(joinPath(dir, name))
      // Stat first: most directories have no config file, and a throwing read
      // per directory would be both slow and noisy as control flow.
      if (!(await this._isFile(uri))) continue
      if (this._generation !== generation) return null
      try {
        text = await this._files.readFileText(uri)
      } catch (err) {
        this._logger.debug(`failed to read p4 config file ${uri.toString()}`, err)
      }
      break
    }
    // Same guard as the probe and pattern caches: an invalidate that landed while the
    // read was in flight must not be undone by this write-back.
    if (this._generation !== generation) return null
    this._configs.set(key, { text, expiresAt: Date.now() + DIR_CACHE_TTL_MS })
    return text
  }

  /** Parsed patterns for a rule file, re-read whenever its stat moved. */
  private async _patternsFor(
    uri: URI,
    generation: number,
  ): Promise<ReturnType<typeof parseP4IgnoreFile> | null> {
    const key = this._uriIdentity.getComparisonKey(uri)
    let mtime: number
    let size: number
    try {
      const stat = await this._files.stat(uri)
      if (!stat.isFile) return null
      mtime = stat.mtime
      size = stat.size
    } catch {
      return null
    }
    const cached = this._parsed.get(key)
    if (cached !== undefined && cached.mtime === mtime && cached.size === size) {
      return cached.patterns
    }
    let content: string
    try {
      content = await this._files.readFileText(uri)
    } catch (err) {
      this._logger.debug(`failed to read p4 ignore file ${uri.toString()}`, err)
      return null
    }
    if (this._generation !== generation) return null
    const patterns = parseP4IgnoreFile(content)
    this._parsed.set(key, { uri, mtime, size, patterns })
    this._logger.debug(`loaded ${patterns.length} rule(s) from ${uri.toString()}`)
    return patterns
  }

  /** Host path → the URI `IFileService` addresses it by, remote authority included. */
  private _uriFor(hostPath: string): URI {
    return fsPathToWorkspaceUri(hostPath, currentRemoteAuthority(this._workspace.current))
  }

  private _invalidate(): void {
    this._generation++
    this._probes.clear()
    this._configs.clear()
    this._parsed.clear()
  }
}

registerSingleton(IP4IgnoreService, P4IgnoreService, InstantiationType.Delayed)
