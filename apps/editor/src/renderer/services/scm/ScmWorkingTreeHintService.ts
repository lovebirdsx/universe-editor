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
 *  The owning provider is resolved among the ones that actually registered
 *  `checkWorkingTree` (capability-by-registration, like the dirty-diff Stage
 *  probe): a git repo nested inside a Perforce workspace never registered it, so
 *  without the filter the nested repo's longer prefix would steal the query and
 *  pin the path clean. The SCM view's selected repo still wins the arbitration
 *  regardless of capability — routing to a repo the user explicitly picked is the
 *  intent, and the other providers' slots are hidden while it is selected.
 *
 *  Folder tints fold the pull channel's file cache upward — a directory's
 *  colour is a lower bound on the drift already discovered under it: paths that
 *  were never rendered were never queried, and a save can still take a colour
 *  away, so a folder's tint can change as the user expands and scrolls.
 *  Accepted trade-off: the alternative is eager discovery, i.e. exactly the
 *  whole-tree scan this service exists to avoid. The authoritative folder
 *  colour is now ScmDecorationsService (the provider's resourceStates
 *  whole-set replacement, which is retractable); this fold only fills in
 *  during the first scan before those land.
 *
 *  The cache is slotted per provider id (the DirtyDiff/Blame precedent):
 *  switching the SCM view's selected repo only hides the other providers' slots
 *  and bumps the version — the data is kept, so switching back restores the
 *  hints instantly without re-issuing a round of queries at the provider's
 *  shared concurrency gate. A workspace switch or a source-controls change
 *  still clears every slot — those stale the data itself, not just its
 *  visibility.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  CommandsRegistry,
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
  resolveScmProviderIdWhere,
  resolveSelectedSourceControl,
  type IScmSourceControlModel,
} from '../extensions/ScmService.js'
import { currentRemoteAuthority } from '../remote/windowRemoteAuthority.js'
import { IScmDecorationsService, parentDir, scmPathKey } from './ScmDecorationsService.js'
import { scmHostPath } from './scmHostPath.js'
// services → workbench reverse import: scmViewState is module-level observable
// state with no view dependency, so a service may read it (precedent:
// ScmIgnoredResourcesService).
import { scmViewState } from '../../workbench/scm/scmViewState.js'

export interface IWorkingTreeHint {
  readonly color: string
  readonly letter: string
  readonly tooltip?: string
  readonly strikeThrough?: boolean
}

/** Folder-level hint: colour only — a directory shows no badge letter and no strike. */
export type IWorkingTreeFolderHint = Omit<IWorkingTreeHint, 'letter'>

/** A directory's winning fold: the winning weight, colour, and the file that tinted it. */
interface FolderFold {
  weight: number
  color: string
  source: string
}

export interface IScmWorkingTreeHintService {
  readonly _serviceBrand: undefined
  /** Bumps whenever a batch resolves or the cache is invalidated, so consumers re-render. */
  readonly version: IObservable<number>
  /** Cached hint; undefined while unknown (enqueued for a batch) or clean/off-host. */
  getHint(resource: URI): IWorkingTreeHint | undefined
  /**
   * Colour derived from known descendants of the pull channel's file cache, or
   * undefined when none has been discovered. A lower bound: it can gain entries
   * as the user expands/renders new paths, and lose them to a save or a
   * workspace change. The authoritative folder colour is ScmDecorationsService;
   * this fold only fills in during the first scan before those land.
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

export class ScmWorkingTreeHintService extends Disposable implements IScmWorkingTreeHintService {
  declare readonly _serviceBrand: undefined

  readonly version: IObservable<number>

  private readonly _version = observableValue<number>('scmWorkingTreeHintVersion', 0)
  /**
   * Pull-channel answers, slotted by the provider id that produced them
   * (DirtyDiff/Blame precedent). null = known clean; it still occupies a slot
   * and is still evicted. A repo switch keeps the slots — reads filter by the
   * selected provider — so switching back restores hints instantly without
   * re-issuing a round of queries at the provider's shared concurrency gate.
   * The per-slot LRU is bounded by {@link CACHE_LIMIT}.
   */
  private readonly _cache = new Map<string, Map<string, IWorkingTreeHint | null>>()
  /** Cached keys whose answer may have moved on; re-queried when next read. Slotted like `_cache`. */
  private readonly _stale = new Map<string, Set<string>>()
  private readonly _pending = new Map<string, string>()
  /**
   * Keys whose query is on the wire right now, slotted by the provider the
   * query was routed to, mapped to the token of the *newest* query for that
   * key. A key is removed either when its answer is written or when something
   * invalidates it mid-flight; an answer whose token no longer matches is
   * discarded — see {@link _writeHint}. A repo switch does not clear it: an
   * answer already on the wire still describes the provider that produced it
   * and lands in that provider's slot, where the read-side filter keeps it
   * invisible until the user switches back.
   *
   * The token is what makes this latest-wins. Two queries for one key overlap
   * whenever the provider's round-trip outlasts the debounce, and without a
   * per-request identity the second flush re-arms the marker the first answer
   * then consumes: the pre-save answer wins and pins the row clean forever.
   */
  private readonly _inFlight = new Map<string, Map<string, number>>()
  /** Monotonic; identifies one query for one key. */
  private _queryToken = 0
  private _flushTimer: ReturnType<typeof setTimeout> | undefined
  /** Bumped on every invalidation so an in-flight flush can drop stale results. */
  private _generation = 0
  /** Folder aggregates memoised against `_version`; rebuilt lazily when it moves. */
  private _folderHints: Map<string, IWorkingTreeFolderHint> | undefined
  private _folderHintsVersion = -1
  private readonly _logger: ILogger

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

