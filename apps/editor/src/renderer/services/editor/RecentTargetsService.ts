/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-group MRU tracker for the Ctrl+Tab quick-open picker.
 *
 *  Tracks two kinds of switch targets in a single recency-ordered list:
 *   - editors, keyed by (groupId, editorId) and touched from IEditorGroupsService
 *   - views, keyed by viewId and touched from IFocusStackService (which resolves
 *     real DOM focus to the enclosing [data-view-id] subtree)
 *
 *  One list rather than two merged on read: recency is inherently a single
 *  sequence, so a shared `_touch` keeps editors and views ordered against each
 *  other for free.
 *
 *  Targets are resolved lazily on read so the service never holds stale
 *  references to closed editors, removed groups, or deregistered views. A slot
 *  whose editor is gone is *reported* (kind `closedEditor`) rather than dropped
 *  when the caller asks for it: the consumer resolves it against the closed
 *  editors it knows about, so a just-closed file keeps the place it held while
 *  open instead of sinking below targets that have not been used for longer.
 *
 *  The list is persisted per workspace in a restart-stable form (`{kind, id}`
 *  pairs — group ids are a process-global counter and mean nothing tomorrow), so
 *  Ctrl+Tab comes back in the order the user left it. Folding the persisted
 *  history into `_mru` has to happen *after* the editor grid has been rebuilt —
 *  otherwise every restored editor is unresolvable — which is what
 *  `rebaseAfterRestore()` (called by WorkspaceRestoreContribution once restore
 *  settles) is for. Restore-driven activations are excluded from the merge, so
 *  they cannot displace real history; only editors opened after the restore
 *  survive ahead of it.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IFocusStackService,
  ILoggerService,
  IStorageService,
  IViewDescriptorService,
  NullLogger,
  StorageScope,
  ViewContainerLocation,
  createDecorator,
  type EditorInput,
  type IDisposable,
  type IEditorGroup,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IViewDescriptor,
} from '@universe-editor/platform'

export type RecentTarget =
  | { readonly kind: 'editor'; readonly editor: EditorInput; readonly group: IEditorGroup }
  | { readonly kind: 'view'; readonly descriptor: IViewDescriptor }
  /**
   * A recency slot whose editor is no longer open in any group (closed, or its
   * whole group went away). `editorId` is the editor half of the MRU id — the
   * resource URI string for resource-backed inputs. Consumers resolve it against
   * their own record of closed editors and drop it when nothing matches; the
   * slot exists so a just-closed editor keeps the place it held while open
   * instead of sinking below targets the user has not touched for longer.
   */
  | { readonly kind: 'closedEditor'; readonly editorId: string }

export interface IGetRecentTargetsOptions {
  /**
   * Also report `closedEditor` slots. Off by default: Ctrl+Tab switches between
   * open tabs and views, so offering closed ones there would be wrong.
   */
  readonly includeClosedEditors?: boolean
}

export interface IRecentTargetsService {
  readonly _serviceBrand: undefined
  /**
   * Switch targets, most-recently-used first. Editors and views are interleaved
   * by recency; targets never touched this session are appended in registration
   * order so the list always covers everything switchable.
   */
  getRecentTargets(options?: IGetRecentTargetsOptions): readonly RecentTarget[]
  /**
   * Currently visible views, most-recently-used first (never-focused ones last).
   * The view half of `getRecentTargets`, for pickers that list views alongside
   * something other than editors.
   */
  getRecentViews(): readonly IViewDescriptor[]
  /**
   * Tell the service the editor grid has just been rebuilt (workspace restore or
   * workspace switch finished). Only then can persisted editor ids be resolved
   * against the groups that now exist, so this is where the persisted history is
   * folded into the MRU. Safe to call repeatedly.
   */
  rebaseAfterRestore(): void
}

export const IRecentTargetsService = createDecorator<IRecentTargetsService>('recentTargetsService')

// Encodes a target into a single quick-pick id so consumers can decode it back
// without an out-of-band map. The prefixes keep these ids distinct from each
// other and from resource-URI pick ids (e.g. in the Ctrl+P file picker). Editor
// and view ids are opaque strings and never contain `::` in practice; we still
// join with a delimiter unlikely to appear.
const EDITOR_PICK_ID_PREFIX = 'editor::'
const VIEW_PICK_ID_PREFIX = 'view::'
const PICK_ID_DELIMITER = '::'

export function encodeEditorPickId(groupId: number, editorId: string): string {
  return `${EDITOR_PICK_ID_PREFIX}${groupId}${PICK_ID_DELIMITER}${editorId}`
}

