/**
 * Host-side registry backing `window.registerTreeDataProvider` /
 * `window.createTreeView`. Providers are keyed by view id (the manifest
 * `contributes.views` id); children pulls come back through
 * `IExtHostTreeViews.$getChildren`, and interaction callbacks (visibility /
 * selection / expansion) feed the `TreeView` facade's events.
 *
 * Elements never cross the wire: each view keeps a handle table (element ↔
 * handle) handed out as children are serialized. Handles are derived from a
 * **stable identity key** — `TreeItem.id` when the provider supplies one, else
 * the element object itself while it stays on the same page, else the label
 * under the parent handle — so the same row keeps the same handle across
 * refreshes and the renderer's expansion / selection state survives. A handle
 * is recycled (with its whole cached subtree) only when its element stops
 * coming back from the parent's `getChildren`, which also bounds the table.
 *
 * `onDidChangeTreeData` is debounced: a burst collapses into one wire call,
 * either whole-view (fired without an element) or per-subtree (the refreshed
 * items ride along so the renderer can replace those rows in place).
 */
import { Emitter, type Event } from '@universe-editor/platform'
import type {
  Command,
  Disposable,
  TreeDataProvider,
  TreeItem,
  TreeView,
  TreeViewExpansionChangeEvent,
  TreeViewOptions,
  TreeViewSelectionChangeEvent,
  TreeViewVisibilityChangeEvent,
} from '@universe-editor/extension-api'
import type { IMainThreadTreeViews, ITreeItemDto } from '@universe-editor/extensions-common'
import { toCommandDto } from './hostHandles.js'
import { reviveWireUri } from './wireUri.js'

/** Page key for the roots (no parent handle). Handles start at 1. */
const ROOT_PAGE = -1

/** Merge window for `onDidChangeTreeData` bursts (git-style providers fire per file event). */
const REFRESH_DEBOUNCE_MS = 50

interface IPendingRefresh {
  /** A fire without an element (or with an empty array) invalidates everything. */
  full: boolean
  readonly elements: unknown[]
}

interface IRegisteredView {
  readonly provider: TreeDataProvider<unknown>
  changeListener: Disposable | undefined
  readonly elementByHandle: Map<number, unknown>
  readonly handleByElement: Map<unknown, number>
  /** Stable identity key → handle. Outlives refreshes; see `_stableKey`. */
  readonly handleByKey: Map<string, number>
  readonly keyByHandle: Map<number, string>
  /** Handles serialized for each page (ROOT_PAGE = roots), for subtree recycling. */
  readonly pageChildren: Map<number, number[]>
  /** Reverse of `pageChildren` — which page each live handle sits on. */
  readonly pageByHandle: Map<number, number>
  /**
   * The `TreeItem.command` the provider returned for each handle, kept
   * host-side so a row click can execute it against the original arguments —
   * live objects (Uri instances, custom payloads) must never ride the wire.
   */
  readonly commandByHandle: Map<number, Command>
  nextHandle: number
  pending: IPendingRefresh | undefined
  pendingTimer: ReturnType<typeof setTimeout> | undefined
  /** Facade created by `createTreeView`; absent for a bare `registerTreeDataProvider`. */
  view?: HostTreeView
}

function labelOf(item: TreeItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label
}

class HostTreeView implements TreeView<unknown> {
  private _visible = false
  private _selection: readonly unknown[] = []
  private _disposed = false

  private readonly _onDidChangeVisibility = new Emitter<TreeViewVisibilityChangeEvent>()
  readonly onDidChangeVisibility: Event<TreeViewVisibilityChangeEvent> =
    this._onDidChangeVisibility.event
  private readonly _onDidChangeSelection = new Emitter<TreeViewSelectionChangeEvent<unknown>>()
  readonly onDidChangeSelection: Event<TreeViewSelectionChangeEvent<unknown>> =
    this._onDidChangeSelection.event
  private readonly _onDidExpandElement = new Emitter<TreeViewExpansionChangeEvent<unknown>>()
  readonly onDidExpandElement: Event<TreeViewExpansionChangeEvent<unknown>> =
    this._onDidExpandElement.event
  private readonly _onDidCollapseElement = new Emitter<TreeViewExpansionChangeEvent<unknown>>()
  readonly onDidCollapseElement: Event<TreeViewExpansionChangeEvent<unknown>> =
    this._onDidCollapseElement.event

  constructor(private readonly _onDispose: () => void) {}

  get visible(): boolean {
    return this._visible
  }

  get selection(): readonly unknown[] {
    return this._selection
  }