    // Re-arbitrate on both inputs, but with different strength. Switching the
    // SCM view's repo only changes *which* provider's hints are visible — the
    // slots are kept (see the cache docs) and reads filter by the selection, so
    // a switch merely bumps the version to re-render and rebuild the folder
    // fold. A sourceControls change replaces the providers themselves, so every
    // slot is then suspect and the cache is fully invalidated. sourceControls
    // must stay observed: at startup the restored selectedRepo can point at a
    // provider whose source control isn't registered yet (extensions activate
    // one by one), so arbitration falls back to the longest-prefix owner until
    // it registers — re-arbitrate then.
    let prevControls: readonly IScmSourceControlModel[] | undefined
    let prevSelected: string | undefined
    let first = true
    this._register(
      autorun((reader) => {
        const controls = this._scm.sourceControls.read(reader)
        const selected = scmViewState.selectedRepo.read(reader)
        if (first) {
          first = false
        } else if (controls !== prevControls) {
          this._invalidate()
        } else if (selected !== prevSelected) {
          this._version.set(this._version.get() + 1, undefined)
        }
        prevControls = controls
        prevSelected = selected
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
    super.dispose()
  }

  getHint(resource: URI): IWorkingTreeHint | undefined {
    const fsPath = this._hostPath(resource)
    if (fsPath === undefined) return undefined
    const providerId = this._ownerProviderId(fsPath)
    const visible = this._visibleProviderId()
    if (providerId === undefined || (visible !== undefined && providerId !== visible)) {
      return undefined
    }
    const key = scmPathKey(fsPath)
    const slot = this._cache.get(providerId)
    if (slot !== undefined) {
      const cached = slot.get(key)
      if (cached !== undefined) {
        // Refresh LRU position: a visible row re-reads its hint every render.
        slot.delete(key)
        slot.set(key, cached)
        // Revalidation is lazy on purpose. Being read is what proves a row is on
        // screen, and the whole point of this channel is to cost what the user can
        // see; re-querying the whole cache the moment it goes stale would put
        // thousands of scrolled-past paths back on the wire on every provider
        // refresh — worse than the eager scan this exists to avoid.
        if (this._stale.get(providerId)?.delete(key)) this._enqueue(providerId, key, fsPath)
        return cached ?? undefined
      }
    }
    this._enqueue(providerId, key, fsPath)
    return undefined
  }

  getFolderHint(resource: URI): IWorkingTreeFolderHint | undefined {
    const fsPath = this._hostPath(resource)
    if (fsPath === undefined) return undefined
    const providerId = this._ownerProviderId(fsPath)
    const visible = this._visibleProviderId()
    if (providerId === undefined || (visible !== undefined && providerId !== visible)) {
      return undefined
    }
    // Every content-changing path bumps `_version`: the pull cache (flush end,
    // file events, invalidation, and LRU eviction inside `_writeHint`), and repo
    // switches (the arbitration autorun). `getHint`'s LRU touch only re-orders
    // entries, which the deterministic tie-break makes irrelevant — so the
    // version is a sound memo generation for the fold.
    const version = this._version.get()
    if (this._folderHints === undefined || this._folderHintsVersion !== version) {
      const fold = this._buildFolderHints(visible)
      const hints = new Map<string, IWorkingTreeFolderHint>()
      for (const [key, entry] of fold) hints.set(key, { color: entry.color })
      this._folderHints = hints
      this._folderHintsVersion = version
    }
    return this._folderHints.get(scmPathKey(fsPath))
  }

  /**
   * Propagate every non-null file hint up its ancestor directories. No provider
   * root is known here, so propagation runs to the path top — harmless, since
   * only rendered rows ever look a folder up. The fold decision (delete outranks
   * any other drift; equal weight breaks to the smaller source key) comes from
   * {@link _folderWeight}/{@link _folderFoldBeats}.
   *
   * `providerId` scopes the fold to one slot; undefined merges every slot —
   * used when no repo is selected, so every provider's hints stay visible.
   */
  private _buildFolderHints(providerId: string | undefined): Map<string, FolderFold> {
    const folders = new Map<string, FolderFold>()
    const slots =
      providerId !== undefined ? [this._cache.get(providerId)] : [...this._cache.values()]
    for (const slot of slots) {
      if (slot === undefined) continue
      for (const [key, hint] of slot) {
        if (hint === null) continue
        const weight = this._folderWeight(hint)
        let dir = parentDir(key)
        while (dir) {
          if (this._folderFoldBeats(folders.get(dir), weight, key)) {
            folders.set(dir, { weight, color: hint.color, source: key })
          }
          dir = parentDir(dir)
        }
      }
    }
    return folders
  }

  /**
   * The provider a read should show: the SCM view's selected source control
   * (same arbitration as the decorations), or undefined when no repo is
   * selected — then every provider's own slot shows, matching the historical
   * unselected behaviour. Same-root double providers cannot be told apart by
   * the selection; both resolve to the first registered one. Deliberately not
   * capability-filtered: explicitly selecting a repo hides the other providers'
   * slots even when the selected repo cannot answer the pull channel.
   */
  private _visibleProviderId(): string | undefined {
    const selected = scmViewState.selectedRepo.get()
    if (selected === undefined) return undefined
    return resolveSelectedSourceControl(this._scm.sourceControls.get(), selected)?.id
  }

  /**
   * Which provider currently owns `fsPath`, with the same arbitration as
   * `_flush`: among the owners that registered `checkWorkingTree`, the selected
   * repo wins, else the longest-prefix capable owner. An incapable owner (a git
   * repo nested inside a Perforce workspace) never steals the query, so its
   * paths surface the outer provider's drift.
   */
  private _ownerProviderId(fsPath: string): string | undefined {
    return resolveScmProviderIdWhere(
      this._scm.sourceControls.get(),
      fsPath,
      scmViewState.selectedRepo.get(),
      hasWorkingTreeCapability,
    )
  }

  /** Fold weight: a delete (strikeThrough) outranks any other drift. */
  private _folderWeight(hint: IWorkingTreeHint): number {
    return hint.strikeThrough === true ? FOLDER_HINT_WEIGHT_DELETE : FOLDER_HINT_WEIGHT_CHANGE
  }

  /** Fold decision: higher weight wins; equal weight breaks to the smaller source key. */
  private _folderFoldBeats(prev: FolderFold | undefined, weight: number, source: string): boolean {
    return (
      prev === undefined || weight > prev.weight || (weight === prev.weight && source < prev.source)
    )
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
  private _enqueue(providerId: string, key: string, fsPath: string): void {
    if (this._inFlight.get(providerId)?.has(key) || this._pending.has(key)) return
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
      let reenqueue = false
      // Drop the key from *every* provider slot: a save invalidates the file's
      // answer regardless of which provider produced it, and whichever slot a
      // switch-back would read must not hand out a pre-save hint.
      for (const sc of this._scm.sourceControls.get()) {
        // An answer already on the wire describes a version of the file that no
        // longer exists on disk. Drop it on arrival and ask again — otherwise the
        // round-trip lands *after* this event and installs the very hint the event
        // was supposed to correct, with nothing left to fix it until the next
        // provider refresh (which a quiet workspace may never see).
        if (this._inFlight.get(sc.id)?.delete(key)) reenqueue = true
        this._stale.get(sc.id)?.delete(key)
        if (this._cache.get(sc.id)?.delete(key)) dropped = true
      }
      if (reenqueue) {
        this._pending.set(key, fsPath)
        this._scheduleFlush()
      }
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
    // Routing and stamping share one pass because the in-flight marker must land
    // in the slot of the provider the query is routed to — the answer writes
    // back into that slot no matter how the selection moves while it is out.
    const tokens = new Map<string, number>()
    const byProvider = new Map<string, string[]>()
    for (const [key, fsPath] of entries) {
      const providerId = resolveScmProviderIdWhere(
        this._scm.sourceControls.get(),
        fsPath,
        scmViewState.selectedRepo.get(),
        hasWorkingTreeCapability,
      )
      if (providerId === undefined) continue
      const token = ++this._queryToken
      tokens.set(key, token)
      this._slot(this._inFlight, providerId).set(key, token)
      const list = byProvider.get(providerId)
      if (list) list.push(fsPath)
      else byProvider.set(providerId, [fsPath])
    }
    let changed = false
    const write = (providerId: string, key: string, hint: IWorkingTreeHint | null): void => {
      changed = this._writeHint(providerId, key, hint, tokens.get(key)) || changed
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
        for (const p of paths) write(providerId, scmPathKey(p), null)
        continue
      }
      // Invalidation fired while the command was in flight: the cache/pending were
      // cleared, so discard these now-stale answers — the next render re-enqueues.
      if (this._generation !== generation) return
      // undefined = command not registered (extension still activating / provider
      // without the capability) — treat the batch as clean so we don't re-query
      // every frame.
      if (dtos === undefined) {
        for (const p of paths) write(providerId, scmPathKey(p), null)
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
        write(providerId, key, hintsByKey.get(key) ?? null)
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
    providerId: string,
    key: string,
    hint: IWorkingTreeHint | null,
    token: number | undefined,
  ): boolean {
    // A token mismatch means this answer has been superseded: either something
    // invalidated the key mid-flight (a file event, or a whole-cache
    // invalidation), or a newer query for the same key was already issued. Either
    // way it describes state that no longer holds, so drop it rather than cache
    // it — caching it would install an answer nothing is left to correct.
    if (this._inFlight.get(providerId)?.get(key) !== token) {
      this._logger.debug(`discarded stale hint answer for ${key}`)
      return false
    }
    this._inFlight.get(providerId)?.delete(key)
    this._stale.get(providerId)?.delete(key)
    return this._putHint(providerId, key, hint)
  }

  /** Store a hint in the provider's slot (LRU-bound), returning whether it changed. */
  private _putHint(providerId: string, key: string, hint: IWorkingTreeHint | null): boolean {
    const slot = this._slot(this._cache, providerId)
    const prev = slot.get(key)
    if (hintsEqual(prev, hint)) return false
    slot.delete(key)
    slot.set(key, hint)
    if (slot.size > CACHE_LIMIT) {
      const oldest = slot.keys().next().value
      if (oldest !== undefined) {
        slot.delete(oldest)
        this._stale.get(providerId)?.delete(oldest)
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
    for (const [providerId, slot] of this._cache) {
      const stale = this._staleSlot(providerId)
      for (const key of slot.keys()) stale.add(key)
    }
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

  /** The per-provider slot of `slots`, created on demand. */
  private _slot<K, V>(slots: Map<string, Map<K, V>>, providerId: string): Map<K, V> {
    let slot = slots.get(providerId)
    if (slot === undefined) {
      slot = new Map()
      slots.set(providerId, slot)
    }
    return slot
  }

  private _staleSlot(providerId: string): Set<string> {
    let slot = this._stale.get(providerId)
    if (slot === undefined) {
      slot = new Set()
      this._stale.set(providerId, slot)
    }
    return slot
  }
}

/**
 * Whether a provider contributed the pull-channel capability command. Mirrors
 * the capability-by-registration convention (DirtyDiffContribution / blame):
 * a provider without `checkWorkingTree` (git) never gets the query routed to it.
 */
function hasWorkingTreeCapability(providerId: string): boolean {
  return (
    CommandsRegistry.getCommand(dirtyDiffCommandId(providerId, 'checkWorkingTree')) !== undefined
  )
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
