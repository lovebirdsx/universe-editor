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
 *  Folders fold descendant hints upward from two sources: the pull channel's file
 *  cache, and a per-directory aggregate the provider's background scan feeds
 *  directly (so a scan can tint folders without flooding the file LRU — see
 *  `_scanFolders`). The aggregate is a lower bound by design — paths that were
 *  never rendered were never queried, and a save can still take a colour away,
 *  so a folder's tint can change as the user expands and scrolls. Accepted
 *  trade-off: the alternative is eager discovery, i.e. exactly the whole-tree
 *  scan this service exists to avoid.
 *
 *  Both caches are slotted per provider id (the DirtyDiff/Blame precedent):
 *  switching the SCM view's selected repo only hides the other providers' slots
 *  and bumps the version — the data is kept, so switching back restores the
 *  hints instantly. That matters because the p4 reconcile scan publishes once
 *  per session; clearing its aggregate on switch would lose the folder tints
 *  for good. A workspace switch or a source-controls change still clears every
 *  slot — those stale the data itself, not just its visibility.
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
  resolveSelectedSourceControl,
  type IScmSourceControlModel,
  type IScmWorkingTreeScanResult,
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
   * Colour derived from known descendants across two sources — the pull
   * channel's file cache and the background scan's per-directory fold — or
   * undefined when none has been discovered. A lower bound: it can gain entries
   * as the user expands/renders new paths or a scan discovers more drift, and
   * lose them to a save or a workspace change. The scan fold is not subject to
   * the file-level LRU eviction the pull cache is.
   */
  getFolderHint(resource: URI): IWorkingTreeFolderHint | undefined
}

export const IScmWorkingTreeHintService = createDecorator<IScmWorkingTreeHintService>(
  'scmWorkingTreeHintService',
)

/** Explorer is virtualised: fast scrolling touches thousands of paths, so bound the cache. */
export const CACHE_LIMIT = 4096

/**
 * Upper bound on the scan's per-directory aggregate. Tens of thousands of drift
 * files still map to only a few thousand directories, so this sits far above the
 * real range; it exists so a pathological scan cannot grow the table unbounded.
 * Unlike the file LRU it never evicts silently — reaching it logs a warning.
 */
