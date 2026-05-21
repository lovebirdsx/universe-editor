/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerTreeService — workspace-folder-rooted lazy tree backed by IFileService.
 *
 *  Holds expansion state and child-entry caches keyed by URI. CRUD operations
 *  delegate to IFileService and invalidate the affected parent. Tree state is
 *  not persisted — switching workspace folders drops everything and starts over.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  createDecorator,
  type Event,
  type IDirectoryEntry,
  type IFileChangeEvent,
  IFileService,
  IFileWatcherService,
  ILoggerService,
  IWorkspaceService,
  NullLogger,
  URI,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
} from '@universe-editor/platform'
import { dedupe, isDescendant, parentOf, sameUri, sameUriList } from './explorerTreeUtils.js'

export interface IExplorerEntry {
  readonly resource: URI
  readonly name: string
  readonly isDirectory: boolean
}

export const IExplorerTreeService = createDecorator<ExplorerTreeService>('explorerTreeService')

interface NodeState {
  expanded: boolean
  children: IExplorerEntry[] | null
  loading: boolean
  error: string | null
}

function sortEntries(entries: readonly IDirectoryEntry[], parent: URI): IExplorerEntry[] {
  return entries
    .map((e) => ({
      resource: URI.joinPath(parent, e.name),
      name: e.name,
      isDirectory: e.isDirectory,
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
}

export class ExplorerTreeService extends Disposable {
  declare readonly _serviceBrand: undefined
  private _root: URI | null = null
  private readonly _nodes = new Map<string, NodeState>()
  private _selection: URI[] = []
  private _focused: URI | null = null
  private _activeEditorResource: URI | null = null
  private readonly _logger: ILogger

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileService private readonly _fileService: IFileService,
    @IFileWatcherService private readonly _watcher: IFileWatcherService,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'explorer', name: 'Explorer' }) ?? new NullLogger()
    this._setRoot(this._workspace.current?.folder ?? null)
    this._register(this._workspace.onDidChangeWorkspace((w) => this._setRoot(w?.folder ?? null)))
    this._register(this._watcher.onDidChangeFiles((events) => this._onWatcherEvents(events)))
  }

  get root(): URI | null {
    return this._root
  }

  get selection(): readonly URI[] {
    return this._selection
  }

  get focused(): URI | null {
    return this._focused
  }

  get activeEditorResource(): URI | null {
    return this._activeEditorResource
  }

  /**
   * Back-compat single-resource getter. Returns the focused row when present,
   * otherwise the first of the multi-selection. New code should consult
   * `focused` / `selection` directly.
   */
  get selectedResource(): URI | null {
    return this._focused ?? this._selection[0] ?? null
  }

  /**
   * Parent of `resource` inside the workspace, or null when `resource` is the
   * root (or lives outside the workspace).
   */
  getParent(resource: URI): URI | null {
    if (!this._root) return null
    if (resource.toString() === this._root.toString()) return null
    const parent = parentOf(resource)
    if (!parent) return null
    if (!isDescendant(this._root, parent) && parent.toString() !== this._root.toString()) {
      return null
    }
    return parent
  }

  /**
   * Flat, top-to-bottom list of every node currently rendered in the tree,
   * including the workspace root. Used by keyboard navigation to compute
   * up/down/home/end targets.
   */
  getVisibleEntries(): IExplorerEntry[] {
    if (!this._root) return []
    const out: IExplorerEntry[] = []
    out.push({ resource: this._root, name: '', isDirectory: true })
    this._collectVisible(this._root, out)
    return out
  }

  private _collectVisible(parent: URI, acc: IExplorerEntry[]): void {
    const node = this._nodes.get(parent.toString())
    if (!node || !node.expanded || !node.children) return
    for (const child of node.children) {
      acc.push(child)
      if (child.isDirectory) this._collectVisible(child.resource, acc)
    }
  }

  setSelection(resources: readonly URI[] | URI | null, focus?: URI | null): void {
    const list =
      resources == null ? [] : Array.isArray(resources) ? dedupe(resources) : [resources as URI]
    const newFocus =
      focus === undefined ? (list.length > 0 ? (list[list.length - 1] ?? null) : null) : focus
    if (sameUriList(this._selection, list) && sameUri(this._focused, newFocus)) return
    this._selection = list
    this._focused = newFocus
    this._onDidChange.fire()
    if (newFocus) this._fireReveal(newFocus)
  }

  setFocus(resource: URI | null): void {
    if (sameUri(this._focused, resource)) return
    this._focused = resource
    this._onDidChange.fire()
    if (resource) this._fireReveal(resource)
  }

  /** Ctrl/Cmd+Click semantics: add when absent, remove when present. */
  toggleInSelection(resource: URI): void {
    const key = resource.toString()
    const idx = this._selection.findIndex((u) => u.toString() === key)
    this._selection =
      idx >= 0 ? this._selection.filter((_, i) => i !== idx) : [...this._selection, resource]
    this._focused = resource
    this._onDidChange.fire()
    this._fireReveal(resource)
  }

  /** Shift+Click semantics: replace selection with the inclusive range between anchor and target in the visible-rows order. */
  selectRange(anchor: URI, target: URI): void {
    const visible = this.getVisibleEntries()
    const aIdx = visible.findIndex((e) => e.resource.toString() === anchor.toString())
    const tIdx = visible.findIndex((e) => e.resource.toString() === target.toString())
    if (aIdx < 0 || tIdx < 0) {
      this.setSelection([target], target)
      return
    }
    const [lo, hi] = aIdx <= tIdx ? [aIdx, tIdx] : [tIdx, aIdx]
    this._selection = visible.slice(lo, hi + 1).map((e) => e.resource)
    this._focused = target
    this._onDidChange.fire()
    this._fireReveal(target)
  }

  setActiveEditorResource(resource: URI | null): void {
    if (sameUri(this._activeEditorResource, resource)) return
    this._activeEditorResource = resource
    this._onDidChange.fire()
  }

  private _fireReveal(target: URI): void {
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('explorer:reveal', { detail: target.toString() }))
    }
  }

  /**
   * Expand every ancestor of `target`, set it as the focused row + sole selection,
   * and fire a dom event so the row can scroll into view. Returns false when
   * there is no workspace open or the target lies outside it.
   */
  async reveal(target: URI): Promise<boolean> {
    if (!this._root) return false
    if (!isDescendant(this._root, target)) return false
    const chain: URI[] = []
    let cursor: URI | null = parentOf(target)
    while (cursor && cursor.toString() !== this._root.toString()) {
      chain.unshift(cursor)
      cursor = parentOf(cursor)
    }
    chain.unshift(this._root)
    for (const dir of chain) {
      await this.expand(dir)
    }
    this._selection = [target]
    this._focused = target
    this._onDidChange.fire()
    this._fireReveal(target)
    return true
  }

  /** Synchronous snapshot of a node. Returns a fresh default state for unknown URIs. */
  getNode(resource: URI): NodeState {
    return (
      this._nodes.get(resource.toString()) ?? {
        expanded: false,
        children: null,
        loading: false,
        error: null,
      }
    )
  }

  isExpanded(resource: URI): boolean {
    return this._nodes.get(resource.toString())?.expanded ?? false
  }

  getChildren(resource: URI): readonly IExplorerEntry[] | null {
    return this._nodes.get(resource.toString())?.children ?? null
  }

  async expand(resource: URI): Promise<void> {
    const node = this._ensureNode(resource)
    node.expanded = true
    if (node.children === null && !node.loading) {
      await this._loadChildren(resource, node)
    }
    this._onDidChange.fire()
  }

  collapse(resource: URI): void {
    const node = this._nodes.get(resource.toString())
    if (!node) return
    node.expanded = false
    this._onDidChange.fire()
  }

  async toggle(resource: URI): Promise<void> {
    if (this.isExpanded(resource)) {
      this.collapse(resource)
    } else {
      await this.expand(resource)
    }
  }

  /** Force re-read of a directory's entries, keeping its expanded state. */
  async refresh(resource: URI): Promise<void> {
    const node = this._ensureNode(resource)
    await this._loadChildren(resource, node)
    this._onDidChange.fire()
  }

  async createFile(parent: URI, name: string): Promise<URI> {
    const target = URI.joinPath(parent, name)
    if (await this._fileService.exists(target)) {
      this._logger.warn(`createFile exists ${target.toString()}`)
      throw new Error(`A file or folder named "${name}" already exists.`)
    }
    try {
      await this._fileService.writeFile(target, '')
      await this.refresh(parent)
      this._logger.info(`createFile ${target.toString()}`)
      return target
    } catch (err) {
      this._logger.error(`createFile failed ${target.toString()}`, err)
      throw err
    }
  }

  async createFolder(parent: URI, name: string): Promise<URI> {
    const target = URI.joinPath(parent, name)
    if (await this._fileService.exists(target)) {
      this._logger.warn(`createFolder exists ${target.toString()}`)
      throw new Error(`A file or folder named "${name}" already exists.`)
    }
    try {
      await this._fileService.createDirectory(target)
      await this.refresh(parent)
      this._logger.info(`createFolder ${target.toString()}`)
      return target
    } catch (err) {
      this._logger.error(`createFolder failed ${target.toString()}`, err)
      throw err
    }
  }

  async rename(source: URI, newName: string): Promise<URI> {
    const parent = parentOf(source)
    if (!parent) throw new Error('Cannot rename the workspace root.')
    const target = URI.joinPath(parent, newName)
    try {
      await this._fileService.rename(source, target, { overwrite: false })
      this._nodes.delete(source.toString())
      await this.refresh(parent)
      this._logger.info(`rename ${source.toString()} -> ${target.toString()}`)
      return target
    } catch (err) {
      this._logger.error(`rename failed ${source.toString()} -> ${target.toString()}`, err)
      throw err
    }
  }

  async delete(target: URI, opts?: { recursive?: boolean }): Promise<void> {
    try {
      await this._fileService.delete(target, opts)
      const parent = parentOf(target)
      this._nodes.delete(target.toString())
      if (parent) {
        await this.refresh(parent)
      } else {
        this._onDidChange.fire()
      }
      this._logger.info(`delete ${target.toString()} recursive=${opts?.recursive === true}`)
    } catch (err) {
      this._logger.error(`delete failed ${target.toString()}`, err)
      throw err
    }
  }

  private _setRoot(root: URI | null): void {
    this._logger.info(`setRoot ${root?.toString() ?? '<none>'}`)
    this._root = root
    this._nodes.clear()
    this._selection = []
    this._focused = null
    this._activeEditorResource = null
    if (root) {
      const node = this._ensureNode(root)
      node.expanded = true
      void this._loadChildren(root, node).then(() => this._onDidChange.fire())
      void this._watcher.watch(root.toJSON()).catch(() => {
        // Watcher failures are non-fatal: the tree still works, just no auto-refresh.
        this._logger.warn(`watch failed ${root.toString()}`)
      })
    } else {
      void this._watcher.unwatch().catch(() => {})
    }
    this._onDidChange.fire()
  }

  private _onWatcherEvents(events: readonly IFileChangeEvent[]): void {
    if (!this._root || events.length === 0) return
    const seen = new Set<string>()
    for (const ev of events) {
      const resource = URI.revive(ev.resource)
      if (!resource) continue
      const parent = parentOf(resource)
      if (!parent) continue
      const key = parent.toString()
      if (seen.has(key)) continue
      if (!this._nodes.has(key)) continue
      seen.add(key)
      void this.refresh(parent)
    }
    if (seen.size > 0) {
      this._logger.debug(`watcher refresh parents=${seen.size} events=${events.length}`)
    }
  }

  private _ensureNode(resource: URI): NodeState {
    const key = resource.toString()
    let node = this._nodes.get(key)
    if (!node) {
      node = { expanded: false, children: null, loading: false, error: null }
      this._nodes.set(key, node)
    }
    return node
  }

  private async _loadChildren(resource: URI, node: NodeState): Promise<void> {
    node.loading = true
    node.error = null
    try {
      const entries = await this._fileService.list(resource)
      node.children = sortEntries(entries, resource)
      this._logger.debug(`loadChildren ${resource.toString()} entries=${node.children.length}`)
    } catch (err) {
      node.children = []
      node.error = err instanceof Error ? err.message : String(err)
      this._logger.warn(`loadChildren failed ${resource.toString()}`, node.error)
    } finally {
      node.loading = false
    }
  }
}
