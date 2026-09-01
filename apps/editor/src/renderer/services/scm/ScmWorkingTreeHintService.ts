/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmWorkingTreeHintService — pull-style "does this path have on-disk changes the
 *  provider hasn't published?" cache.
 *
 *  Perforce only knows about files you explicitly `p4 edit`, so a file modified on
 *  disk but never opened is invisible to the SCM decorations. Discovery
 *  (`p4 reconcile -n`) is a server round-trip too costly to run eagerly, so instead
 *  we resolve unknown paths on demand through the owning provider's
 *  `<providerId>.checkWorkingTree` command, mirroring ScmIgnoredResourcesService:
 *  consumers (Explorer rows) call `getHint` during render — cached answers return
 *  synchronously, unknown paths are enqueued and return undefined, and a version
 *  observable bumps when a batch resolves (or the cache is invalidated) so the next
 *  render picks up the answer.
 *
 *  Folders fold that same cache upward: `getFolderHint` tints a directory while any
 *  *discovered* descendant file still carries a hint. The aggregate is a lower bound
 *  by design — paths that were never rendered were never queried, and LRU eviction
 *  or a save can also take a colour away, so a folder's tint can change as the user
 *  expands and scrolls. Accepted trade-off: the alternative is eager discovery,
 *  i.e. exactly the whole-tree scan this service exists to avoid.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  createDecorator,
  Disposable,
  ICommandService,
  IFileWatcherService,
  ILoggerService,
  IWorkspaceService,
  NullLogger,
  observableValue,
  URI,
  type IFileChangeEvent,
  type ILogger,
  type IObservable,
} from '@universe-editor/platform'
import { dirtyDiffCommandId, type WorkingTreeChangeDto } from '@universe-editor/extensions-common'
import {
  IScmService,
  resolveScmProviderId,
  type IScmWorkingTreeScanResult,
} from '../extensions/ScmService.js'
import { currentRemoteAuthority } from '../remote/windowRemoteAuthority.js'
import { IScmDecorationsService, parentDir, scmPathKey } from './ScmDecorationsService.js'
import { scmHostPath } from './scmHostPath.js'

export interface IWorkingTreeHint {
  readonly color: string
  readonly letter: string
  readonly tooltip?: string
  readonly strikeThrough?: boolean
}

/** Folder-level hint: colour only — a directory shows no badge letter and no strike. */
export type IWorkingTreeFolderHint = Omit<IWorkingTreeHint, 'letter'>

export interface IScmWorkingTreeHintService {
  readonly _serviceBrand: undefined
  /** Bumps whenever a batch resolves or the cache is invalidated, so consumers re-render. */
  readonly version: IObservable<number>
  /** Cached hint; undefined while unknown (enqueued for a batch) or clean/off-host. */
  getHint(resource: URI): IWorkingTreeHint | undefined
  /**
   * Colour derived from the cached hints of known descendants, or undefined when
   * none has been discovered. A lower bound: it can gain entries as the user
   * expands/renders new paths and lose them to eviction or a save.
   */
  getFolderHint(resource: URI): IWorkingTreeFolderHint | undefined
}

export const IScmWorkingTreeHintService = createDecorator<IScmWorkingTreeHintService>(
  'scmWorkingTreeHintService',
)

/** Explorer is virtualised: fast scrolling touches thousands of paths, so bound the cache. */
export const CACHE_LIMIT = 4096

/** Folding file hints into a folder: a delete (strikeThrough) outranks any other drift. */
const FOLDER_HINT_WEIGHT_DELETE = 4
const FOLDER_HINT_WEIGHT_CHANGE = 2

/**
 * Coalescing window for scan-driven version bumps. A provider scan publishes one
 * batch per directory, and a thousand-directory workspace would otherwise
 * re-render the Explorer once per batch. Matches the pull channel's flush
 * debounce: a folder tint lagging one window behind the file cache is invisible,
 * a full re-render per batch is not.
 */
const SCAN_VERSION_BUMP_DELAY_MS = 150

export class ScmWorkingTreeHintService extends Disposable implements IScmWorkingTreeHintService {
  declare readonly _serviceBrand: undefined

  readonly version: IObservable<number>