export const SCAN_FOLDER_LIMIT = 16384

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
  /**
   * Pull-channel answers, slotted by the provider id that produced them
   * (DirtyDiff/Blame precedent). null = known clean; it still occupies a slot
   * and is still evicted. A repo switch keeps the slots — reads filter by the
   * selected provider — so switching back restores hints without a re-query.
   * The per-slot LRU is bounded by {@link CACHE_LIMIT}.
   */
  private readonly _cache = new Map<string, Map<string, IWorkingTreeHint | null>>()
  /**
   * Directory-aggregate built from the provider's background scan, slotted by
   * `sourceControlId`. A scan can publish tens of thousands of file hints for a
   * single directory, so they are folded to per-directory winners here instead
   * of flooding the file LRU (which would silently evict both the scan's own
   * results and the pull channel's visible-row answers). Cleared on
   * invalidation; not touched by file events — the aggregate is lossy and
   * cannot subtract a single file, so it stays as a conservative lower bound.
   * Kept across repo switches: the p4 reconcile scan publishes once per
   * session, so dropping the slot would lose its tints for good. Bounded by
   * {@link SCAN_FOLDER_LIMIT} per slot.
   */
  private readonly _scanFolders = new Map<string, Map<string, FolderFold>>()
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
    if (this._scanBumpTimer !== undefined) clearTimeout(this._scanBumpTimer)
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
    // file events, invalidation, and LRU eviction inside `_writeHint`), the
    // scan fold (`_acceptScanResults` → `_scheduleScanVersionBump`), and repo
    // switches (the arbitration autorun). `getHint`'s LRU touch only re-orders
    // entries, which the deterministic tie-break makes irrelevant — so the
    // version is a sound memo generation for the fold.
    const version = this._version.get()
    if (this._folderHints === undefined || this._folderHintsVersion !== version) {
      this._folderHints = this._mergeFolderHints(
        this._buildFolderHints(visible),
        this._scanFold(visible),
      )
      this._folderHintsVersion = version
    }
    return this._folderHints.get(scmPathKey(fsPath))
  }

  /**
   * Propagate every non-null file hint up its ancestor directories. No provider
   * root is known here, so propagation runs to the path top — harmless, since
   * only rendered rows ever look a folder up. The fold decision (delete outranks
   * any other drift; equal weight breaks to the smaller source key) is shared
   * with the scan fold via {@link _folderWeight}/{@link _folderFoldBeats} so the
   * two sources can never disagree about a directory's winner.
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
   * The scan fold for `providerId`'s slot, or — when no repo is selected — a
   * merge of every slot resolved by the same fold decision, so all providers'
   * tints stay visible in the unselected state.
   */
  private _scanFold(providerId: string | undefined): Map<string, FolderFold> {
    if (providerId !== undefined) {
      const slot = this._scanFolders.get(providerId)
      return slot ?? EMPTY_FOLD
    }
    const merged = new Map<string, FolderFold>()
    for (const slot of this._scanFolders.values()) {
      for (const [key, entry] of slot) {
        if (this._folderFoldBeats(merged.get(key), entry.weight, entry.source)) {
          merged.set(key, entry)
        }
      }
    }
    return merged
  }

  /**
   * The provider a read should show: the SCM view's selected source control
   * (same arbitration as the decorations), or undefined when no repo is
   * selected — then every provider's own slot shows, matching the historical
   * unselected behaviour. Same-root double providers cannot be told apart by
   * the selection; both resolve to the first registered one, exactly like the
   * query routing in `_flush`.
   */
  private _visibleProviderId(): string | undefined {
    const selected = scmViewState.selectedRepo.get()
    if (selected === undefined) return undefined
    return resolveSelectedSourceControl(this._scm.sourceControls.get(), selected)?.id
  }

  /** Which provider currently owns `fsPath`, with the same arbitration as `_flush`. */
  private _ownerProviderId(fsPath: string): string | undefined {
    return resolveScmProviderId(
      this._scm.sourceControls.get(),
      fsPath,
      scmViewState.selectedRepo.get(),
    )
  }

  /** Fold weight: a delete (strikeThrough) outranks any other drift. */
  private _folderWeight(hint: IWorkingTreeHint): number {
    return hint.strikeThrough === true ? FOLDER_HINT_WEIGHT_DELETE : FOLDER_HINT_WEIGHT_CHANGE
  }

  /** Shared fold decision: higher weight wins; equal weight breaks to the smaller source key. */
  private _folderFoldBeats(prev: FolderFold | undefined, weight: number, source: string): boolean {
    return (
      prev === undefined || weight > prev.weight || (weight === prev.weight && source < prev.source)
    )
  }

  /**
   * Merge the pull-channel fold with the scan fold into colour-only entries. A
   * directory present in both resolves by the same rule the two folds apply
   * internally — higher weight, then smaller source key — so it is deterministic.
   */
  private _mergeFolderHints(
    pull: Map<string, FolderFold>,
    scan: Map<string, FolderFold>,
  ): Map<string, IWorkingTreeFolderHint> {
    const merged = new Map<string, IWorkingTreeFolderHint>()
    for (const [key, entry] of pull) merged.set(key, { color: entry.color })
    for (const [key, entry] of scan) {
      if (this._folderFoldBeats(pull.get(key), entry.weight, entry.source)) {
        merged.set(key, { color: entry.color })
      }
    }
    return merged
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
      // Deliberately not touching `_scanFolders`: the scan aggregate is lossy —
      // it holds per-directory winners, not per-file entries — so it cannot
      // subtract a single changed file. Leaving it is the conservative choice
      // (the tint is a lower bound that may briefly over-report).
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
      const providerId = resolveScmProviderId(
        this._scm.sourceControls.get(),
        fsPath,
        scmViewState.selectedRepo.get(),
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

  /**
   * Fold a provider background-scan batch into the per-directory aggregate
   * `_scanFolders`, never into the file LRU. A scan can publish tens of
   * thousands of file hints for one directory; writing them into the file cache
   * would both evict most of the scan's own results and displace the pull
   * channel's answers for visible rows. Folder tints only need the aggregate
   * colour, so the scan lands here and the file-level RC badge stays the pull
   * channel's job. The scan's path strings come straight from the SCM host — the
   * same host space {@link _hostPath} maps resources into — so `scmPathKey`
   * alone is the right key. Nothing is written for a clean directory (an absent
   * hint already means "no drift", and there is no directory-level negative
   * entry to cache).
   */
  private _acceptScanResults(results: readonly IScmWorkingTreeScanResult[]): void {
    let changed = false
    // Counted as a set of directories, not as a tally of rejections: one file is
    // folded up its whole ancestor chain, so incrementing per rejected level
    // would report a multiple of the directories actually left out.
    const rejected = new Set<string>()
    for (const result of results) {
      const slot = this._slot(this._scanFolders, result.sourceControlId)
      for (const dto of result.hints) {
        if (this._foldScanHint(slot, scmPathKey(dto.path), toHint(dto), rejected)) changed = true
      }
    }
    if (rejected.size > 0) {
      this._logger.warn(
        `scan folder aggregate reached its ${SCAN_FOLDER_LIMIT}-directory limit; ` +
          `${rejected.size} director${rejected.size === 1 ? 'y' : 'ies'} left untinted`,
      )
    }
    if (changed) {
      this._logger.debug(
        `accepted ${results.length} working-tree scan result(s) from ${results[0]?.sourceControlId ?? 'unknown provider'}`,
      )
      this._scheduleScanVersionBump()
    }
  }

  /**
   * Fold one scan hint up its ancestor directories into the provider's
   * `_scanFolders` slot, applying the same fold decision as
   * `_buildFolderHints`. Once the slot reaches `SCAN_FOLDER_LIMIT` new
   * directories stop being added (existing entries still update) and each one
   * is recorded in `rejected`, so the caller can report what was left out
   * rather than silently truncating the aggregate.
   */
  private _foldScanHint(
    slot: Map<string, FolderFold>,
    key: string,
    hint: IWorkingTreeHint,
    rejected: Set<string>,
  ): boolean {
    const weight = this._folderWeight(hint)
    let changed = false
    let dir = parentDir(key)
    while (dir) {
      const prev = slot.get(dir)
      if (prev === undefined && slot.size >= SCAN_FOLDER_LIMIT) {
        rejected.add(dir)
      } else if (this._folderFoldBeats(prev, weight, key)) {
        slot.set(dir, { weight, color: hint.color, source: key })
        changed = true
      }
      dir = parentDir(dir)
    }
    return changed
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
    this._scanFolders.clear()
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

/** Shared empty fold, so the selected-slot path of `_scanFold` allocates nothing. */
const EMPTY_FOLD: Map<string, FolderFold> = new Map()

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
