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
 *  references to closed editors, removed groups, or deregistered views.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IFocusStackService,
  IViewDescriptorService,
  ViewContainerLocation,
  createDecorator,
  type EditorInput,
  type IDisposable,
  type IEditorGroup,
  type IViewDescriptor,
} from '@universe-editor/platform'

export type RecentTarget =
  | { readonly kind: 'editor'; readonly editor: EditorInput; readonly group: IEditorGroup }
  | { readonly kind: 'view'; readonly descriptor: IViewDescriptor }

export interface IRecentTargetsService {
  readonly _serviceBrand: undefined
  /**
   * Switch targets, most-recently-used first. Editors and views are interleaved
   * by recency; targets never touched this session are appended in registration
   * order so the list always covers everything switchable.
   */
  getRecentTargets(): readonly RecentTarget[]
  /**
   * Currently visible views, most-recently-used first (never-focused ones last).
   * The view half of `getRecentTargets`, for pickers that list views alongside
   * something other than editors.
   */
  getRecentViews(): readonly IViewDescriptor[]
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

export class RecentTargetsService extends Disposable implements IRecentTargetsService {
  declare readonly _serviceBrand: undefined

  /** Pick ids, most-recent-first. Doubles as the identity key for dedup. */
  private readonly _mru: string[] = []
  private readonly _groupWatchers = new Map<number, IDisposable>()

  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IViewDescriptorService private readonly _viewDescriptors: IViewDescriptorService,
    @IFocusStackService focusStack: IFocusStackService,
  ) {
    super()

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
        for (const d of this._groupWatchers.values()) d.dispose()
        this._groupWatchers.clear()
        this._mru.length = 0
      },
    })
  }

  getRecentTargets(): readonly RecentTarget[] {
    const out: RecentTarget[] = []
    const seen = new Set<string>()
    const visibleViews = this._visibleViews()

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
      if (!group) continue
      const editor = group.editors.find((e) => e.id === decoded.editorId)
      if (!editor) continue
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
  }
}