  acceptVisibility(visible: boolean): void {
    if (this._disposed || this._visible === visible) return
    this._visible = visible
    this._onDidChangeVisibility.fire({ visible })
  }

  acceptSelection(selection: readonly unknown[]): void {
    if (this._disposed) return
    this._selection = selection
    this._onDidChangeSelection.fire({ selection })
  }

  acceptExpansion(element: unknown, expanded: boolean): void {
    if (this._disposed) return
    ;(expanded ? this._onDidExpandElement : this._onDidCollapseElement).fire({ element })
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._onDispose()
    this._onDidChangeVisibility.dispose()
    this._onDidChangeSelection.dispose()
    this._onDidExpandElement.dispose()
    this._onDidCollapseElement.dispose()
  }
}

export class HostTreeViewRegistry {
  private readonly _views = new Map<string, IRegisteredView>()

  constructor(
    private readonly _mainThread: IMainThreadTreeViews,
    /**
     * Extension-host command routing (local extension handler, built-in
     * fallback forwarded to the renderer). Tree commands run through it so
     * the extension handler gets the original element / arguments.
     */
    private readonly _executeCommand: (command: string, args: unknown[]) => Promise<unknown> = () =>
      Promise.resolve(),
    private readonly _refreshDebounceMs: number = REFRESH_DEBOUNCE_MS,
  ) {}

  registerTreeDataProvider(viewId: string, provider: TreeDataProvider<unknown>): Disposable {
    if (this._views.has(viewId)) {
      throw new Error(`a tree data provider is already registered for view: ${viewId}`)
    }
    const entry: IRegisteredView = {
      provider,
      changeListener: undefined,
      elementByHandle: new Map(),
      handleByElement: new Map(),
      handleByKey: new Map(),
      keyByHandle: new Map(),
      pageChildren: new Map(),
      pageByHandle: new Map(),
      commandByHandle: new Map(),
      nextHandle: 1,
      pending: undefined,
      pendingTimer: undefined,
    }
    entry.changeListener = provider.onDidChangeTreeData?.((element) =>
      this._scheduleRefresh(viewId, entry, element),
    )
    this._views.set(viewId, entry)
    console.info(`[ext-host] tree data provider registered: ${viewId}`)
    void this._mainThread.$registerTreeDataProvider(viewId)
    return {
      dispose: () => this._unregister(viewId),
    }
  }

  createTreeView(viewId: string, options: TreeViewOptions<unknown>): TreeView<unknown> {
    const registration = this.registerTreeDataProvider(viewId, options.treeDataProvider)
    const view = new HostTreeView(() => registration.dispose())
    const entry = this._views.get(viewId)
    if (entry) entry.view = view
    return view
  }

