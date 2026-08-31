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
import { IScmService, resolveScmProviderId } from '../extensions/ScmService.js'
import { currentRemoteAuthority } from '../remote/windowRemoteAuthority.js'
import { IScmDecorationsService, scmPathKey } from './ScmDecorationsService.js'
import { scmHostPath } from './scmHostPath.js'

export interface IWorkingTreeHint {
  readonly color: string
  readonly letter: string
  readonly tooltip?: string
  readonly strikeThrough?: boolean
}

export interface IScmWorkingTreeHintService {
  readonly _serviceBrand: undefined
  /** Bumps whenever a batch resolves or the cache is invalidated, so consumers re-render. */
  readonly version: IObservable<number>
  /** Cached hint; undefined while unknown (enqueued for a batch) or clean/off-host. */
  getHint(resource: URI): IWorkingTreeHint | undefined
}

export const IScmWorkingTreeHintService = createDecorator<IScmWorkingTreeHintService>(
  'scmWorkingTreeHintService',
)

/** Explorer is virtualised: fast scrolling touches thousands of paths, so bound the cache. */
export const CACHE_LIMIT = 4096

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
   * Keys whose query is on the wire right now. A key is removed either when its
   * answer is written or when something invalidates it mid-flight, and an answer
   * for a key no longer in this set is discarded — see {@link _writeHint}.
   */
  private readonly _inFlight = new Set<string>()
  private _flushTimer: ReturnType<typeof setTimeout> | undefined
  /** Bumped on every invalidation so an in-flight flush can drop stale results. */
  private _generation = 0
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
    // no matching file-system event (e.g. p4 dismiss/clearDismissed). Revalidate —
    // not invalidate — so visible rows keep their old hint instead of flickering
    // for the ~150ms round-trip; a result that matches the old value is not bumped.
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
      if (this._stale.delete(key)) {
        if (!this._pending.has(key)) this._pending.set(key, fsPath)
        this._scheduleFlush()
      }
      return cached ?? undefined
    }
    if (!this._pending.has(key)) this._pending.set(key, fsPath)
    this._scheduleFlush()
    return undefined
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
      // provider refresh (and with `perforce.autoRefresh` off, not even that).
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
    // Add, never clear: two flushes can overlap (the debounce can re-arm while
    // this one awaits), and clearing here would make the second one silently
    // discard the first one's answers.
    for (const [key] of entries) this._inFlight.add(key)
    let changed = false

    const byProvider = new Map<string, string[]>()
    for (const [key, fsPath] of entries) {
      const providerId = resolveScmProviderId(this._scm.sourceControls.get(), fsPath)
      if (providerId === undefined) {
        changed = this._writeHint(key, null) || changed
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
        for (const p of paths) changed = this._writeHint(scmPathKey(p), null) || changed
        continue
      }
      // Invalidation fired while the command was in flight: the cache/pending were
      // cleared, so discard these now-stale answers — the next render re-enqueues.
      if (this._generation !== generation) return
      // undefined = command not registered (extension still activating / provider
      // without the capability) — treat the batch as clean so we don't re-query
      // every frame.
      if (dtos === undefined) {
        for (const p of paths) changed = this._writeHint(scmPathKey(p), null) || changed
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
        changed = this._writeHint(key, hintsByKey.get(key) ?? null) || changed
      }
    }

    if (this._generation !== generation) return
    if (changed) {
      this._logger.debug(`resolved ${entries.length} working-tree hint query(s)`)
      this._version.set(this._version.get() + 1, undefined)
    }
  }

  /** Write a hint, returning whether the cached value actually changed. */
  private _writeHint(key: string, hint: IWorkingTreeHint | null): boolean {
    // Gone from the in-flight set means something invalidated this key while the
    // query was out (a file event, or a whole-cache invalidation). The answer
    // describes state that no longer holds, so drop it rather than cache it.
    if (!this._inFlight.delete(key)) return false
    this._stale.delete(key)
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
