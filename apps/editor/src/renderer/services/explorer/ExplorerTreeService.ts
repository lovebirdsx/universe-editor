/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerTreeService — workspace-folder-rooted lazy tree backed by IFileService.
 *
 *  Holds child-entry caches keyed by URI and orchestrates IFileService /
 *  IFileWatcherService / IExcludeService. The generic tree state (expansion,
 *  selection, focus, visible-row flattening, reveal) is delegated to the shared
 *  workbench-ui TreeModel; this service adapts it to URIs and owns the
 *  file-system specifics (lazy loading, CRUD, watcher refresh, exclude filter).
 *  Expansion state is persisted per workspace-root (see explorerTreeState) and
 *  restored on `_setRoot`; selection / focus / scroll are still dropped on a
 *  workspace switch.
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
  IStorageService,
  IWorkspaceService,
  StorageScope,
  URI,
  createNamedLogger,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
} from '@universe-editor/platform'
import { TreeModel, type ITreeDataSource } from '@universe-editor/workbench-ui'
import {
  flushExpandedIdsWrite,
  lastAcceptedExpandedIds,
  persistExpandedIds,
  sameIds,
  storageKeyForRoot,
  type ExplorerTreePersistedState,
} from './explorerTreeState.js'
import {
  dedupe,
  isDescendant,
  normalizeUri,
  parentOf,
  relativeTo,
  sameUri,
} from './explorerTreeUtils.js'
import { IExcludeService } from '../exclude/ExcludeService.js'
import { IFocusScopeService } from '../focus/FocusScopeService.js'
import { basenameOf, incrementFileName, targetInDirectory } from './explorerFileOperations.js'
import { IFileClipboardService } from '../../../shared/ipc/fileClipboardService.js'

export interface IExplorerEntry {
  readonly resource: URI
  readonly name: string
  readonly isDirectory: boolean
  readonly isSymbolicLink?: boolean
  readonly compactName?: string
  /** The topmost directory in the compact chain — used as drag source. */
  readonly compactRoot?: URI
}

export const IExplorerTreeService = createDecorator<ExplorerTreeService>('explorerTreeService')

export interface IExplorerResourceOperation {
  readonly resource: URI
  readonly isDirectory: boolean
}

/** A file/folder that was renamed or moved (rename and move share this shape). */
export interface IFileRenameOperation {
  readonly oldUri: URI
  readonly newUri: URI
  readonly isDirectory: boolean
}

interface NodeState {
  children: IExplorerEntry[] | null
  loading: boolean
  error: string | null
}

function basename(resource: URI): string {
  return basenameOf(resource)
}