  private readonly _version = observableValue<number>('scmWorkingTreeHintVersion', 0)
  /** null = known clean; it still occupies a slot and is still evicted. */
  private readonly _cache = new Map<string, IWorkingTreeHint | null>()
  /** Cached keys whose answer may have moved on; re-queried when next read. */
  private readonly _stale = new Set<string>()
  private readonly _pending = new Map<string, string>()
  /**
   * Keys whose query is on the wire right now, mapped to the token of the
   * *newest* query for that key. A key is removed either when its answer is
   * written or when something invalidates it mid-flight; an answer whose token
   * no longer matches is discarded — see {@link _writeHint}.
   *
   * The token is what makes this latest-wins. Two queries for one key overlap
   * whenever the provider's round-trip outlasts the debounce, and without a
   * per-request identity the second flush re-arms the marker the first answer
   * then consumes: the pre-save answer wins and pins the row clean forever.
   */
  private readonly _inFlight = new Map<string, number>()
  /** Monotonic; identifies one query for one key. */
  private _queryToken = 0
  private _flushTimer: ReturnType<typeof setTimeout> | undefined
  /** Bumped on every invalidation so an in-flight flush can drop stale results. */
  private _generation = 0
  /** Folder aggregates memoised against `_version`; rebuilt lazily when it moves. */
  private _folderHints: Map<string, IWorkingTreeFolderHint> | undefined
  private _folderHintsVersion = -1
  private readonly _logger: ILogger
  /** Timer of the coalesced scan version bump (see {@link _scheduleScanVersionBump}). */
  private _scanBumpTimer: ReturnType<typeof setTimeout> | undefined

  /** Debounce before a batch resolves; overridable in tests. */
  flushDelayMs = 150

  constructor(
    @IScmService private readonly _scm: IScmService,
    @ICommandService private readonly _commands: ICommandService,
    @IFileWatcherService watcher: IFileWatcherService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IScmDecorationsService private readonly _decorations: IScmDecorationsService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this.version = this._version
    this._logger =
      loggerService?.createLogger({
        id: 'scmWorkingTreeHint',
        name: 'SCM Working Tree Hint',
      }) ?? new NullLogger()

    this._register(watcher.onDidChangeFiles((events) => this._onFileEvents(events)))
    this._register(this._workspace.onDidChangeWorkspace(() => this._invalidate()))
    // The provider's background reconcile scan: directory-level answers that
    // arrive ahead of any file row being rendered, so folder tints can appear
    // before the user expands into a subtree. Merged into the same file-level
    // cache the pull channel feeds; empty scans write nothing (no hint = clean).
    this._register(
      this._scm.onDidPublishWorkingTreeScan((results) => this._acceptScanResults(results)),
    )

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

    // The decorations snapshot is recomputed on every provider refresh (a new
    // resourceStates push), which is exactly when a hint's answer can change with
    // no matching file-system event (e.g. a p4 collect moving a file into a
    // changelist group). Revalidate — not invalidate — so visible rows keep their
    // old hint instead of flickering for the ~150ms round-trip; a result that
    // matches the old value is not bumped.
    let firstDecorations = true
    this._register(
      autorun((reader) => {
        this._decorations.decorations.read(reader)
        if (firstDecorations) {
          firstDecorations = false
          return
        }
        this._revalidate()
      }),
    )
  }

  override dispose(): void {
    if (this._flushTimer !== undefined) clearTimeout(this._flushTimer)
    if (this._scanBumpTimer !== undefined) clearTimeout(this._scanBumpTimer)
    super.dispose()
  }

  getHint(resource: URI): IWorkingTreeHint | undefined {
    const fsPath = this._hostPath(resource)
    if (fsPath === undefined) return undefined
    const key = scmPathKey(fsPath)
    const cached = this._cache.get(key)
    if (cached !== undefined) {
      // Refresh LRU position: a visible row re-reads its hint every render.
      this._cache.delete(key)
      this._cache.set(key, cached)
      // Revalidation is lazy on purpose. Being read is what proves a row is on
      // screen, and the whole point of this channel is to cost what the user can
      // see; re-querying the whole cache the moment it goes stale would put
      // thousands of scrolled-past paths back on the wire on every provider
      // refresh — worse than the eager scan this exists to avoid.
      if (this._stale.delete(key)) this._enqueue(key, fsPath)
      return cached ?? undefined
    }
    this._enqueue(key, fsPath)
    return undefined
  }