  /** IExtHostTreeViews.$getChildren */
  async getChildren(viewId: string, parentHandle?: number): Promise<ITreeItemDto[]> {
    const entry = this._views.get(viewId)
    if (!entry) {
      console.warn(`[ext-host] $getChildren for unregistered tree view: ${viewId}`)
      return []
    }
    let parent: unknown
    // `!= null` keeps an explicitly-cast null on the roots path as well.
    if (parentHandle != null) {
      parent = entry.elementByHandle.get(parentHandle)
      if (parent === undefined) {
        // The handle was recycled (its element left the tree), so the renderer
        // is already re-pulling that page: an empty answer, not an error.
        return []
      }
    }
    const children = (await entry.provider.getChildren(parent)) ?? []
    // Batched, not serialized: 500 children used to mean 500 sequential awaits.
    const items = await Promise.all(children.map((child) => entry.provider.getTreeItem(child)))
    const page = parentHandle ?? ROOT_PAGE
    const taken = new Set<string>()
    const used = new Set<number>()
    const dtos: ITreeItemDto[] = []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const item = items[i]
      if (item === undefined) continue
      const handle = this._bind(entry, page, child, item, taken, used)
      if (item.command !== undefined) entry.commandByHandle.set(handle, item.command)
      else entry.commandByHandle.delete(handle)
      dtos.push(this._toDto(handle, item))
    }
    const handles = dtos.map((dto) => dto.handle)
    this._recyclePage(entry, page, handles)
    entry.pageChildren.set(page, handles)
    for (const handle of handles) entry.pageByHandle.set(handle, page)
    return dtos
  }

  /** IExtHostTreeViews.$executeTreeItemCommand */
  async executeTreeItemCommand(viewId: string, handle: number, commandId?: string): Promise<void> {
    const entry = this._views.get(viewId)
    if (!entry) return
    const element = entry.elementByHandle.get(handle)
    if (element === undefined) {
      // Same recycled-handle contract as $getChildren: the row is gone from
      // the host's table, so dropping the click is correct.
      console.debug(
        `[ext-host] $executeTreeItemCommand(${viewId}, ${handle}) ignored: stale handle`,
      )
      return
    }
    // Only a real command id means "menu pick"; undefined (and a defensively
    // tolerated null) means "row click".
    if (commandId != null) {
      // view/item/context menu: vscode hands the extension handler the tree
      // element itself, not the serialized DTO.
      await this._executeCommand(commandId, [element])
      return
    }
    const command = entry.commandByHandle.get(handle)
    if (command === undefined || command.disabled === true) return
    await this._executeCommand(command.command, command.arguments ?? [element])
  }

  /** IExtHostTreeViews.$acceptTreeViewVisibility */
  acceptVisibility(viewId: string, visible: boolean): void {
    this._views.get(viewId)?.view?.acceptVisibility(visible)
  }

  /** IExtHostTreeViews.$acceptSelection */
  acceptSelection(viewId: string, handles: number[]): void {
    const entry = this._views.get(viewId)
    if (!entry?.view) return
    const selection: unknown[] = []
    for (const handle of handles) {
      const element = entry.elementByHandle.get(handle)
      if (element !== undefined) selection.push(element)
    }
    entry.view.acceptSelection(selection)
  }

  /** IExtHostTreeViews.$acceptExpansionState */
  acceptExpansionState(viewId: string, handle: number, expanded: boolean): void {
    const entry = this._views.get(viewId)
    const element = entry?.elementByHandle.get(handle)
    if (element === undefined) return
    entry?.view?.acceptExpansion(element, expanded)
  }

  dispose(): void {
    for (const viewId of [...this._views.keys()]) {
      this._unregister(viewId)
    }
  }

  private _unregister(viewId: string): void {
    const entry = this._views.get(viewId)
    if (!entry) return
    this._views.delete(viewId)
    entry.changeListener?.dispose()
    if (entry.pendingTimer !== undefined) clearTimeout(entry.pendingTimer)
    entry.pendingTimer = undefined
    entry.pending = undefined
    entry.elementByHandle.clear()
    entry.handleByElement.clear()
    entry.handleByKey.clear()
    entry.keyByHandle.clear()
    entry.pageChildren.clear()
    entry.pageByHandle.clear()
    entry.commandByHandle.clear()
    void this._mainThread.$unregisterTreeDataProvider(viewId)
  }

  // --- refresh -------------------------------------------------------------

  private _scheduleRefresh(viewId: string, entry: IRegisteredView, element: unknown): void {
    const pending = entry.pending ?? { full: false, elements: [] }
    entry.pending = pending
    if (element === undefined || element === null) {
      pending.full = true
    } else if (Array.isArray(element)) {
      if (element.length === 0) pending.full = true
      else pending.elements.push(...(element as unknown[]))
    } else {
      pending.elements.push(element)
    }
    if (entry.pendingTimer !== undefined) return
    entry.pendingTimer = setTimeout(() => {
      entry.pendingTimer = undefined
      void this._flushRefresh(viewId, entry)
    }, this._refreshDebounceMs)
  }

  private async _flushRefresh(viewId: string, entry: IRegisteredView): Promise<void> {
    const pending = entry.pending
    entry.pending = undefined
    if (!pending || this._views.get(viewId) !== entry) return

    if (pending.full) {
      console.debug(`[ext-host] tree refresh (whole view): ${viewId}`)
      void this._mainThread.$refresh(viewId)
      return
    }

    // Re-resolve each changed element against its existing handle: the row
    // itself may have changed (label / icon / command), and the renderer needs
    // the fresh DTO to replace it in place without re-pulling its siblings.
    const seen = new Set<number>()
    const targets: { handle: number; element: unknown }[] = []
    for (const element of pending.elements) {
      const handle = entry.handleByElement.get(element)
      if (handle === undefined) {
        // Never serialized (or already recycled): the renderer has no row for
        // it, so there is nothing to invalidate.
        console.debug(`[ext-host] tree refresh: unknown element ignored in ${viewId}`)
        continue
      }
      if (seen.has(handle)) continue
      seen.add(handle)
      targets.push({ handle, element })
    }
    if (targets.length === 0) return

    const items = await Promise.all(
      targets.map(async ({ handle, element }) => {
        try {
          const item = await entry.provider.getTreeItem(element)
          if (item.command !== undefined) entry.commandByHandle.set(handle, item.command)
          else entry.commandByHandle.delete(handle)
          return this._toDto(handle, item)
        } catch (err) {
          console.warn(
            `[ext-host] getTreeItem failed while refreshing ${viewId}#${handle}: ${(err as Error).message}`,
          )
          return undefined
        }
      }),
    )
    const dtos = items.filter((dto): dto is ITreeItemDto => dto !== undefined)
    if (dtos.length === 0 || this._views.get(viewId) !== entry) return
    console.debug(
      `[ext-host] tree refresh (subtrees): ${viewId} handles=${dtos.map((d) => d.handle).join(',')}`,
    )
    void this._mainThread.$refresh(viewId, dtos)
  }

  // --- handle table --------------------------------------------------------

  /**
   * Identity a handle is allocated against, tried in VSCode's order of
   * strength:
   *
   * 1. `TreeItem.id` — the provider's explicit row identity.
   * 2. The element object itself, when it is still on the same page. Providers
   *    that hand back the same instances survive a rename this way.
   * 3. The label under the parent *handle* (not the parent's key), deduped per
   *    page — providers that rebuild their element objects on every pull (the
   *    common case) keep their handles as long as the label is stable, and a
   *    parent's own rename never invalidates its children's keys.
   */
  private _bind(
    entry: IRegisteredView,
    page: number,
    element: unknown,
    item: TreeItem,
    taken: Set<string>,
    used: Set<number>,
  ): number {
    const key = this._stableKey(page, item, taken)
    taken.add(key)
    let handle = entry.handleByKey.get(key)
    if (handle !== undefined && used.has(handle)) handle = undefined
    if (handle === undefined && item.id === undefined) {
      const byElement = entry.handleByElement.get(element)
      if (
        byElement !== undefined &&
        !used.has(byElement) &&
        entry.pageByHandle.get(byElement) === page
      ) {
        handle = byElement
        const previousKey = entry.keyByHandle.get(handle)
        if (previousKey !== undefined) entry.handleByKey.delete(previousKey)
        entry.handleByKey.set(key, handle)
        entry.keyByHandle.set(handle, key)
      }
    }
    if (handle === undefined) {
      handle = entry.nextHandle++
      entry.handleByKey.set(key, handle)
      entry.keyByHandle.set(handle, key)
    }
    used.add(handle)
    const previous = entry.elementByHandle.get(handle)
    if (previous !== undefined && previous !== element) entry.handleByElement.delete(previous)
    entry.elementByHandle.set(handle, element)
    entry.handleByElement.set(element, handle)
    return handle
  }

  private _stableKey(page: number, item: TreeItem, taken: ReadonlySet<string>): string {
    if (item.id !== undefined) return `#${item.id}`
    const base = `${page}/${labelOf(item).replace(/\//g, '//')}`
    if (!taken.has(base)) return base
    let n = 1
    while (taken.has(`${base}~${n}`)) n++
    return `${base}~${n}`
  }

  /** Drop the handles a page no longer returns, along with their subtrees. */
  private _recyclePage(entry: IRegisteredView, page: number, next: readonly number[]): void {
    const previous = entry.pageChildren.get(page)
    if (!previous) return
    const kept = new Set(next)
    for (const handle of previous) {
      if (!kept.has(handle)) this._recycle(entry, handle)
    }
  }

  private _recycle(entry: IRegisteredView, handle: number): void {
    const children = entry.pageChildren.get(handle)
    if (children) {
      entry.pageChildren.delete(handle)
      for (const child of children) this._recycle(entry, child)
    }
    const element = entry.elementByHandle.get(handle)
    if (element !== undefined) entry.handleByElement.delete(element)
    entry.elementByHandle.delete(handle)
    entry.commandByHandle.delete(handle)
    entry.pageByHandle.delete(handle)
    const key = entry.keyByHandle.get(handle)
    if (key !== undefined) {
      entry.keyByHandle.delete(handle)
      entry.handleByKey.delete(key)
    }
  }

  private _toDto(handle: number, item: TreeItem): ITreeItemDto {
    return {
      handle,
      label: labelOf(item),
      collapsibleState: (item.collapsibleState ?? 0) as 0 | 1 | 2,
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.tooltip !== undefined ? { tooltip: item.tooltip } : {}),
      ...(item.contextValue !== undefined ? { contextValue: item.contextValue } : {}),
      ...(item.iconPath !== undefined ? { iconId: item.iconPath } : {}),
      ...(item.resourceUri !== undefined ? { resourceUri: reviveWireUri(item.resourceUri) } : {}),
      // Only the display surface crosses the wire: `arguments` stay host-side
      // in `commandByHandle`, so live objects (Uri, custom payloads) never get
      // flattened before the handler sees them (tree click re-runs host-side).
      ...(item.command !== undefined ? { command: toCommandDto(item.command, ['disabled']) } : {}),
    }
  }
}