function sortEntries(entries: readonly IDirectoryEntry[], parent: URI): IExplorerEntry[] {
  return entries
    .map((e) => ({
      resource: URI.joinPath(parent, e.name),
      name: e.name,
      isDirectory: e.isDirectory,
      ...(e.isSymbolicLink ? { isSymbolicLink: true } : {}),
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
  private _activeEditorResource: URI | null = null
  private _clipboardResources: readonly IExplorerResourceOperation[] = []
  private _clipboardIsCut = false
  private readonly _logger: ILogger
  // Cold start defers arming the recursive watcher until startWatching() is
  // called (WorkbenchPhase.Eventually). IWorkspaceService.current is hydrated
  // asynchronously over IPC, so the very first onDidChangeWorkspace firing
  // (not just the constructor's synchronous read) is still "cold start" and
  // must be deferred too — but only up until IWorkspaceService.whenReady
  // resolves. A user opening a folder into an empty window (or any workspace
  // switch) after that point is a genuine runtime action, not cold start, and
  // must sync immediately even if startWatching() hasn't fired yet.
  private _watchStarted = false
  private _coldStartSettled = false
  // Expansion-persistence orchestration (explorerTreeState). `_restoreGeneration`
  // tokens an in-flight restore so a `_setRoot` mid-restore abandons the stale
  // pass instead of re-expanding the old root's directories under the new one.
  // `_restoring` suppresses the onDidChangeExpansion → persist echo while a
  // restore replays the persisted set (those flips are not user gestures).
  private _restoreGeneration = 0
  private _restoring = false

  private readonly _dataSource: ITreeDataSource<IExplorerEntry> = {
    getId: (e) => e.resource.toString(),
    hasChildren: (e) => e.isDirectory,
    getChildren: (e) => {
      const raw = this._nodes.get(e.resource.toString())?.children ?? null
      if (!raw) return null
      return this._computeCompactChildren(raw)
    },
    loadChildren: async (e) => {
      const node = this._ensureNode(e.resource)
      await this._loadChildren(e.resource, node)
      await Promise.all(
        (node.children ?? [])
          .filter((c) => c.isDirectory)
          .map((c) => this._eagerLoadForCompact(c.resource)),
      )
    },
    getRoots: () => (this._root ? [this._rootEntry(this._root)] : []),
    getParent: (e) => {
      let cursor: URI | null = this.getParent(e.resource)
      while (cursor !== null && this._isSingleDirChild(cursor)) {
        cursor = this.getParent(cursor)
      }
      if (!cursor) return null
      if (this._root && sameUri(cursor, this._root)) return this._rootEntry(this._root)
      return { resource: cursor, name: basename(cursor), isDirectory: true }
    },
  }
  private readonly _model = this._register(
    new TreeModel<IExplorerEntry>({ dataSource: this._dataSource }),
  )

  // Stable mapping of model visible nodes → entries (kept identity-stable so
  // ExplorerView's memo / key reads don't churn between selection changes).
  private _visibleNodesRef: readonly { element: IExplorerEntry }[] | null = null
  private _visibleEntries: readonly IExplorerEntry[] = []

  private readonly _onDidChangeStructure = this._register(new Emitter<void>())
  readonly onDidChangeStructure: Event<void> = this._onDidChangeStructure.event

  private readonly _onDidChangeSelection = this._register(new Emitter<void>())
  readonly onDidChangeSelection: Event<void> = this._onDidChangeSelection.event

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  private readonly _onDidChangeClipboard = this._register(new Emitter<void>())
  readonly onDidChangeClipboard: Event<void> = this._onDidChangeClipboard.event

  private readonly _onReveal = this._register(new Emitter<URI>())
  readonly onReveal: Event<URI> = this._onReveal.event

  // Fired after a rename/move completes on disk, so consumers (e.g. markdown
  // link updating) can react. Batched: moveResources fires one event per call.
  private readonly _onDidRunFileOperation = this._register(
    new Emitter<readonly IFileRenameOperation[]>(),
  )
  readonly onDidRunFileOperation: Event<readonly IFileRenameOperation[]> =
    this._onDidRunFileOperation.event

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileService private readonly _fileService: IFileService,
    @IFileWatcherService private readonly _watcher: IFileWatcherService,
    @IExcludeService private readonly _exclude: IExcludeService,
    @IFocusScopeService private readonly _focus: IFocusScopeService,
    @ILoggerService loggerService: ILoggerServiceType,
    // Optional DI: many unit tests construct the tree without a storage proxy —
    // the container injects undefined then and persistence is simply disabled.
    // Declared as a required `| undefined` param (not `?`) because a trailing
    // optional parameter would break GetLeadingNonServiceArgs and every bare
    // createInstance(ExplorerTreeService) call site.
    @IStorageService private readonly _storage: IStorageService | undefined,
    // Optional DI: tests / early boot may construct the tree before the shared
    // clipboard proxy exists — the container injects undefined then. Declared
    // as a required `| undefined` param (not `?`) because a trailing optional
    // parameter would break GetLeadingNonServiceArgs and every bare
    // createInstance(ExplorerTreeService) call site.
    @IFileClipboardService private readonly _fileClipboard: IFileClipboardService | undefined,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'explorer', name: 'Explorer' })
    this._register(
      this._model.onDidChangeStructure(() => {
        this._onDidChangeStructure.fire()
        this._onDidChange.fire()
      }),
    )
    this._register(
      this._model.onDidChangeSelection(() => {
        this._onDidChangeSelection.fire()
        this._onDidChange.fire()
      }),
    )
    this._register(this._model.onReveal(({ id }) => this._onReveal.fire(URI.parse(id))))
    this._setRoot(this._workspace.current?.folder ?? null)
    this._register(this._workspace.onDidChangeWorkspace((w) => this._setRoot(w?.folder ?? null)))
    void this._workspace.whenReady.then(() => {
      this._coldStartSettled = true
    })
    this._register(this._watcher.onDidChangeFiles((events) => this._onWatcherEvents(events)))
    // Watcher process crash-restart: events during the gap are lost, so
    // re-read everything already loaded to resync the tree.
    this._register(this._watcher.onDidRestart(() => this._refreshLoadedNodes()))
    this._register(this._exclude.onDidChange(() => this._onExcludeChange()))
    // Focus folders narrow which entries survive _loadChildren, and drive which
    // subtrees the watcher subscribes to — both need re-deriving on a change.
    this._register(this._focus.onDidChange(() => this._onFocusChange()))
    // Persist the user's expanded-directory set on every genuine flip, and
    // re-restore when the WORKSPACE-scope backend (re)hydrates — cold start
    // reads the workspace bucket asynchronously over IPC, so the first
    // `_setRoot` restore can run before the bucket is readable; this event is
    // the late-arrival backstop (the `hasState` guard makes it a no-op once
    // the user has touched expansion).
    this._register(
      this._model.onDidChangeExpansion(() => {
        if (!this._restoring) this._persistExpansion()
      }),
    )
    // The scope-change backstop only exists when storage is available (it is
    // absent in some unit tests, where persistence is disabled wholesale).
    if (this._storage) {
      this._register(
        this._storage.onDidChangeWorkspaceScope(() => {
          if (this._root) void this._restoreExpansion(this._root)
        }),
      )
    }
  }

  /** The TreeModel powering this view — consumed directly by ExplorerView's <Tree>. */
  get model(): TreeModel<IExplorerEntry> {
    return this._model
  }

  get root(): URI | null {
    return this._root
  }

  private _rootEntry(root: URI): IExplorerEntry {
    return { resource: root, name: '', isDirectory: true }
  }

  private _leafEntry(resource: URI, isDirectory = false): IExplorerEntry {
    return { resource, name: basename(resource), isDirectory }
  }

  get selection(): readonly URI[] {
    return this._model.selection.map((id) => URI.parse(id))
  }

  get clipboardResources(): readonly IExplorerResourceOperation[] {
    return this._clipboardResources
  }

  get hasClipboard(): boolean {
    return this._clipboardResources.length > 0
  }

  get clipboardIsCut(): boolean {
    return this._clipboardIsCut
  }

  get hasCutItems(): boolean {
    return this._clipboardIsCut && this._clipboardResources.length > 0
  }

  isSelected(resource: URI): boolean {
    return this._model.isSelected(resource.toString())
  }

  isRoot(resource: URI): boolean {
    return this._root !== null && sameUri(this._root, resource)
  }

  isDirectory(resource: URI): boolean {
    if (this.isRoot(resource)) return true
    const entry = this._findKnownEntry(resource)
    return entry?.isDirectory ?? false
  }

  isCut(resource: URI): boolean {
    if (!this.hasCutItems) return false
    return this._clipboardResources.some((entry) => sameUri(entry.resource, resource))
  }

  get focused(): URI | null {
    const id = this._model.focused
    return id ? URI.parse(id) : null
  }

  get activeEditorResource(): URI | null {
    return this._activeEditorResource
  }

  /**
   * Back-compat single-resource getter. Returns the focused row when present,
   * otherwise the first of the multi-selection.
   */
  get selectedResource(): URI | null {
    return this.focused ?? this.selection[0] ?? null
  }

  getContextResources(primary?: URI | null): readonly URI[] {
    const focused = primary ?? this.selectedResource
    const selection = this.selection
    if (focused && selection.some((resource) => sameUri(resource, focused))) {
      return selection
    }
    if (focused) return [focused]
    return selection
  }

  getContextResourceOperations(primary?: URI | null): IExplorerResourceOperation[] {
    return this.getContextResources(primary).map((resource) => ({
      resource,
      isDirectory: this.isDirectory(resource),
    }))
  }

  /**
   * Parent of `resource` inside the workspace, or null when `resource` is the
   * root (or lives outside the workspace).
   */
  getParent(resource: URI): URI | null {
    if (!this._root) return null
    if (sameUri(resource, this._root)) return null
    const parent = parentOf(resource)
    if (!parent) return null
    if (!isDescendant(this._root, parent) && !sameUri(parent, this._root)) {
      return null
    }
    return parent
  }

  /**
   * Flat, top-to-bottom list of every node currently rendered in the tree,
   * including the workspace root. Identity-stable across selection changes.
   */
  getVisibleEntries(): readonly IExplorerEntry[] {
    const nodes = this._model.getVisibleNodes()
    if (nodes !== this._visibleNodesRef) {
      this._visibleNodesRef = nodes
      this._visibleEntries = nodes.map((n) => n.element)
    }
    return this._visibleEntries
  }

  setSelection(resources: readonly URI[] | URI | null, focus?: URI | null): void {
    const list = resources == null ? [] : Array.isArray(resources) ? resources : [resources as URI]
    const ids = list.map((u) => u.toString())
    if (focus === undefined) this._model.setSelection(ids)
    else this._model.setSelection(ids, focus === null ? null : focus.toString())
  }

  setFocus(resource: URI | null): void {
    this._model.setFocus(resource ? resource.toString() : null)
  }

  /** Ctrl/Cmd+Click semantics: add when absent, remove when present. */
  toggleInSelection(resource: URI): void {
    this._model.toggleInSelection(resource.toString())
  }

  /** Shift+Click semantics: inclusive range between anchor and target in visible order. */
  selectRange(anchor: URI, target: URI): void {
    this._model.selectRange(anchor.toString(), target.toString())
  }

  setActiveEditorResource(resource: URI | null): void {
    const normalized = resource ? normalizeUri(resource) : null
    if (sameUri(this._activeEditorResource, normalized)) return
    this._activeEditorResource = normalized
    this._onDidChangeSelection.fire()
    this._onDidChange.fire()
  }

  /**
   * Expand every ancestor of `target`, set it as the focused row + sole selection,
   * and fire a dom event so the row can scroll into view. Returns false when
   * there is no workspace open or the target lies outside it.
   */
  async reveal(target: URI): Promise<boolean> {
    if (!this._root) return false
    const normalized = normalizeUri(target)
    if (!isDescendant(this._root, normalized)) return false
    await this._model.reveal(this._leafEntry(normalized))
    return true
  }

  /** Synchronous snapshot of a node. Returns a fresh default state for unknown URIs. */
  getNode(resource: URI): {
    expanded: boolean
    children: IExplorerEntry[] | null
    loading: boolean
    error: string | null
  } {
    const node = this._nodes.get(resource.toString())
    return {
      expanded: this._model.isExpanded(resource.toString()),
      children: node?.children ?? null,
      loading: node?.loading ?? false,
      error: node?.error ?? null,
    }
  }

  isExpanded(resource: URI): boolean {
    return this._model.isExpanded(resource.toString())
  }

  getChildren(resource: URI): readonly IExplorerEntry[] | null {
    return this._nodes.get(resource.toString())?.children ?? null
  }

  async expand(resource: URI): Promise<void> {
    await this._model.expand(this._dirEntry(resource))
  }

  collapse(resource: URI): void {
    this._model.collapse(this._dirEntry(resource))
  }

  async toggle(resource: URI): Promise<void> {
    await this._model.toggle(this._dirEntry(resource))
  }

  private _dirEntry(resource: URI): IExplorerEntry {
    if (this._root && sameUri(resource, this._root)) return this._rootEntry(this._root)
    return { resource, name: basename(resource), isDirectory: true }
  }

  /** Collapse all expanded directories, leaving only the workspace root visible. */
  collapseAll(): void {
    if (!this._root) return
    const rootKey = this._root.toString()
    for (const key of this._nodes.keys()) {
      if (key !== rootKey && this._model.isExpanded(key)) {
        this._model.collapse(this._dirEntry(URI.parse(key)))
      }
    }
  }

  /** Force re-read of a directory's entries, keeping its expanded state. */
  async refresh(resource: URI): Promise<void> {
    const node = this._ensureNode(resource)
    await this._loadChildren(resource, node)
    this._model.refresh()
  }

  /**
   * Re-read the parent directory of each resource (deduped). Used by the
   * reversible file-operation service so undo/redo refresh the affected rows.
   */
  async refreshParents(resources: readonly URI[]): Promise<void> {
    await this._refreshParents(resources)
  }

  /** Drop cached node state for `resource` and all descendants (post move/delete). */
  forgetSubtree(resource: URI): void {
    this._deleteNodeSubtree(resource)
  }

  /** Fire onDidRunFileOperation so consumers (markdown link updating) can react. */
  notifyDidRunFileOperation(renames: readonly IFileRenameOperation[]): void {
    if (renames.length > 0) this._onDidRunFileOperation.fire(renames)
  }

  /** Select (and focus the first of) the given resources after an operation. */
  selectOperationTargets(targets: readonly URI[]): void {
    this._selectOperationTargets(targets)
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
    const isDirectory = this.isDirectory(source)
    try {
      await this._fileService.rename(source, target, { overwrite: false })
      this._deleteNodeSubtree(source)
      if (this.isCut(source)) this.clearClipboard()
      await this.refresh(parent)
      this._logger.info(`rename ${source.toString()} -> ${target.toString()}`)
      this._onDidRunFileOperation.fire([
        { oldUri: normalizeUri(source), newUri: normalizeUri(target), isDirectory },
      ])
      return target
    } catch (err) {
      this._logger.error(`rename failed ${source.toString()} -> ${target.toString()}`, err)
      throw err
    }
  }

  async delete(target: URI, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    try {
      await this._fileService.delete(target, opts)
      const parent = parentOf(target)
      this._deleteNodeSubtree(target)
      if (this.isCut(target)) this.clearClipboard()
      if (parent) {
        await this.refresh(parent)
      } else {
        this._model.refresh()
      }
      this._logger.info(
        `delete ${target.toString()} recursive=${opts?.recursive === true} useTrash=${opts?.useTrash === true}`,
      )
    } catch (err) {
      this._logger.error(`delete failed ${target.toString()}`, err)
      throw err
    }
  }

  /**
   * Mirror the shared file clipboard into this window's local state. The
   * shared service (main memory + OS clipboard) is the authority — writing
   * back to it from here would loop, since the ProxyChannel broadcast
   * includes the originating window.
   */
  adoptClipboard(resources: readonly IExplorerResourceOperation[], isCut: boolean): void {
    const normalized = this._normalizeClipboardResources(resources)
    this._clipboardResources = normalized
    this._clipboardIsCut = isCut && normalized.length > 0
    this._logger.info(
      `adopt clipboard ${this._clipboardIsCut ? 'cut' : 'copy'} resources=${normalized.length}`,
    )
    this._onDidChangeClipboard.fire()
    this._onDidChange.fire()
  }

  private _normalizeClipboardResources(
    resources: readonly IExplorerResourceOperation[],
  ): IExplorerResourceOperation[] {
    return dedupe(resources.map((resource) => normalizeUri(resource.resource)))
      .filter((resource) => !this.isRoot(resource))
      .map((resource) => ({
        resource,
        isDirectory:
          resources.find((entry) => sameUri(entry.resource, resource))?.isDirectory ?? false,
      }))
  }

  clearClipboard(): void {
    if (this._clipboardResources.length === 0 && !this._clipboardIsCut) return
    this._clipboardResources = []
    this._clipboardIsCut = false
    this._logger.info('clear clipboard')
    this._onDidChangeClipboard.fire()
    this._onDidChange.fire()
    // Also drop the shared clipboard: every caller here just invalidated the
    // cut entries (rename/delete/move hit one of them), so no window should
    // keep pasting them. The empty-state early return above keeps this
    // idempotent — a clear on an already-empty mirror never reaches main.
    void this._fileClipboard?.clear()
  }

  async duplicate(source: IExplorerResourceOperation, newName: string): Promise<URI> {
    if (this.isRoot(source.resource)) throw new Error('Cannot duplicate the workspace root.')
    const parent = parentOf(source.resource)
    if (!parent) throw new Error('Cannot duplicate a resource without a parent.')
    const target = URI.joinPath(parent, newName)
    if (await this._fileService.exists(target)) {
      throw new Error(`A file or folder named "${newName}" already exists.`)
    }
    try {
      await this._fileService.copy(source.resource, target, { overwrite: false })
      await this.refresh(parent)
      this._logger.info(`duplicate ${source.resource.toString()} -> ${target.toString()}`)
      return target
    } catch (err) {
      this._logger.error(
        `duplicate failed ${source.resource.toString()} -> ${target.toString()}`,
        err,
      )
      throw err
    }
  }

  async defaultDuplicateName(source: IExplorerResourceOperation): Promise<string> {
    const parent = parentOf(source.resource)
    if (!parent) return incrementFileName(basename(source.resource), source.isDirectory)
    let name = incrementFileName(basename(source.resource), source.isDirectory)
    for (let i = 0; i < 200; i++) {
      const candidate = URI.joinPath(parent, name)
      if (!(await this._fileService.exists(candidate))) return name
      name = incrementFileName(name, source.isDirectory)
    }
    throw new Error('Unable to find an available duplicate name.')
  }

  async copyResources(
    resources: readonly IExplorerResourceOperation[],
    destinationDir: URI,
  ): Promise<URI[]> {
    const sources = this._dedupeOperations(resources).filter(
      (resource) => !this.isRoot(resource.resource),
    )
    const targets: URI[] = []
    try {
      for (const source of sources) {
        this._assertCanPlace(source, destinationDir, 'copy')
        const target = await this._findAvailableCopyTarget(source, destinationDir)
        await this._fileService.copy(source.resource, target, { overwrite: false })
        targets.push(target)
      }
      await this._refreshParents([...sources.map((source) => source.resource), ...targets])
      this._logger.info(`copy resources=${sources.length} destination=${destinationDir.toString()}`)
      this._selectOperationTargets(targets)
      return targets
    } catch (err) {
      this._logger.error(`copy failed destination=${destinationDir.toString()}`, err)
      throw err
    }
  }

  async moveResources(
    resources: readonly IExplorerResourceOperation[],
    destinationDir: URI,
    opts?: { overwrite?: boolean },
  ): Promise<URI[]> {
    const overwrite = opts?.overwrite === true
    const sources = this._dedupeOperations(resources).filter(
      (resource) => !this.isRoot(resource.resource),
    )
    const clearsCutState = sources.some((source) => this.isCut(source.resource))
    const targets: URI[] = []
    const renames: IFileRenameOperation[] = []
    try {
      for (const source of sources) {
        this._assertCanPlace(source, destinationDir, 'move')
        const target = normalizeUri(targetInDirectory(destinationDir, source.resource))
        if (sameUri(source.resource, target)) continue
        if (!overwrite && (await this._fileService.exists(target))) {
          throw new Error(`A file or folder named "${basename(target)}" already exists.`)
        }
        await this._fileService.rename(source.resource, target, { overwrite })
        this._deleteNodeSubtree(source.resource)
        targets.push(target)
        renames.push({ oldUri: source.resource, newUri: target, isDirectory: source.isDirectory })
      }
      await this._refreshParents([...sources.map((source) => source.resource), ...targets])
      if (clearsCutState) this.clearClipboard()
      this._logger.info(
        `move resources=${sources.length} destination=${destinationDir.toString()} overwrite=${overwrite}`,
      )
      this._selectOperationTargets(targets)
      if (renames.length > 0) this._onDidRunFileOperation.fire(renames)
      return targets
    } catch (err) {
      this._logger.error(`move failed destination=${destinationDir.toString()}`, err)
      throw err
    }
  }

  private _setRoot(root: URI | null): void {
    const normalized = root ? normalizeUri(root) : null
    this._logger.info(`setRoot ${normalized?.toString() ?? '<none>'}`)
    // Flush the outgoing root's expansion snapshot BEFORE `_model.reset()`
    // empties it — the snapshot must be read off the old root's model, and a
    // debounced write left pending would otherwise land in the new root's
    // WORKSPACE bucket. Skip when the root is unchanged: hydration re-pushes
    // the same folder and must not wipe-then-restore.
    const rootChanged = normalized?.toString() !== this._root?.toString()
    if (rootChanged && this._root) this._persistExpansion(true)
    this._restoreGeneration++ // abandon any in-flight restore of the old root
    this._root = normalized
    this._nodes.clear()
    this._activeEditorResource = null
    // Deliberately does NOT touch the clipboard: it mirrors the shared
    // (main-process) clipboard, which is not derived from the tree root.
    // Clearing here would (a) race cold start — hydration re-pushes the root
    // after the startup snapshot was adopted, wiping the main snapshot — and
    // (b) let one window's workspace switch destroy another window's cut
    // state. Stale cut highlighting is impossible anyway: `isCut` compares
    // URIs, so entries under the old root match no row under the new one.
    this._model.reset()
    if (normalized) {
      // The root's auto-expand and the restore replay are both programmatic,
      // not user gestures — suppress the onDidChangeExpansion → persist echo
      // across both so they never schedule a write of the transient (empty /
      // mid-restore) snapshot. `_restoreExpansion(holdRestoring: true)` takes
      // the flag over and releases it once the replay finishes.
      this._restoring = true
      void this._model.expand(this._rootEntry(normalized))
      // Restore the persisted expansion after the root auto-expands. Async and
      // deliberately not awaited: the tree paints the root immediately while
      // the persisted set re-expands in the background.
      void this._restoreExpansion(normalized, true)
    }
    // Before the watcher has ever armed, a root assignment during cold start
    // (including the first onDidChangeWorkspace firing while
    // IWorkspaceService is still hydrating over IPC) skips the parcel
    // recursive subscribe here; it only feeds later refresh, not the first
    // paint (root expansion above already covers that). WorkspaceWatchContribution
    // calls startWatching() once the workbench reaches WorkbenchPhase.Eventually,
    // well after mount, so it never competes with the renderer restore window
    // for main-process CPU. Once armed, or once cold start has settled (a
    // genuine runtime workspace switch, e.g. opening a folder into an empty
    // window), root changes sync immediately below.
    if (this._watchStarted || this._coldStartSettled) {
      this._syncWatch(normalized)
    }
  }

  /**
   * (Re-)arm the watcher for the current root. Called by WorkspaceWatchContribution
   * once the workbench reaches its idle phase, to arm the cold-start watch that
   * `_setRoot` skips until this fires. Idempotent — safe to call more than once.
   * The parcel watcher only reports changes from the moment it subscribes, so
   * anything created/removed externally during the deferral window would
   * otherwise be invisible forever — rescan already-loaded directories once to
   * catch up.
   */
  startWatching(): void {
    if (this._watchStarted) return
    this._watchStarted = true
    this._syncWatch(this._root)
    this._refreshLoadedNodes()
  }

  /** (Re-)arm or tear down the recursive file watcher for `root`. Idempotent — the main-process watcher dedupes same-root re-subscribes. */
  private _syncWatch(root: URI | null): void {
    if (root) {
      void this._watcher
        .watch(root, {
          excludes: this._exclude.currentWatcherGlobs,
          scopes: this._focus.scanRoots,
          includeRootFiles: this._focus.rootFilesInScope,
        })
        .then(() => {
          // parcel only reports changes after the subscription is live; the
          // ack resolves once the watcher process has armed. Anything created
          // externally in the request→ack window (cross-process spawn +
          // subscribe on Windows can take hundreds of ms) fired no event, so
          // re-read the root once. Refreshing only the root (not every loaded
          // node like startWatching's catch-up) keeps the common case cheap —
          // the window is short, and deeper edits almost always race with a
          // root-level create the OS reports alongside.
          if (this._root && sameUri(this._root, root)) void this.refresh(root)
        })
        .catch(() => {
          this._logger.warn(`watch failed ${root.toString()}`)
        })
    } else {
      void this._watcher.unwatch().catch(() => {})
    }
  }

  /** Re-read every already-loaded directory (expansion state preserved) and refresh the model. */
  private _refreshLoadedNodes(): void {
    const loaded: URI[] = []
    for (const [key, node] of this._nodes) {
      if (node.children !== null) loaded.push(URI.parse(key))
    }
    void Promise.all(loaded.map((u) => this._loadChildren(u, this._ensureNode(u)))).then(() =>
      this._model.refresh(),
    )
  }

  /**
   * files.exclude changed: re-read every already-loaded directory so the new
   * filter is applied (expansion state is preserved), and re-seed the watcher
   * with the updated watcherExclude globs.
   */
  private _onExcludeChange(): void {
    if (this._root) {
      void this._watcher.setExcludes(this._exclude.currentWatcherGlobs).catch(() => {})
    }
    this._refreshLoadedNodes()
  }

  /**
   * Focus folders changed: the visible entry set and the watched subtrees both
   * derive from them, so re-arm the watch and re-read every loaded directory.
   */
  private _onFocusChange(): void {
    if (this._watchStarted) this._syncWatch(this._root)
    this._refreshLoadedNodes()
    // Re-restore: a directory filtered out of the first restore by the previous
    // focus set may now be visible. The hasState guard keeps this a no-op for
    // everything already expanded, so a plain focus flip never collapses
    // anything the user (or a prior restore) opened.
    if (this._root) void this._restoreExpansion(this._root)
  }

  /** Snapshot the current expanded-directory set into WORKSPACE storage. */
  private _persistExpansion(flush = false): void {
    const storage = this._storage
    const root = this._root
    if (!storage || !root) return
    const key = storageKeyForRoot(root)
    const rootKey = root.toString()
    // Exclude the root (it always auto-expands — never stored) and any node
    // whose children failed to load (persisting those would wed them open).
    const ids = this._model
      .getExpandedIds()
      .filter((id) => id !== rootKey && this._nodes.get(id)?.error == null)
    if (flush) flushExpandedIdsWrite(storage, key, ids)
    else persistExpandedIds(storage, key, ids)
  }

  /** Test/e2e hook: synchronously flush any pending debounced expansion write. */
  flushExpansionState(): void {
    this._persistExpansion(true)
  }

  /**
   * Re-apply the persisted expanded-directory set for `root`. Shallowest-first
   * and sequential, so a parent is expanded (its children loaded) before its
   * own persisted descendants expand against the now-known entries. Idempotent
   * per node via `hasState` — a re-restore never re-expands a directory the
   * user has since collapsed, and a generation token abandons the pass if the
   * root changes mid-restore.
   */
  private async _restoreExpansion(root: URI, holdRestoring = false): Promise<void> {
    const generation = ++this._restoreGeneration
    // Own the suppress flag for the whole restore when the caller primed it
    // (the `_setRoot` root auto-expand window); released in the replay finally.
    if (holdRestoring) this._restoring = true
    const storage = this._storage
    if (!storage) {
      if (holdRestoring) this._restoring = false
      return
    }
    let state: ExplorerTreePersistedState | undefined
    try {
      state = await storage.get<ExplorerTreePersistedState>(
        storageKeyForRoot(root),
        StorageScope.WORKSPACE,
      )
    } catch {
      if (holdRestoring) this._restoring = false
      return
    }
    if (
      this._restoreGeneration !== generation ||
      this._root === null ||
      !sameUri(this._root, root)
    ) {
      if (holdRestoring) this._restoring = false
      return
    }
    const raw = state?.expandedIds
    if (!Array.isArray(raw)) {
      if (holdRestoring) this._restoring = false
      return
    }
    const rootKey = root.toString()
    const targets: URI[] = []
    for (const id of raw) {
      if (typeof id !== 'string') continue
      let uri: URI
      try {
        uri = normalizeUri(URI.parse(id))
      } catch {
        continue
      }
      if (uri.toString() === rootKey) continue
      if (!isDescendant(root, uri)) continue
      if (this._model.hasState(uri.toString())) continue
      if (!this._isEntryVisible(root, this._dirEntry(uri))) continue
      targets.push(uri)
    }
    const depth = (u: URI): number => u.path.split('/').length
    targets.sort((a, b) => depth(a) - depth(b))
    this._restoring = true
    let abandoned = false
    try {
      for (const uri of targets) {
        if (
          this._restoreGeneration !== generation ||
          this._root === null ||
          !sameUri(this._root, root)
        ) {
          abandoned = true
          break
        }
        if (this._model.hasState(uri.toString())) continue
        await this._model.expand(this._dirEntry(uri))
      }
    } finally {
      this._restoring = false
    }
    // Self-heal: only once the loop ran to completion (not abandoned mid-way
    // by a root switch), and only when the restored snapshot actually diverged
    // from what storage already holds (a stale id that failed to re-expand is
    // absent). Flushing that converged set drops the stale id; an unchanged
    // set is left alone so a plain reload never churns a write.
    if (abandoned || this._root === null || !sameUri(this._root, root)) return
    // Self-heal the persisted set: drop a target that failed to actually expand
    // (a deleted directory rejects its load, so `isExpanded` stays false and
    // the node carries an error). Ids we did NOT attempt this pass — filtered
    // out by the current focus set — are kept verbatim: focus is a transient
    // view, not a reason to forget the expansion. Only a real "was expanded
    // before, now won't open" is pruned.
    const attempted = new Set(targets.map((u) => u.toString()))
    const healed = raw
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => {
        if (id === rootKey) return false
        if (!attempted.has(id)) return true // not attempted (e.g. out of focus) — keep
        return this._model.isExpanded(id) && this._nodes.get(id)?.error == null
      })
    const accepted = lastAcceptedExpandedIds(storageKeyForRoot(root))
    if (accepted !== undefined && sameIds(accepted, healed)) return
    flushExpandedIdsWrite(storage, storageKeyForRoot(root), healed)
  }

  private _onWatcherEvents(events: readonly IFileChangeEvent[]): void {
    if (!this._root || events.length === 0) return
    const seen = new Set<string>()
    for (const ev of events) {
      const resource = normalizeUri(ev.resource)
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
      node = { children: null, loading: false, error: null }
      this._nodes.set(key, node)
    }
    return node
  }

  private _findKnownEntry(resource: URI): IExplorerEntry | undefined {
    if (this._root && sameUri(this._root, resource)) return this._rootEntry(this._root)
    for (const entry of this.getVisibleEntries()) {
      if (sameUri(entry.resource, resource)) return entry
      if (entry.compactRoot && sameUri(entry.compactRoot, resource)) {
        return { resource: entry.compactRoot, name: basename(entry.compactRoot), isDirectory: true }
      }
    }
    for (const node of this._nodes.values()) {
      const found = node.children?.find((entry) => sameUri(entry.resource, resource))
      if (found) return found
    }
    return undefined
  }

  private _dedupeOperations(
    resources: readonly IExplorerResourceOperation[],
  ): IExplorerResourceOperation[] {
    const normalized = dedupe(resources.map((resource) => normalizeUri(resource.resource)))
    return normalized.map((resource) => ({
      resource,
      isDirectory:
        resources.find((entry) => sameUri(entry.resource, resource))?.isDirectory ??
        this.isDirectory(resource),
    }))
  }

  private _assertCanPlace(
    source: IExplorerResourceOperation,
    destinationDir: URI,
    operation: 'copy' | 'move',
  ): void {
    if (this.isRoot(source.resource)) {
      throw new Error(`Cannot ${operation} the workspace root.`)
    }
    if (source.isDirectory && isDescendant(source.resource, destinationDir)) {
      throw new Error('Cannot place a folder inside itself or one of its descendants.')
    }
  }

  private async _findAvailableCopyTarget(
    source: IExplorerResourceOperation,
    destinationDir: URI,
  ): Promise<URI> {
    let name = basename(source.resource)
    for (let i = 0; i < 200; i++) {
      const candidate = URI.joinPath(destinationDir, name)
      if (!(await this._fileService.exists(candidate))) return candidate
      name = incrementFileName(name, source.isDirectory)
    }
    throw new Error('Unable to find an available copy target.')
  }

  private _deleteNodeSubtree(resource: URI): void {
    const normalized = normalizeUri(resource)
    for (const key of [...this._nodes.keys()]) {
      const nodeResource = normalizeUri(URI.parse(key))
      if (sameUri(nodeResource, normalized) || isDescendant(normalized, nodeResource)) {
        this._nodes.delete(key)
      }
    }
  }

  private async _refreshParents(resources: readonly URI[]): Promise<void> {
    const parents = new Map<string, URI>()
    for (const resource of resources) {
      const parent = parentOf(resource)
      if (parent) parents.set(normalizeUri(parent).toString(), parent)
    }
    await Promise.all([...parents.values()].map((parent) => this.refresh(parent)))
  }

  private _selectOperationTargets(targets: readonly URI[]): void {
    if (targets.length === 0) return
    this.setSelection(targets, targets[0] ?? null)
  }

  private _isSingleDirChild(resource: URI): boolean {
    if (this._root && sameUri(resource, this._root)) return false
    const ch = this._nodes.get(resource.toString())?.children
    return ch !== null && ch !== undefined && ch.length === 1 && (ch[0]?.isDirectory ?? false)
  }

  private _computeCompactChildren(raw: readonly IExplorerEntry[]): readonly IExplorerEntry[] {
    return raw.map((entry) => {
      if (!entry.isDirectory) return entry
      let current = entry
      let displayName = entry.name
      for (let d = 0; d < 20; d++) {
        if (!this._isSingleDirChild(current.resource)) break
        const child = this._nodes.get(current.resource.toString())!.children![0]!
        displayName += '/' + child.name
        current = child
      }
      if (current === entry) return entry
      return {
        resource: current.resource,
        name: current.name,
        isDirectory: true,
        compactName: displayName,
        compactRoot: entry.resource,
      }
    })
  }

  private async _eagerLoadForCompact(resource: URI, depth = 0): Promise<void> {
    if (depth >= 20) return
    const node = this._ensureNode(resource)
    if (node.children === null) await this._loadChildren(resource, node)
    const ch = node.children
    if (ch && ch.length === 1 && (ch[0]?.isDirectory ?? false)) {
      await this._eagerLoadForCompact(ch[0]!.resource, depth + 1)
    }
  }

  private async _loadChildren(resource: URI, node: NodeState): Promise<void> {
    node.loading = true
    node.error = null
    try {
      const entries = await this._fileService.list(resource)
      const sorted = sortEntries(entries, resource)
      const root = this._root
      node.children = root ? sorted.filter((e) => this._isEntryVisible(root, e)) : sorted
      this._logger.debug(`loadChildren ${resource.toString()} entries=${node.children.length}`)
    } catch (err) {
      node.children = []
      node.error = err instanceof Error ? err.message : String(err)
      this._logger.warn(`loadChildren failed ${resource.toString()}`, node.error)
    } finally {
      node.loading = false
    }
  }

  /**
   * Two independent filters, both anchored on the workspace root: the
   * `files.exclude` blacklist and the focus-folder whitelist. Focus keeps
   * ancestor directories of a focus folder visible so the subtree stays
   * reachable — see focusScopeUtils.
   */
  private _isEntryVisible(root: URI, entry: IExplorerEntry): boolean {
    const rel = relativeTo(root, entry.resource)
    if (this._exclude.isExcluded(rel, 'files')) return false
    return this._focus.isVisible(rel, entry.isDirectory)
  }
}