export function decodeEditorPickId(id: string): { groupId: number; editorId: string } | undefined {
  if (!id.startsWith(EDITOR_PICK_ID_PREFIX)) return undefined
  const rest = id.slice(EDITOR_PICK_ID_PREFIX.length)
  const sepIdx = rest.indexOf(PICK_ID_DELIMITER)
  if (sepIdx === -1) return undefined
  const groupId = Number(rest.slice(0, sepIdx))
  if (!Number.isInteger(groupId)) return undefined
  return { groupId, editorId: rest.slice(sepIdx + PICK_ID_DELIMITER.length) }
}

export function encodeViewPickId(viewId: string): string {
  return `${VIEW_PICK_ID_PREFIX}${viewId}`
}

export function decodeViewPickId(id: string): string | undefined {
  if (!id.startsWith(VIEW_PICK_ID_PREFIX)) return undefined
  const viewId = id.slice(VIEW_PICK_ID_PREFIX.length)
  return viewId.length > 0 ? viewId : undefined
}

const ALL_LOCATIONS: readonly ViewContainerLocation[] = [
  ViewContainerLocation.SideBar,
  ViewContainerLocation.SecondarySideBar,
  ViewContainerLocation.Panel,
]

// Bounds how far back recency is remembered, NOT how long the picker list is:
// targets that fall out of (or never entered) the MRU are still appended by
// getRecentTargets, so everything switchable stays reachable.
const MAX_ENTRIES = 50

const STORAGE_KEY = 'workbench.recentTargets'
const PERSIST_DEBOUNCE_MS = 200
/** Group id standing in for "the group this editor was in is gone". Editor
 *  entries are resolved by matching `editor.id` against live groups, so a
 *  sentinel that can never be a real group id keeps such a slot from being taken
 *  for a live editor while still letting readers report it as `closedEditor`. */
const DEAD_GROUP_ID = -1

/** Restart-stable form of an MRU id: group ids are a process-global counter and
 *  mean nothing in the next session, editor and view ids do. */
interface PersistedTarget {
  readonly kind: 'editor' | 'view'
  readonly id: string
}

/** MRU id with the group id stripped — the identity used to recognise the same
 *  target across a restart and across groups. */
function stableKeyOf(id: string): string {
  const decoded = decodeEditorPickId(id)
  return decoded ? `${EDITOR_PICK_ID_PREFIX}${decoded.editorId}` : id
}

/** Inverse of `stableKeyOf`, dropping ids of an unexpected shape. */
function toPersistedTarget(id: string): PersistedTarget | undefined {
  const decoded = decodeEditorPickId(id)
  if (decoded) return { kind: 'editor', id: decoded.editorId }
  const viewId = decodeViewPickId(id)
  if (viewId !== undefined) return { kind: 'view', id: viewId }
  return undefined
}

/** `stableKeyOf` of a persisted target — the two sides are comparable directly. */
function persistedKeyOf(target: PersistedTarget): string {
  return target.kind === 'editor'
    ? `${EDITOR_PICK_ID_PREFIX}${target.id}`
    : `${VIEW_PICK_ID_PREFIX}${target.id}`
}

export class RecentTargetsService extends Disposable implements IRecentTargetsService {
  declare readonly _serviceBrand: undefined

  /** Pick ids, most-recent-first. Doubles as the identity key for dedup. */
  private readonly _mru: string[] = []
  private readonly _groupWatchers = new Map<number, IDisposable>()
  /** Persisted history of the current workspace, most-recent-first; `null` until
   *  the storage read settles. Folded into `_mru` once per load. */
  private _base: PersistedTarget[] | null = null
  private _folded = false
  /** Set by `rebaseAfterRestore()` — the grid is known to hold this workspace's
   *  editors, so persisted editor ids can be resolved. */
  private _restoreSettled = false
  private _loadPromise: Promise<void>
  private _persistTimer: ReturnType<typeof setTimeout> | null = null
  private _persistDebounceMs = PERSIST_DEBOUNCE_MS
  private readonly _logger: ILogger

