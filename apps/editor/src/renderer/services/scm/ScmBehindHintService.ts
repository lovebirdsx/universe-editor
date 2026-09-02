/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmBehindHintService — pull-style "is this file's have revision behind the
 *  depot head?" ask-once cache.
 *
 *  Split of labour with the push channel: the actual ↓ marker arrives as
 *  trailing grey text through the provider's `setSupplementaryDecorations` push
 *  (see ScmDecorationsService.getSupplementary, which the Explorer row renders).
 *  This service is only the pull channel — rendering a visible file row calls
 *  `isBehind` to (a) trigger the owning provider's `<providerId>.checkBehind`
 *  batch probe and (b) cache the answer so a known path is never probed twice.
 *  The return value is deliberately NOT rendered: consumers re-render on
 *  `version` only to feed the next render's enqueue, never to draw the marker.
 *
 *  Caching mirrors ScmIgnoredResourcesService (one flat boolean map, full
 *  invalidation on repo/provider changes — behind is a cheap boolean resolved
 *  by one batched command, and switching repos is a low-frequency explicit act)
 *  plus ScmWorkingTreeHintService's in-flight token: each key carries the stamp
 *  of the newest query for it, and an answer whose stamp no longer matches is
 *  discarded (latest-wins) instead of installing stale state.
 *
 *  Invalidating on the decorations snapshot is cycle-safe: a fresh
 *  supplementary push (e.g. a sync cleared the markers) makes every cached
 *  behind answer suspect, so the cache clears and `version` bumps; the next
 *  render re-probes visible rows. The probe itself pushes no decoration, and
 *  the provider's setSupplementaryDecorations delta-dedupes (an unchanged set
 *  fires no event), so probe → push → invalidate → probe settles the moment
 *  the supplementary set stops changing — it cannot loop forever.
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
import { dirtyDiffCommandId } from '@universe-editor/extensions-common'
import { IScmService, resolveScmProviderId } from '../extensions/ScmService.js'
import { currentRemoteAuthority } from '../remote/windowRemoteAuthority.js'
import { IScmDecorationsService, scmPathKey } from './ScmDecorationsService.js'
import { scmHostPath } from './scmHostPath.js'
// services → workbench reverse import: scmViewState is module-level observable
// state with no view dependency, so a service may read it (precedent:
// ScmIgnoredResourcesService).
import { scmViewState } from '../../workbench/scm/scmViewState.js'

export interface IScmBehindHintService {
  readonly _serviceBrand: undefined
  /** Bumps whenever a batch resolves or the cache is invalidated, so consumers re-render. */
  readonly version: IObservable<number>
  /** Cached behind status; undefined while unknown (the path is enqueued for a batch). */
  isBehind(resource: URI): boolean | undefined
}

export const IScmBehindHintService = createDecorator<IScmBehindHintService>('scmBehindHintService')

export class ScmBehindHintService extends Disposable implements IScmBehindHintService {
  declare readonly _serviceBrand: undefined

  readonly version: IObservable<number>

  private readonly _version = observableValue<number>('scmBehindHintVersion', 0)
  private readonly _cache = new Map<string, boolean>()
  private readonly _pending = new Map<string, string>()
  /**
   * Keys whose query is on the wire right now, mapped to the token of the
   * *newest* query for that key (single slot — the answer lands in the shared
   * cache regardless of provider, so no per-provider slotting is needed). A key
   * is removed either when its answer is written or when something invalidates
   * it mid-flight; an answer whose token no longer matches is discarded — see
   * {@link _writeBehind}.
   *
   * The token is what makes this latest-wins. Two queries for one key overlap
   * whenever the provider's round-trip outlasts the debounce, and without a
   * per-request identity the second flush re-arms the marker the first answer
   * then consumes: the pre-save answer wins and pins the row forever.
   */
  private readonly _inFlight = new Map<string, number>()
  /** Monotonic; identifies one query for one key. */
  private _queryToken = 0
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
      loggerService?.createLogger({ id: 'scmBehindHint', name: 'SCM Behind Hint' }) ??
      new NullLogger()

    this._register(watcher.onDidChangeFiles((events) => this._onFileEvents(events)))
    this._register(this._workspace.onDidChangeWorkspace(() => this._invalidate()))

    // Re-arbitrate on both inputs (the same startup race as
    // ScmIgnoredResourcesService: a restored selectedRepo can point at a
    // provider whose source control isn't registered yet). Behind answers are
    // cheap booleans resolved by one batched command, so — like ignored — a
    // full invalidation on either input change is simpler than per-provider
    // slots.
    let first = true
    this._register(
      autorun((reader) => {
        this._scm.sourceControls.read(reader)
        scmViewState.selectedRepo.read(reader)
        if (first) {
          first = false
          return
        }
        this._invalidate()
      }),
    )