  getFolderHint(resource: URI): IWorkingTreeFolderHint | undefined {
    const fsPath = this._hostPath(resource)
    if (fsPath === undefined) return undefined
    // Every content-changing path of `_cache` bumps `_version` (flush end, file
    // events, invalidation, and LRU eviction inside `_writeHint` before that
    // bump). `getHint`'s LRU touch only re-orders entries, which the deterministic
    // tie-break in `_buildFolderHints` makes irrelevant — so the version is a
    // sound memo generation for the folder fold.
    const version = this._version.get()
    if (this._folderHints === undefined || this._folderHintsVersion !== version) {
      this._folderHints = this._buildFolderHints()
      this._folderHintsVersion = version
    }
    return this._folderHints.get(scmPathKey(fsPath))
  }

  /**
   * Propagate every non-null file hint up its ancestor directories. No provider
   * root is known here, so propagation runs to the path top — harmless, since
   * only rendered rows ever look a folder up. A delete outranks any other drift;
   * ties break by the smaller source key so the colour is deterministic —
   * `_cache` iterates in LRU order, and a `getHint` hit re-orders entries without
   * bumping `_version`, so plain first-wins would let an unrelated rebuild flip
   * a folder between two equal-weight descendants. The folder keeps only the colour.
   */
  private _buildFolderHints(): Map<string, IWorkingTreeFolderHint> {
    const folders = new Map<string, IWorkingTreeFolderHint>()
    const winners = new Map<string, { weight: number; source: string }>()
    for (const [key, hint] of this._cache) {
      if (hint === null) continue
      const weight =
        hint.strikeThrough === true ? FOLDER_HINT_WEIGHT_DELETE : FOLDER_HINT_WEIGHT_CHANGE
      let dir = parentDir(key)
      while (dir) {
        const prev = winners.get(dir)
        if (
          prev === undefined ||
          weight > prev.weight ||
          (weight === prev.weight && key < prev.source)
        ) {
          winners.set(dir, { weight, source: key })
          folders.set(dir, { color: hint.color })
        }
        dir = parentDir(dir)
      }
    }
    return folders
  }

  /**
   * Queue a key for the next batch, unless a query for it is already on the wire
   * or already queued. Explorer re-reads every visible row on every render, so
   * without the in-flight guard one slow answer becomes a stream of duplicate
   * queries on the provider's shared concurrency gate.
   *
   * A key leaves `_inFlight` when its answer is written, when a newer query for
   * it supersedes the token, when a file event drops it, or when the cache is
   * invalidated. It does *not* leave on its own if the provider never answers —
   * that case is bounded by the provider's own command timeout (p4's
   * `SpawnWatchdog`, default 600s), which settles the promise as a failure and
   * lets `_writeHint` release the key. Deliberately no timeout here: a second
   * identical query cannot be faster than the first, so re-asking during that
   * window only adds load to the gate the first query is already stuck behind.
   */
  private _enqueue(key: string, fsPath: string): void {
    if (this._inFlight.has(key) || this._pending.has(key)) return
    this._pending.set(key, fsPath)
    this._scheduleFlush()
  }

  /** The path a resource has on the SCM host, or undefined when it is off-host. */
  private _hostPath(resource: URI): string | undefined {
    return scmHostPath(resource, currentRemoteAuthority(this._workspace.current))
  }

  private _onFileEvents(events: readonly IFileChangeEvent[]): void {
    let dropped = false
    for (const ev of events) {
      const fsPath = this._hostPath(ev.resource)
      if (fsPath === undefined) continue
      const key = scmPathKey(fsPath)
      this._stale.delete(key)
      // An answer already on the wire describes a version of the file that no
      // longer exists on disk. Drop it on arrival and ask again — otherwise the
      // round-trip lands *after* this event and installs the very hint the event
      // was supposed to correct, with nothing left to fix it until the next
      // provider refresh (which a quiet workspace may never see).
      if (this._inFlight.delete(key)) {
        this._pending.set(key, fsPath)
        this._scheduleFlush()
      }
      if (this._cache.delete(key)) dropped = true
    }
    // Saving a file is the main correction signal: drop only its own hint and
    // bump so the next render re-enqueues that one path for a fresh query.
    if (dropped) this._version.set(this._version.get() + 1, undefined)
  }

