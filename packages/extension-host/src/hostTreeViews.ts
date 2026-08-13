/**
 * Host-side registry backing `window.registerTreeDataProvider` /
 * `window.createTreeView`. Providers are keyed by view id (the manifest
 * `contributes.views` id); children pulls come back through
 * `IExtHostTreeViews.$getChildren`, and interaction callbacks (visibility /
 * selection / expansion) feed the `TreeView` facade's events.
 *
 * Elements never cross the wire: each view keeps a numeric handle table
 * (element ↔ handle) handed out as children are serialized. A provider's
 * `onDidChangeTreeData` invalidates the WHOLE table and `$refresh`es the view
 * (first cut — no per-subtree refresh), so a stale handle from the renderer is
 * tolerated as an empty result rather than an error.
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
import type {
  ICommandDto,
  IMainThreadTreeViews,
  ITreeItemDto,
} from '@universe-editor/extensions-common'

interface IRegisteredView {
  readonly provider: TreeDataProvider<unknown>
  changeListener: Disposable | undefined
  readonly elementByHandle: Map<number, unknown>
  readonly handleByElement: Map<unknown, number>
  /**
   * The `TreeItem.command` the provider returned for each handle, kept
   * host-side so a row click can execute it against the original arguments —
   * live objects (Uri instances, custom payloads) must never ride the wire.
   * Lives + dies with the same generation as `elementByHandle`.
   */
  readonly commandByHandle: Map<number, Command>
  nextHandle: number
  /** Facade created by `createTreeView`; absent for a bare `registerTreeDataProvider`. */
  view?: HostTreeView
}

function toCommandDto(cmd: {
  command: string
  title: string
  tooltip?: string
  disabled?: boolean
}): ICommandDto {
  // Only the display surface crosses the wire. `arguments` stay host-side in
  // the registry's commandByHandle table — serializing them would flatten
  // live objects (Uri, custom payloads) before the handler ever sees them.
  return {
    command: cmd.command,
    title: cmd.title,
    ...(cmd.tooltip !== undefined ? { tooltip: cmd.tooltip } : {}),
    ...(cmd.disabled !== undefined ? { disabled: cmd.disabled } : {}),
  }
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
      commandByHandle: new Map(),
      nextHandle: 1,
    }
    entry.changeListener = provider.onDidChangeTreeData?.(() => {
      // First cut: any change invalidates the whole view. Handles die with the
      // table; the renderer re-pulls from the roots.
      entry.elementByHandle.clear()
      entry.handleByElement.clear()
      entry.commandByHandle.clear()
      void this._mainThread.$refresh(viewId)
    })
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
    // `== null`: the wire is newline-JSON, so an omitted/undefined parentHandle
    // can arrive as null — both mean "the roots".
    if (parentHandle != null) {
      parent = entry.elementByHandle.get(parentHandle)
      if (parent === undefined) {
        // Stale handle from before a refresh — the renderer is already
        // re-pulling the roots, so an empty page is the right answer.
        return []
      }
    }
    const children = (await entry.provider.getChildren(parent)) ?? []
    const dtos: ITreeItemDto[] = []
    for (const child of children) {
      const item = await entry.provider.getTreeItem(child)
      const dto = this._toDto(entry, child, item)
      if (item.command !== undefined) entry.commandByHandle.set(dto.handle, item.command)
      dtos.push(dto)
    }
    return dtos
  }

  /** IExtHostTreeViews.$executeTreeItemCommand */
  async executeTreeItemCommand(viewId: string, handle: number, commandId?: string): Promise<void> {
    const entry = this._views.get(viewId)
    if (!entry) return
    const element = entry.elementByHandle.get(handle)
    if (element === undefined) {
      // Same stale-handle contract as $getChildren: the renderer is already
      // re-pulling the dead generation, so dropping the click is correct.
      console.debug(
        `[ext-host] $executeTreeItemCommand(${viewId}, ${handle}) ignored: stale handle`,
      )
      return
    }
    // `!= null`: an omitted commandId crosses the newline-JSON wire as null —
    // both mean "row click", only a real command id means "menu pick".
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
    entry.elementByHandle.clear()
    entry.handleByElement.clear()
    entry.commandByHandle.clear()
    void this._mainThread.$unregisterTreeDataProvider(viewId)
  }

  private _handleFor(entry: IRegisteredView, element: unknown): number {
    const existing = entry.handleByElement.get(element)
    if (existing !== undefined) return existing
    const handle = entry.nextHandle++
    entry.handleByElement.set(element, handle)
    entry.elementByHandle.set(handle, element)
    return handle
  }

  private _toDto(entry: IRegisteredView, element: unknown, item: TreeItem): ITreeItemDto {
    return {
      handle: this._handleFor(entry, element),
      label: typeof item.label === 'string' ? item.label : item.label.label,
      collapsibleState: (item.collapsibleState ?? 0) as 0 | 1 | 2,
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.tooltip !== undefined ? { tooltip: item.tooltip } : {}),
      ...(item.contextValue !== undefined ? { contextValue: item.contextValue } : {}),
      ...(item.iconPath !== undefined ? { iconId: item.iconPath } : {}),
      ...(item.resourceUri !== undefined ? { resourceUri: item.resourceUri.toJSON() } : {}),
      ...(item.command !== undefined ? { command: toCommandDto(item.command) } : {}),
    }
  }
}