  /** Test seam: collapse the debounce so specs can flush with a bare timer. */
  _setPersistDebounceMsForTests(ms: number): void {
    this._persistDebounceMs = ms
  }

  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IViewDescriptorService private readonly _viewDescriptors: IViewDescriptorService,
    @IFocusStackService focusStack: IFocusStackService,
    @IStorageService private readonly _storage: IStorageService,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'recentTargets', name: 'Recent Targets' }) ??
      new NullLogger()

    this._loadPromise = this._load()
    // The new workspace brings its own history: drop the outgoing one and start
    // over, or its recency would outrank everything in the workspace being
    // opened. Restore (and with it the fold) lands after this.
    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        this._mru.length = 0
        this._base = null
        this._folded = false
        this._restoreSettled = false
        this._loadPromise = this._load()
      }),
    )

    // Seed MRU from current state: every group's active editor, then move the
    // active group's active editor to the head so it represents "now".
    for (const g of this._groups.groups) {
      if (g.activeEditor) this._touch(encodeEditorPickId(g.id, g.activeEditor.id))
      this._watchGroup(g)
    }
    const activeGroup = this._groups.activeGroup
    if (activeGroup.activeEditor) {
      this._touch(encodeEditorPickId(activeGroup.id, activeGroup.activeEditor.id))
    }

    this._register(
      this._groups.onDidActiveGroupChange((group) => {
        if (group.activeEditor) this._touch(encodeEditorPickId(group.id, group.activeEditor.id))
      }),
    )
    this._register(
      this._groups.onDidAddGroup((group) => {
        this._watchGroup(group)
        if (group.activeEditor) this._touch(encodeEditorPickId(group.id, group.activeEditor.id))
      }),
    )
    this._register(
      this._groups.onDidRemoveGroup((group) => {
        this._groupWatchers.get(group.id)?.dispose()
        this._groupWatchers.delete(group.id)
        const prefix = `${EDITOR_PICK_ID_PREFIX}${group.id}${PICK_ID_DELIMITER}`
        for (let i = this._mru.length - 1; i >= 0; i--) {
          if (this._mru[i]!.startsWith(prefix)) this._mru.splice(i, 1)
        }
      }),
    )

    // Views enter the MRU on real focus: the stack resolves the focused element
    // to its enclosing [data-view-id], so this fires exactly when the user works
    // inside a view. Editor-area entries carry no viewId and are ignored — the
    // group events above already cover them.
    this._register(
      focusStack.onDidChange(() => {
        const viewId = focusStack.getTop()?.viewId
        if (viewId) this._touch(encodeViewPickId(viewId))
      }),
    )

    this._register({
      dispose: () => {
        if (this._persistTimer !== null) {
          clearTimeout(this._persistTimer)
          this._persistTimer = null
        }
        for (const d of this._groupWatchers.values()) d.dispose()
        this._groupWatchers.clear()
        this._mru.length = 0
      },
    })
  }

  rebaseAfterRestore(): void {
    this._restoreSettled = true
    this._maybeFold()
  }

  getRecentTargets(options?: IGetRecentTargetsOptions): readonly RecentTarget[] {
    this._maybeFold()
    const out: RecentTarget[] = []
    const seen = new Set<string>()
    const visibleViews = this._visibleViews()
    const liveEditorIds = options?.includeClosedEditors ? this._liveEditorIds() : undefined

    for (const id of this._mru) {
      const viewId = decodeViewPickId(id)
      if (viewId !== undefined) {
        const descriptor = visibleViews.get(viewId)
        if (!descriptor) continue
        seen.add(id)
        out.push({ kind: 'view', descriptor })
        continue
      }
      const decoded = decodeEditorPickId(id)
      if (!decoded) continue
      const group = this._groups.getGroup(decoded.groupId)
      const editor = group?.editors.find((e) => e.id === decoded.editorId)
      if (!group || !editor) {
        // The editor is gone. Callers that list closed editors still get the
        // slot, at the recency position it held — unless the same editor is open
        // elsewhere, where reporting it again would only duplicate a row under
        // the same pick id.
        if (liveEditorIds && !liveEditorIds.has(decoded.editorId)) {
          seen.add(id)
          out.push({ kind: 'closedEditor', editorId: decoded.editorId })
        }
        continue
      }
      seen.add(id)
      out.push({ kind: 'editor', editor, group })
    }

    // Append editors open in groups but never activated in this session (e.g.
    // background tabs restored from a previous session).
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (!seen.has(encodeEditorPickId(group.id, editor.id))) {
          out.push({ kind: 'editor', editor, group })
        }
      }
    }

    // Append every other visible view, so the picker covers all of them from a
    // cold start rather than only the ones focused so far.
    for (const [viewId, descriptor] of visibleViews) {
      if (!seen.has(encodeViewPickId(viewId))) out.push({ kind: 'view', descriptor })
    }

    return out
  }

  /** Every editor id currently open in any group — used to tell a genuinely
   *  closed editor apart from one that merely moved to another group. */
  private _liveEditorIds(): Set<string> {
    const ids = new Set<string>()
    for (const group of this._groups.groups) {
      for (const editor of group.editors) ids.add(editor.id)
    }
    return ids
  }

  /**
   * Visible views across all three locations, in display order.
   * `getViewsByContainer` already applies `when` gating, so its result *is* the
   * definition of "visible" — no extra context-key evaluation here.
   */
  private _visibleViews(): Map<string, IViewDescriptor> {
    const result = new Map<string, IViewDescriptor>()
    for (const location of ALL_LOCATIONS) {
      for (const container of this._viewDescriptors.getViewContainersByLocation(location)) {
        for (const view of this._viewDescriptors.getViewsByContainer(container.id)) {
          result.set(view.id, view)
        }
      }
    }
    return result
  }

  getRecentViews(): readonly IViewDescriptor[] {
    this._maybeFold()
    const visible = this._visibleViews()
    const out: IViewDescriptor[] = []
    const seen = new Set<string>()
    for (const id of this._mru) {
      const viewId = decodeViewPickId(id)
      if (viewId === undefined) continue
      const descriptor = visible.get(viewId)
      if (!descriptor) continue
      seen.add(viewId)
      out.push(descriptor)
    }
    for (const [viewId, descriptor] of visible) {
      if (!seen.has(viewId)) out.push(descriptor)
    }
    return out
  }

  private _watchGroup(group: IEditorGroup): void {
    if (this._groupWatchers.has(group.id)) return
    const d = this._register(
      group.onDidActiveEditorChange(() => {
        const active = group.activeEditor
        if (active) this._touch(encodeEditorPickId(group.id, active.id))
      }),
    )
    this._groupWatchers.set(group.id, d)
  }

  private _touch(id: string): void {
    const idx = this._mru.indexOf(id)
    if (idx !== -1) this._mru.splice(idx, 1)
    this._mru.unshift(id)
    if (this._mru.length > MAX_ENTRIES) this._mru.length = MAX_ENTRIES
    this._schedulePersist()
  }

  // ----- Persisted history ---------------------------------------------------

  private async _load(): Promise<void> {
    const raw = await this._storage.get<PersistedTarget[]>(STORAGE_KEY, StorageScope.WORKSPACE)
    this._base = Array.isArray(raw) ? raw : []
    this._maybeFold()
  }

  /**
   * Fold the persisted history into `_mru`, once per load. Waits for the storage
   * read, and — during startup — for the editor restore: resolving persisted
   * editors before the grid is rebuilt would leave them all unresolvable, i.e.
   * as dead slots, and the history would be gone for the rest of the session.
   * `_restoreSettled` is the reliable signal; the "any editor open" check only
   * covers the gap before `rebaseAfterRestore()` arrives.
   */
  private _maybeFold(): void {
    if (this._folded || this._base === null) return
    const base = this._base
    if (!this._restoreSettled && base.some((t) => t.kind === 'editor') && !this._anyEditorOpen()) {
      return
    }
    this._folded = true
    this._base = null

    const baseKeys = new Set<string>()
    const folded: string[] = []
    for (const target of base) {
      const key = persistedKeyOf(target)
      if (baseKeys.has(key)) continue
      baseKeys.add(key)
      folded.push(this._idForPersisted(target))
    }
    // Entries touched this session take the head — they are newer than anything
    // in the history, and in the common case of a plain restart this list is
    // empty: the activations the restore itself performs match history entries
    // and are dropped here, so they cannot displace the order the user left.
    const sessionPart = this._mru.filter((id) => !baseKeys.has(stableKeyOf(id)))
    const basePart = folded.slice(0, Math.max(0, MAX_ENTRIES - sessionPart.length))
    this._mru.length = 0
    this._mru.push(...sessionPart, ...basePart)
    this._logger.debug(
      `folded persisted recency: history=${basePart.length} session=${sessionPart.length}`,
    )
    this._schedulePersist()
  }

  /** Persisted target → MRU id. Editors are re-anchored to the group that holds
   *  them now; ones that are gone keep a dead slot so a caller listing closed
   *  editors can still place them. */
  private _idForPersisted(target: PersistedTarget): string {
    if (target.kind === 'view') return encodeViewPickId(target.id)
    for (const group of this._groups.groups) {
      if (group.editors.some((e) => e.id === target.id)) {
        return encodeEditorPickId(group.id, target.id)
      }
    }
    return encodeEditorPickId(DEAD_GROUP_ID, target.id)
  }

  private _anyEditorOpen(): boolean {
    return this._groups.groups.some((g) => g.editors.length > 0)
  }

  private _schedulePersist(): void {
    if (this._persistTimer !== null) clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      void this._persist()
    }, this._persistDebounceMs)
  }

  /** Waits for the initial read first: an early write must not clobber the
   *  persisted history with only this session's entries. */
  private async _persist(): Promise<void> {
    await this._loadPromise
    try {
      const ordered = [...this._mru.map((id) => toPersistedTarget(id)), ...(this._base ?? [])]
      const out: PersistedTarget[] = []
      const seen = new Set<string>()
      for (const target of ordered) {
        if (!target) continue
        const key = persistedKeyOf(target)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(target)
      }
      await this._storage.set(STORAGE_KEY, out.slice(0, MAX_ENTRIES), StorageScope.WORKSPACE)
    } catch (err) {
      this._logger.warn(
        'failed to persist recent targets',
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    }
  }
}
