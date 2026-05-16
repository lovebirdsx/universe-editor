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
  IWorkspaceService,
  URI,
} from '@universe-editor/platform'

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
  private _root: URI | null = null
  private readonly _nodes = new Map<string, NodeState>()
  private _selected: URI | null = null

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileService private readonly _fileService: IFileService,
    @IFileWatcherService private readonly _watcher: IFileWatcherService,
  ) {
    super()
    this._setRoot(this._workspace.current?.folder ?? null)
    this._register(this._workspace.onDidChangeWorkspace((w) => this._setRoot(w?.folder ?? null)))
    this._register(this._watcher.onDidChangeFiles((events) => this._onWatcherEvents(events)))
  }

  get root(): URI | null {
    return this._root
  }

  get selectedResource(): URI | null {
    return this._selected
  }

  setSelection(resource: URI | null): void {
    const before = this._selected?.toString()
    const after = resource?.toString()
    if (before === after) return
    this._selected = resource
    this._onDidChange.fire()
  }

  /**
   * Expand every ancestor of `target`, set it as the selected node, and fire a
   * dom event so the row can scroll into view. Returns false when there is no
   * workspace open or the target lies outside it.
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
    this._selected = target
    this._onDidChange.fire()
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('explorer:reveal', { detail: target.toString() }))
    }
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
      throw new Error(`A file or folder named "${name}" already exists.`)
    }
    await this._fileService.writeFile(target, '')
    await this.refresh(parent)
    return target
  }

  async createFolder(parent: URI, name: string): Promise<URI> {
    const target = URI.joinPath(parent, name)
    if (await this._fileService.exists(target)) {
      throw new Error(`A file or folder named "${name}" already exists.`)
    }
    await this._fileService.createDirectory(target)
    await this.refresh(parent)
    return target
  }

  async rename(source: URI, newName: string): Promise<URI> {
    const parent = parentOf(source)
    if (!parent) throw new Error('Cannot rename the workspace root.')
    const target = URI.joinPath(parent, newName)
    await this._fileService.rename(source, target, { overwrite: false })
    this._nodes.delete(source.toString())
    await this.refresh(parent)
    return target
  }

  async delete(target: URI, opts?: { recursive?: boolean }): Promise<void> {
    await this._fileService.delete(target, opts)
    const parent = parentOf(target)
    this._nodes.delete(target.toString())
    if (parent) {
      await this.refresh(parent)
    } else {
      this._onDidChange.fire()
    }
  }

  private _setRoot(root: URI | null): void {
    this._root = root
    this._nodes.clear()
    this._selected = null
    if (root) {
      const node = this._ensureNode(root)
      node.expanded = true
      void this._loadChildren(root, node).then(() => this._onDidChange.fire())
      void this._watcher.watch(root.toJSON()).catch(() => {
        // Watcher failures are non-fatal: the tree still works, just no auto-refresh.
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
    } catch (err) {
      node.children = []
      node.error = err instanceof Error ? err.message : String(err)
    } finally {
      node.loading = false
    }
  }
}

function parentOf(resource: URI): URI | null {
  const path = resource.path
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return null
  const parentPath = path.slice(0, slash)
  return URI.from({
    scheme: resource.scheme,
    authority: resource.authority,
    path: parentPath,
  })
}

function isDescendant(root: URI, target: URI): boolean {
  if (root.scheme !== target.scheme) return false
  if (root.authority !== target.authority) return false
  const rootPath = root.path.endsWith('/') ? root.path : root.path + '/'
  const targetPath = target.path
  return targetPath === root.path || targetPath.startsWith(rootPath)
}