    // The provider pushes the actual ↓ marker through supplementary
    // decorations; a new supplementary snapshot can mean behind state moved on
    // with no matching file event (e.g. a sync cleared the markers), so every
    // cached answer is then suspect. Full invalidation — not revalidation:
    // behind is a cheap boolean probe and visible rows re-ask through the next
    // render. Cycle-safe: the probe pushes nothing, and the provider's
    // setSupplementaryDecorations delta-dedupes, so the decorations observable
    // settles once the supplementary set stops changing (see the file head).
    let firstDecorations = true
    this._register(
      autorun((reader) => {
        this._decorations.decorations.read(reader)
        if (firstDecorations) {
          firstDecorations = false
          return
        }
        this._invalidate()
      }),
    )
  }

  override dispose(): void {
    if (this._flushTimer !== undefined) clearTimeout(this._flushTimer)
    super.dispose()
  }

  isBehind(resource: URI): boolean | undefined {
    const fsPath = this._hostPath(resource)
    if (fsPath === undefined) return false
    const key = scmPathKey(fsPath)
    const cached = this._cache.get(key)
    if (cached !== undefined) return cached
    // The in-flight guard mirrors the pending one: a key whose query is on the
    // wire must not be re-enqueued — Explorer re-reads every visible row on
    // every render, and without the guard one slow batch becomes a stream of
    // duplicate queries on the provider's shared concurrency gate. The token
    // stamping in `_flush` still applies to what gets enqueued: a file event
    // re-enqueues a key whose old answer is on the wire, and the newer stamp
    // lets the old answer be recognised as superseded.
    if (this._pending.has(key) || this._inFlight.has(key)) return undefined
    this._pending.set(key, fsPath)
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
      let reenqueue = false
      // A save can move the file's haveRev relation, so its cached answer is
      // suspect: drop it and ask again. An answer already on the wire describes
      // a version of the file that no longer exists on disk — drop it on
      // arrival and re-enqueue now, otherwise the round-trip lands *after* this
      // event and installs the very answer the event was supposed to correct.
      this._pending.delete(key)
      if (this._inFlight.delete(key)) reenqueue = true
      if (this._cache.delete(key)) dropped = true
      if (reenqueue) {
        this._pending.set(key, fsPath)
        this._scheduleFlush()
      }
    }
    // Drop only the touched paths' answers and bump so the next render
    // re-enqueues them for a fresh query.
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
    const byProvider = new Map<string, string[]>()
    for (const [key, fsPath] of entries) {
      const providerId = resolveScmProviderId(
        this._scm.sourceControls.get(),
        fsPath,
        scmViewState.selectedRepo.get(),
      )
      if (providerId === undefined) {
        this._cache.set(key, false)
        continue
      }
      const token = ++this._queryToken
      tokens.set(key, token)
      this._inFlight.set(key, token)
      const list = byProvider.get(providerId)
      if (list) list.push(fsPath)
      else byProvider.set(providerId, [fsPath])
    }

    const write = (key: string, behind: boolean): void => {
      this._writeBehind(key, behind, tokens.get(key))
    }

    for (const [providerId, paths] of byProvider) {
      let behind: readonly string[] | undefined
      try {
        behind = await this._commands.executeCommand<readonly string[] | undefined>(
          dirtyDiffCommandId(providerId, 'checkBehind'),
          paths,
        )
      } catch (err) {
        if (this._generation !== generation) return
        this._logger.warn(
          `check-behind via ${providerId} failed; treating batch as not behind`,
          err,
        )
        for (const p of paths) write(scmPathKey(p), false)
        continue
      }
      // Invalidation fired while the command was in flight (e.g. a workspace
      // switch): the cache/pending were cleared, so discard these now-stale
      // answers — the next render re-enqueues.
      if (this._generation !== generation) return
      // undefined = command not registered (extension still activating / a
      // provider without the capability) — treat the batch as not behind so we
      // don't re-query every frame.
      if (behind === undefined) {
        for (const p of paths) write(scmPathKey(p), false)
        continue
      }
      const behindKeys = new Set(behind.map((p) => scmPathKey(p)))
      // Write every requested path (hit → true, miss → false) so a miss doesn't
      // stay "unknown" and re-enqueue on every render.
      for (const p of paths) {
        const key = scmPathKey(p)
        write(key, behindKeys.has(key))
      }
    }

    if (this._generation !== generation) return
    this._logger.debug(`resolved ${entries.length} behind-head query(s)`)
    this._version.set(this._version.get() + 1, undefined)
  }

  /** Write a behind answer, dropping it when a newer query for the key superseded it. */
  private _writeBehind(key: string, behind: boolean, token: number | undefined): void {
    // A token mismatch means this answer has been superseded: either something
    // invalidated the key mid-flight (a file event, or a whole-cache
    // invalidation), or a newer query for the same key was already issued.
    // Either way it describes state that no longer holds, so drop it rather
    // than cache it — caching it would install an answer nothing is left to
    // correct.
    if (this._inFlight.get(key) !== token) {
      this._logger.debug(`discarded stale behind answer for ${key}`)
      return
    }
    this._inFlight.delete(key)
    this._cache.set(key, behind)
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
    this._version.set(this._version.get() + 1, undefined)
  }
}