  private _scheduleFlush(): void {
    if (this._flushTimer !== undefined) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = undefined
      void this._flush()
    }, this.flushDelayMs)
  }

  private async _flush(): Promise<void> {
    const entries = [...this._pending.entries()]
    this._pending.clear()
    if (entries.length === 0) return
    const generation = this._generation
    // Stamp, never merely add: two flushes can overlap (the debounce can re-arm
    // while this one awaits), and the newer stamp is what lets the older flush's
    // answer be recognised as superseded instead of overwriting the newer one.
    const tokens = new Map<string, number>()
    for (const [key] of entries) {
      const token = ++this._queryToken
      tokens.set(key, token)
      this._inFlight.set(key, token)
    }
    let changed = false
    const write = (key: string, hint: IWorkingTreeHint | null): void => {
      changed = this._writeHint(key, hint, tokens.get(key)) || changed
    }

    const byProvider = new Map<string, string[]>()
    for (const [key, fsPath] of entries) {
      const providerId = resolveScmProviderId(this._scm.sourceControls.get(), fsPath)
      if (providerId === undefined) {
        write(key, null)
        continue
      }
      const list = byProvider.get(providerId)
      if (list) list.push(fsPath)
      else byProvider.set(providerId, [fsPath])
    }

    for (const [providerId, paths] of byProvider) {
      let dtos: readonly WorkingTreeChangeDto[] | undefined
      try {
        dtos = await this._commands.executeCommand<readonly WorkingTreeChangeDto[] | undefined>(
          dirtyDiffCommandId(providerId, 'checkWorkingTree'),
          paths,
        )
      } catch (err) {
        if (this._generation !== generation) return
        this._logger.warn(
          `check-working-tree via ${providerId} failed; treating batch as clean`,
          err,
        )
        for (const p of paths) write(scmPathKey(p), null)
        continue
      }
      // Invalidation fired while the command was in flight: the cache/pending were
      // cleared, so discard these now-stale answers — the next render re-enqueues.
      if (this._generation !== generation) return
      // undefined = command not registered (extension still activating / provider
      // without the capability) — treat the batch as clean so we don't re-query
      // every frame.
      if (dtos === undefined) {
        for (const p of paths) write(scmPathKey(p), null)
        continue
      }
      const hintsByKey = new Map<string, IWorkingTreeHint>()
      for (const dto of dtos) {
        hintsByKey.set(scmPathKey(dto.path), toHint(dto))
      }
      // Write every requested path (hit → hint, miss → clean) so a miss doesn't
      // stay "unknown" and re-enqueue on every render.
      for (const p of paths) {
        const key = scmPathKey(p)
        write(key, hintsByKey.get(key) ?? null)
      }
    }

    if (this._generation !== generation) return
    if (changed) {
      this._logger.debug(`resolved ${entries.length} working-tree hint query(s)`)
      this._version.set(this._version.get() + 1, undefined)
    }
  }

  /** Write a hint, returning whether the cached value actually changed. */
  private _writeHint(
    key: string,
    hint: IWorkingTreeHint | null,
    token: number | undefined,
  ): boolean {
    // A token mismatch means this answer has been superseded: either something
    // invalidated the key mid-flight (a file event, or a whole-cache
    // invalidation), or a newer query for the same key was already issued. Either
    // way it describes state that no longer holds, so drop it rather than cache
    // it — caching it would install an answer nothing is left to correct.
    if (this._inFlight.get(key) !== token) {
      this._logger.debug(`discarded stale hint answer for ${key}`)
      return false
    }
    this._inFlight.delete(key)
    this._stale.delete(key)
    return this._putHint(key, hint)
  }

  /**
   * Merge a provider background-scan batch into the cache. Scan answers are
   * file-level hints keyed like the pull channel's, so folder tints (and row
   * badges, if the row is already rendered) appear from the same data. The
   * scan's path strings come straight from the SCM host — the same host space
   * {@link _hostPath} maps resources into — so `scmPathKey` alone is the right
   * key. Nothing is written for a clean directory (an absent hint already means
   * "no drift", and there is no directory-level negative entry to cache).
   */
  private _acceptScanResults(results: readonly IScmWorkingTreeScanResult[]): void {
    let changed = false
    for (const result of results) {
      for (const dto of result.hints) {
        const hint = toHint(dto)
        // An answer from the pull channel may be in flight for the same file;
        // the scan describes what a directory sweep saw, which can be newer than
        // the point query it races. Both are honest readings of the disk at
        // their own moment, and the in-flight token guard still applies to the
        // pull answer when it lands.
        if (this._putHint(scmPathKey(dto.path), hint)) changed = true
      }
    }
    if (changed) {
      this._logger.debug(
        `accepted ${results.length} working-tree scan result(s) from ${results[0]?.sourceControlId ?? 'unknown provider'}`,
      )
      this._scheduleScanVersionBump()
    }
  }

  /**
   * Bump `_version` once per coalescing window, no matter how many scan batches
   * landed in it: a scan publishes one batch per directory, so an unbounded
   * bump-per-batch would re-render the Explorer once per directory. The cache
   * writes above are what matter — the next render picks them up regardless of
   * when the bump fires. `getFolderHint`'s memo keys on the version, so a bump
   * delayed into the window stays correct: it rebuilds the folder fold against
   * whatever the cache holds at bump time, never against a stale snapshot.
   */
  private _scheduleScanVersionBump(): void {
    if (this._scanBumpTimer !== undefined) return
    this._scanBumpTimer = setTimeout(() => {
      this._scanBumpTimer = undefined
      this._version.set(this._version.get() + 1, undefined)
    }, SCAN_VERSION_BUMP_DELAY_MS)
  }

  /** Store a hint under `key` (LRU-bound), returning whether it changed. */
  private _putHint(key: string, hint: IWorkingTreeHint | null): boolean {
    const prev = this._cache.get(key)
    if (hintsEqual(prev, hint)) return false
    this._cache.delete(key)
    this._cache.set(key, hint)
    if (this._cache.size > CACHE_LIMIT) {
      const oldest = this._cache.keys().next().value
      if (oldest !== undefined) {
        this._cache.delete(oldest)
        this._stale.delete(oldest)
      }
    }
    return true
  }

  /**
   * Mark every cached answer as possibly out of date without dropping it, so
   * visible rows keep their current hint instead of flickering for the round-trip.
   * The re-query happens in {@link getHint}, i.e. only for rows actually rendered.
   *
   * This leans on the autorun that calls it running *before* the Explorer's own
   * `decorations` subscription re-renders, which holds because the service is
   * constructed during bootstrap and so subscribes first. Registering it later
   * (a `Eventually`-phase contribution, say) would leave rows one render behind.
   */
  private _revalidate(): void {
    for (const key of this._cache.keys()) this._stale.add(key)
  }

  private _invalidate(): void {
    if (this._flushTimer !== undefined) {
      clearTimeout(this._flushTimer)
      this._flushTimer = undefined
    }
    this._generation++
    this._pending.clear()
    this._inFlight.clear()
    this._cache.clear()
    this._stale.clear()
    this._version.set(this._version.get() + 1, undefined)
  }
}

function toHint(dto: WorkingTreeChangeDto): IWorkingTreeHint {
  return {
    color: dto.color,
    letter: dto.letter,
    ...(dto.tooltip !== undefined ? { tooltip: dto.tooltip } : {}),
    ...(dto.strikeThrough !== undefined ? { strikeThrough: dto.strikeThrough } : {}),
  }
}

function hintsEqual(a: IWorkingTreeHint | null | undefined, b: IWorkingTreeHint | null): boolean {
  if (a === undefined) return false
  if (a === null || b === null) return a === b
  return (
    a.color === b.color &&
    a.letter === b.letter &&
    a.tooltip === b.tooltip &&
    a.strikeThrough === b.strikeThrough
  )
}
