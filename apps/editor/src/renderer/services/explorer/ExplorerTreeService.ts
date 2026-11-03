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
import { processDirectoryEntries, type IExplorerEntry } from './explorerEntries.js'
import { IExcludeService } from '../exclude/ExcludeService.js'
import { IFocusScopeService } from '../focus/FocusScopeService.js'
import { basenameOf, incrementFileName, targetInDirectory } from './explorerFileOperations.js'
import { beginRenameIntent } from './renameIntent.js'
import { IFileClipboardService } from '../../../shared/ipc/fileClipboardService.js'
import { pushPerfPhaseSample } from '../performance/perfPhases.js'

export type { IExplorerEntry } from './explorerEntries.js'

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

/** Which entry point asked for a directory read — perf attribution only. */
type LoadSource = 'expand' | 'compact' | 'refresh'

/** Warn/push a perf sample past any of these. */
const SLOW_LIST_READ_MS = 200
const SLOW_LIST_PROCESS_MS = 50
const LARGE_DIRECTORY_ENTRIES = 10_000

/** 一次目录读取的耗时剖面（slow-path 归因用）。 */
interface IDirectoryReadReport {
  resource: URI
  source: LoadSource
  total: number
  visible: number
  readStart: number
  /** list 墙钟（IPC + await），非 CPU。 */
  readWall: number
  processStart: number
  /** 过滤 + 构造 + 排序的墙钟，含 yield 等待，非 CPU。 */
  processWall: number
  /** 其中单次同步排序耗时——真实的同步阻塞。 */
  sortMs: number
  sortStart: number
}

interface NodeState {
  children: IExplorerEntry[] | null
  loading: boolean
  error: string | null
  /** 在途读取；expand / 链续读 / refresh 共用，同一目录不并发 list。 */
  pending: Promise<void> | null
  /** 在途期间到达的请求由此标记再读一轮：一轮内的多次刷新合并，尾读期间来的再赢得一轮。 */
  trailing: boolean
  source: LoadSource
  /**
   * 缓存仍可用于显示折叠行的标签/身份，但不能再回答一次新的展开：期间文件系统
   * 可能已经变化。折叠/隐藏后只标脏不读，重新展开时从链头按需重读。
   */
  stale: boolean
  /** 每次失效递增：在途 list 提交时版本变了，就不能把这次失效清掉。 */
  invalidationVersion: number
  /**
   * 本次展开请求开始时的显示链头。行 id 是链尾，重读可能让链伸缩甚至上移
   * （`config/raw/tables` 里 `raw` 冒出兄弟后行变成 `config/raw`），此时不能
   * 只从旧链尾向下找新链尾——旧链尾已经藏在新的折叠行下面。只属于发起读取
   * 的那个节点，随节点缓存丢弃/下次读取覆盖，不是第二套全局身份缓存。
   */
  expansionChainHead: URI | null
}

function basename(resource: URI): string {
  return basenameOf(resource)
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
  // True once the main-process watcher has acked the workspace subscription.
  // Everything that reads the shared change stream (this tree, the session-diff
  // fallback, SCM) is blind until then — deliberately so, see `startWatching` —
  // and only the tree compensates with a catch-up re-read. Callers that must
  // see a specific write (e2e) have to wait for this instead of guessing.
  private _watchArmed = false
  // Expansion-persistence orchestration (explorerTreeState). `_restoreGeneration`
  // tokens an in-flight restore so a `_setRoot` mid-restore abandons the stale
  // pass instead of re-expanding the old root's directories under the new one.
  // `_restoring` suppresses the onDidChangeExpansion → persist echo while a
  // restore replays the persisted set (those flips are not user gestures).
  private _restoreGeneration = 0
  private _restoring = false
  /** `_setRoot` / `dispose()` 递增；每个跨 await 的路径回写前比对，旧树在途读取既不发布也不建节点。 */
  private _generation = 0

  private readonly _dataSource: ITreeDataSource<IExplorerEntry> = {
    getId: (e) => e.resource.toString(),
    hasChildren: (e) => e.isDirectory,
    getChildren: (e) => {
      const node = this._nodes.get(e.resource.toString())
      if (!node || node.children === null || node.stale) return null
      // 读取失败对模型等同于“未加载”：显式展开或可见行拉取会重试，模型的一次性
      // 守卫阻止渲染循环。
      if (node.error !== null) return null
      // 行 id 若是 compact 链尾，链上任一中间节点失效都意味着身份未验证：交给
      // loadChildren 从链头重读，别用旧缓存回答一次新展开。
      if (!this._isCompactChainFresh(e.resource)) return null
      return this._computeCompactChildren(node.children)
    },
    loadChildren: async (e) => {
      const generation = this._generation
      // 只为被请求的目录建立唯一目录链；分叉子目录保持普通行，等用户展开。
      await this._loadChain(e.resource, 'expand', generation, true)
    },
    resolveExpandedElement: (e) => {
      if (this._root && sameUri(e.resource, this._root)) return e
      if (!e.isDirectory) return e
      // 链尾是行的真实身份：展开链头后在同一事务里迁移到链尾，避免二次点击。
      // 从本次读取记录的链头重新解析，而不是从旧链尾向下——重读后链可能缩短，
      // 旧链尾会藏进新的折叠行里（不能上移就会把焦点/选区留在隐藏行上）。
      const requestedHead = this._nodes.get(e.resource.toString())?.expansionChainHead
      if (requestedHead) {
        const tail = this._compactChainTail(requestedHead)
        // 尾目录读取失败时它只是错误行，不是新的行身份：留在旧行等用户显式
        // 重试，避免把一次失败变成对同一目录的第二轮自动读取。
        if (this._nodes.get(tail.toString())?.error != null) return e
        if (sameUri(tail, e.resource)) return e
        return { resource: tail, name: basename(tail), isDirectory: true }
      }
      const tail = this._compactChainTail(e.resource)
      if (sameUri(tail, e.resource)) return e
      return { resource: tail, name: basename(tail), isDirectory: true }
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

  override dispose(): void {
    this._generation++ // abandon every in-flight read / prefetch step
    super.dispose()
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

  /** Selection size without materializing URI objects (context-key hot path). */
  get selectionCount(): number {
    return this._model.selection.length
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

  setSelection(
    resources: readonly URI[] | URI | null,
    focus?: URI | null,
    options?: { reveal?: boolean },
  ): void {
    const list = resources == null ? [] : Array.isArray(resources) ? resources : [resources as URI]
    const ids = list.map((u) => u.toString())
    if (focus === undefined) this._model.setSelection(ids, undefined, options)
    else this._model.setSelection(ids, focus === null ? null : focus.toString(), options)
  }

  setFocus(resource: URI | null): void {
    this._model.setFocus(resource ? resource.toString() : null)
  }

  /** Ctrl/Cmd+Click semantics: add when absent, remove when present. */
  toggleInSelection(resource: URI): void {
    this._model.toggleInSelection(resource.toString())
  }

  /** Shift gesture: extend the range from the persistent selection anchor. */
  extendSelectionTo(resource: URI): void {
    this._model.extendSelectionTo(resource.toString())
  }

  /** Escape gesture: drop a multi-selection back to the focused row. */
  collapseSelectionToFocus(): void {
    this._model.collapseSelectionToFocus()
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

  /** 重读目录；显式递归刷新只覆盖根与当前实际可见的展开层，不遍历隐藏缓存。 */
  async refresh(resource: URI, recursive = false): Promise<void> {
    const resources = recursive ? this._collectRefreshTargets(resource) : [resource]
    if (recursive) {
      this._logger.debug(`refresh subtree ${resource.toString()} directories=${resources.length}`)
    }
    await this._reloadNodes(resources, resource)
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
    const intent = beginRenameIntent(source)
    try {
      // The tree only knows about materialized nodes; a rename can be invoked
      // on one that was never expanded, where `isDirectory` is unreliable.
      let isDirectory = this.isDirectory(source)
      if (!isDirectory) {
        try {
          isDirectory = (await this._fileService.stat(source)).isDirectory
        } catch {
          // Stat is best-effort: the rename below reports the real failure.
        }
      }
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
    } finally {
      intent.dispose()
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
    const intents = sources.map((source) => beginRenameIntent(source.resource))
    let published = false
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
      if (renames.length > 0) {
        this._onDidRunFileOperation.fire(renames)
        published = true
      }
      return targets
    } catch (err) {
      this._logger.error(`move failed destination=${destinationDir.toString()}`, err)
      throw err
    } finally {
      // Already-moved files stay moved when a later source fails; retarget
      // their tabs before the rename intents expire.
      if (!published && renames.length > 0) this._onDidRunFileOperation.fire(renames)
      for (const intent of intents) intent.dispose()
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
    this._generation++ // abandon every in-flight read / prefetch step
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
   * Whether the main-process watcher has acked the current root's subscription.
   *
   * The single readiness signal for "a write to the workspace will produce a
   * change event": the tree re-reads loaded directories to cover the deferral
   * window, but every other consumer of the shared stream — the session-diff
   * watcher fallback, SCM — has no such catch-up and simply misses anything
   * written before this flips. Distinct from `_watchStarted`, which only means
   * the arming was requested.
   */
  get watchArmed(): boolean {
    return this._watchArmed
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
    this._watchArmed = false
    if (root) {
      void this._watcher
        .watch(root, {
          excludes: this._exclude.currentWatcherGlobs,
          scopes: this._focus.scanRoots,
          includeRootFiles: this._focus.rootFilesInScope,
          files: this._focus.fileWatchPaths,
        })
        .then(() => {
          // A stale ack (root replaced, or the watch torn down while this was in
          // flight) must not report the CURRENT root as armed.
          if (this._root && sameUri(this._root, root)) this._watchArmed = true
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

  /**
   * 重同步：从根与当前可见的展开行（含 compact 链路径）构造读取集合。隐藏的
   * 已加载节点只标脏，等重新可见/展开时按需读取。
   *
   * 过滤变更（exclude/focus）额外传入 `includeVisibleCompactAncestors`：折叠的
   * compact 行没有自己的子行，链形状由链上至多各一个子项的中间目录决定；重读
   * 它们让父层过滤立即正确。折叠链尾（可能是巨型目录）绝不在这里读取——链形状
   * 若真因过滤而变，等重新展开时从链头按需确认。
   */
  private _refreshLoadedNodes(includeVisibleCompactAncestors = false): void {
    if (!this._root) return
    const resources = this._collectRefreshTargets(this._root, includeVisibleCompactAncestors)
    void this._reloadNodes(resources, null)
  }

  /**
   * 刷新 scope 下的可见层并发布结构变化：
   * - scope 为 null 时失效全树缓存（冷启动 catch-up / exclude-focus / watcher 重启）；
   * - 否则只失效 scope 子树内的缓存（watcher / CRUD 的局部刷新）。
   * 读取集合之外已缓存的节点标 stale：保留折叠行标签与行身份，重新展开时再读。
   */
  private async _reloadNodes(
    resources: readonly URI[],
    invalidateScope: URI | null,
  ): Promise<void> {
    const generation = this._generation
    const compactState = this._captureCompactAnchors()
    this._markStaleExcept(
      new Set(resources.map((r) => normalizeUri(r).toString())),
      invalidateScope,
    )
    await Promise.all(resources.map((resource) => this._reloadNode(resource, generation)))
    if (generation !== this._generation) return
    this._model.refreshWithFocusRecovery()
    this._remapSelectionToCompact(compactState)
    this._remapExpansionToCompact(compactState)
  }

  /**
   * 可见行的读取集合：根/scope + 每个可见展开行及其 compact 链路径。
   *
   * `includeVisibleCompactAncestors` 只影响可见的折叠 compact 行：把链上（不含
   * 链尾）的中间目录加入读取集合，让过滤变更后的链形状/标签立即正确；链尾可能
   * 是巨型目录，始终留给重新展开时的链头驱动读取。
   */
  private _collectRefreshTargets(scope: URI, includeVisibleCompactAncestors = false): URI[] {
    const out = new Map<string, URI>()
    const add = (resource: URI): void => {
      const normalized = normalizeUri(resource)
      out.set(normalized.toString(), normalized)
    }
    const inScope = (resource: URI): boolean =>
      sameUri(scope, resource) || isDescendant(scope, resource)
    add(scope)
    for (const node of this._model.getVisibleNodes()) {
      const entry = node.element
      if (!inScope(entry.resource)) continue
      if (node.expanded) {
        for (const chainNode of this._compactChainPath(entry.resource)) {
          if (inScope(chainNode)) add(chainNode)
        }
        continue
      }
      if (!includeVisibleCompactAncestors || entry.compactRoot === undefined) continue
      const chain = this._compactChainPath(entry.resource)
      for (let i = 1; i < chain.length; i++) {
        const chainNode = chain[i]!
        if (inScope(chainNode)) add(chainNode)
      }
    }
    return [...out.values()]
  }

  private _markStale(node: NodeState): void {
    node.stale = true
    node.invalidationVersion++
    // 读取在途时再补一轮：否则本轮提交的旧结果虽保留失效标记，却没人再读，
    // 可见的展开行会空着等用户手动重开。
    if (node.pending) node.trailing = true
  }

  private _markStaleExcept(keep: ReadonlySet<string>, scope: URI | null): void {
    // 可见展开行（及 compact 链路径）属于当前视图，保持新鲜才不会让一次浅刷新
    // 级联重读已加载后代。隐藏/折叠的缓存才可能在背后变化。
    const visibleExpandedChain = new Set<string>()
    for (const node of this._model.getVisibleNodes()) {
      if (!node.expanded) continue
      for (const chainNode of this._compactChainPath(node.element.resource)) {
        visibleExpandedChain.add(chainNode.toString())
      }
    }
    for (const [key, node] of this._nodes) {
      if (keep.has(key) || visibleExpandedChain.has(key)) continue
      if (scope !== null) {
        const resource = URI.parse(key)
        if (!sameUri(scope, resource) && !isDescendant(scope, resource)) continue
      }
      // 在途首读（children === null）同样要记失效版本，否则提交时会把这次
      // 失效当成旧结果清掉。
      this._markStale(node)
    }
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
    this._refreshLoadedNodes(true)
  }

  /**
   * Focus folders changed: the visible entry set and the watched subtrees both
   * derive from them, so re-arm the watch and re-read every loaded directory.
   */
  private _onFocusChange(): void {
    if (this._watchStarted) this._syncWatch(this._root)
    this._refreshLoadedNodes(true)
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
    // 行 id 是链尾；持久化链头，恢复时才能从用户展开的目录重新解析整条链。
    const ids = [
      ...new Set(
        this._model
          .getExpandedIds()
          .filter((id) => id !== rootKey && this._nodes.get(id)?.error == null)
          .map((id) => this._compactChainHead(URI.parse(id)).toString()),
      ),
    ]
    if (flush) flushExpandedIdsWrite(storage, key, ids)
    else persistExpandedIds(storage, key, ids)
  }

  /** Test/e2e hook: synchronously flush any pending debounced expansion write. */
  flushExpansionState(): void {
    this._persistExpansion(true)
  }

  /**
   * 持久化以链头记录，行 id 却是链尾；展开迁移后模型里只剩尾行 state。恢复
   * 目标是链头时，只要尾行已有 state（本会话展开过或用户刚折叠），尾行才是
   * 当前意图——不能再用头 id 展开一次，否则 scope 重灌会复活刚折叠的尾行。
   * 链尚未加载（尾==头）时返回 false，让正常恢复流程继续。
   */
  private _isExpansionOwnedByChainTail(resource: URI): boolean {
    const tail = this._compactChainTail(resource)
    return !sameUri(tail, resource) && this._model.hasState(tail.toString())
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
    // 先把折叠目标全部设为展开态：隐藏的展开目录在重新可见前不能被读取。
    // 可见目标随后逐个展开，由展开流程解析 compact 链并落到真实行 id。
    if (targets.length > 0) {
      this._model.setExpansion(targets.map((uri) => [uri.toString(), true] as const))
    }
    this._restoring = true
    let abandoned = false
    const attempted = new Set<string>()
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
        // 恢复期间用户折叠过的目录以用户意图为准。
        if (!this._model.isExpanded(uri.toString())) continue
        // 链已加载且尾行有 state：用户意图由尾行表达。批量 setExpansion 给
        // 链头补的是合成态，撤掉它，避免尾行的折叠被头的持久化记录复活。
        // 记为“已尝试”让自愈按尾行健康度决定是否继续持久化这个头 id。
        if (this._isExpansionOwnedByChainTail(uri)) {
          this._model.setExpansion([[uri.toString(), false]])
          attempted.add(uri.toString())
          continue
        }
        if (!this._isRestoreTargetReachable(uri, root)) continue
        attempted.add(uri.toString())
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
    // 自愈：只剔除本次真正尝试展开、却没能打开的目录（读取失败会留下 error）。
    // 没尝试的 id——被当前 focus 过滤掉、或藏在折叠祖先之下——原样保留：
    // focus 与折叠是临时视图，不该因此忘掉持久化的展开。
    const healed = raw
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => {
        if (id === rootKey) return false
        if (!attempted.has(id)) return true // 未尝试（隐藏/不在 focus）——保留
        return this._isRestoredExpansionHealthy(URI.parse(id))
      })
    const accepted = lastAcceptedExpandedIds(storageKeyForRoot(root))
    if (accepted !== undefined && sameIds(accepted, healed)) return
    flushExpandedIdsWrite(storage, storageKeyForRoot(root), healed)
  }

  /** `uri` 的每个祖先都处于打开状态（可能被折进已展开的链尾行）。 */
  private _isRestoreTargetReachable(uri: URI, root: URI): boolean {
    let cursor = parentOf(uri)
    while (cursor !== null && !sameUri(cursor, root)) {
      if (this._model.isExpanded(cursor.toString())) {
        cursor = parentOf(cursor)
        continue
      }
      // 祖先可能被压缩进 id=链尾 的展开行：链尾展开时整条链都是可见的，
      // 无自己行的中间节点不能被当成折叠。
      const head = this._compactChainHead(cursor)
      const tail = this._compactChainTail(head)
      if (sameUri(tail, cursor) || !this._model.isExpanded(tail.toString())) return false
      cursor = parentOf(head)
    }
    return cursor !== null
  }

  /**
   * 一次尝试展开的恢复目标是否真的打开：compact 链把展开态挪到链尾，链头
   * 未展开没关系，链尾打开即可；链上任一读取失败则视为不健康。
   */
  private _isRestoredExpansionHealthy(uri: URI): boolean {
    if (this._chainHasError(uri)) return false
    const id = uri.toString()
    if (this._model.isExpanded(id)) return true
    const tail = this._compactChainTail(uri)
    return (
      tail.toString() !== id &&
      this._model.isExpanded(tail.toString()) &&
      !this._chainHasError(tail)
    )
  }

  private _chainHasError(resource: URI): boolean {
    let current = resource
    for (let depth = 0; depth < 20; depth++) {
      const node = this._nodes.get(current.toString())
      if (!node) return false
      if (node.error !== null) return true
      const children = node.children
      if (!children || children.length !== 1) return false
      const next = children[0]
      if (!next || !next.isDirectory) return false
      current = next.resource
    }
    return false
  }

  private _onWatcherEvents(events: readonly IFileChangeEvent[]): void {
    if (!this._root || events.length === 0) return
    const necessary = this._collectVisibleChainIds()
    const seen = new Set<string>()
    let staleOnly = 0
    for (const ev of events) {
      const resource = normalizeUri(ev.resource)
      const parent = parentOf(resource)
      if (!parent) continue
      const key = parent.toString()
      if (seen.has(key)) continue
      if (!this._nodes.has(key) && !necessary.has(key)) continue
      seen.add(key)
      if (necessary.has(key)) {
        void this.refresh(parent)
      } else {
        // 已加载但看不见的目录：只失效，不读取；重新可见/展开时按需刷新。
        this._invalidateSubtree(parent)
        staleOnly++
      }
    }
    if (seen.size > 0) {
      this._logger.debug(
        `watcher refresh parents=${seen.size - staleOnly} stale=${staleOnly} events=${events.length}`,
      )
    }
  }

  /** 当前可见行涉及的必要目录 id。 */
  private _collectVisibleChainIds(): Set<string> {
    const ids = new Set<string>()
    for (const node of this._model.getVisibleNodes()) {
      const entry = node.element
      if (node.expanded) {
        for (const chainNode of this._compactChainPath(entry.resource)) {
          ids.add(chainNode.toString())
        }
        ids.add(node.id)
        continue
      }
      if (entry.compactRoot === undefined) continue
      // 折叠 compact 行只验证身份链的中间节点；链尾（可能是巨型目录）的事件
      // 只失效不读取，避免每来一次 watcher 就整目录 list。
      const chain = this._compactChainPath(entry.resource)
      for (let i = 1; i < chain.length; i++) ids.add(chain[i]!.toString())
    }
    return ids
  }

  private _invalidateSubtree(resource: URI): void {
    const normalized = normalizeUri(resource)
    for (const [key, node] of this._nodes) {
      const nodeResource = URI.parse(key)
      if (sameUri(nodeResource, normalized) || isDescendant(normalized, nodeResource)) {
        this._markStale(node)
      }
    }
  }

  private _ensureNode(resource: URI): NodeState {
    const key = resource.toString()
    let node = this._nodes.get(key)
    if (!node) {
      node = {
        children: null,
        loading: false,
        error: null,
        pending: null,
        trailing: false,
        source: 'expand',
        stale: false,
        invalidationVersion: 0,
        expansionChainHead: null,
      }
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

  /** Topmost directory of the compact chain that `resource` belongs to. */
  private _compactChainHead(resource: URI): URI {
    let head = resource
    for (let d = 0; d < 20; d++) {
      const parent = this.getParent(head)
      if (parent === null || !this._isSingleDirChild(parent)) break
      head = parent
    }
    return head
  }

  /** Bottom of the compact chain starting at `resource` — the row's identity. */
  private _compactChainTail(resource: URI): URI {
    let current = resource
    for (let d = 0; d < 20; d++) {
      if (!this._isSingleDirChild(current)) break
      const child = this._nodes.get(current.toString())?.children?.[0]
      if (!child) break
      current = child.resource
    }
    return current
  }

  /**
   * Rows are keyed by their chain tail, so a refresh that lengthens or shortens
   * a chain moves the id out from under selection and focus. Snapshot each
   * selected id's chain head *before* the re-read — afterwards the cache holds
   * the new shape and walking up from a stale tail no longer reaches the head.
   *
   * Recovery also prunes ids that were visible before and are gone after; a
   * chain reshape looks exactly like that, so keep the pre-refresh selection and
   * the set of rows that were on screen for `_remapSelectionToCompact`.
   */
  private _captureCompactAnchors(): {
    readonly anchors: Map<string, string>
    readonly selection: readonly string[]
    readonly focused: string | null
    readonly anchor: string | null
    readonly selectionEpoch: number
    readonly visibleIds: ReadonlySet<string>
    readonly expandedIds: readonly string[]
    readonly expandedAnchors: ReadonlyMap<string, string>
  } {
    const anchors = new Map<string, string>()
    const ids = [...this._model.selection]
    if (this._model.focused !== null) ids.push(this._model.focused)
    if (this._model.anchor !== null) ids.push(this._model.anchor)
    for (const id of ids) {
      if (!anchors.has(id)) anchors.set(id, this._compactChainHead(URI.parse(id)).toString())
    }
    // 展开状态同样以链头保存：重读后链伸缩时行 id 会变，映射到新的可见链尾。
    const expandedAnchors = new Map<string, string>()
    const expandedIds = this._model.getExpandedIds()
    for (const id of expandedIds) {
      if (!expandedAnchors.has(id)) {
        expandedAnchors.set(id, this._compactChainHead(URI.parse(id)).toString())
      }
    }
    return {
      anchors,
      selection: [...this._model.selection],
      focused: this._model.focused,
      anchor: this._model.anchor,
      selectionEpoch: this._model.selectionEpoch,
      visibleIds: new Set(this._model.getVisibleNodes().map((node) => node.id)),
      expandedIds,
      expandedAnchors,
    }
  }

  /**
   * Re-resolve ids orphaned by a chain reshape onto the row that now covers
   * them, walking down from the anchor captured before the re-read.
   *
   * Only ids that used to be on screen and resolve back to a *visible* row are
   * moved: a row hidden under a collapsed ancestor, or one whose resource is
   * simply gone, is orphaned for reasons a chain walk cannot fix, and moving it
   * would send focus somewhere the user never pointed at.
   */
  private _remapSelectionToCompact(state: {
    readonly anchors: Map<string, string>
    readonly selection: readonly string[]
    readonly focused: string | null
    readonly anchor: string | null
    readonly selectionEpoch: number
    readonly visibleIds: ReadonlySet<string>
    readonly expandedIds: readonly string[]
    readonly expandedAnchors: ReadonlyMap<string, string>
  }): void {
    const model = this._model
    const {
      anchors,
      selection: previousSelection,
      focused: previousFocused,
      anchor: previousAnchor,
      visibleIds,
    } = state
    if (
      model.focused === null &&
      model.selection.length === 0 &&
      previousFocused === null &&
      previousSelection.length === 0
    ) {
      return
    }
    const visible = new Set(model.getVisibleNodes().map((n) => n.id))
    const remap = (id: string): string => {
      if (visible.has(id)) return id
      const anchor = anchors.get(id)
      if (anchor === undefined) return id
      const tail = this._compactChainTail(URI.parse(anchor)).toString()
      return visible.has(tail) ? tail : id
    }
    // A row that was on screen and is neither visible nor reshaped onto a
    // visible tail was really removed (recovery already pruned it); anything
    // that was not on screen before must stay selected, it may just be hidden.
    const keepPrevious = (id: string): string | null => {
      const mapped = remap(id)
      if (visible.has(mapped)) return mapped
      return visibleIds.has(id) ? null : id
    }

    // A chain reshape must not silently reset an in-progress Shift range to
    // the remapped focus; move the anchor the same way as any other id. If the
    // user re-anchored while the reload was in flight, the snapshot is stale —
    // omit the option so setSelection anchors at the live focus instead.
    const anchorSnapshotCurrent = model.selectionEpoch === state.selectionEpoch
    const remappedAnchor = previousAnchor === null ? null : keepPrevious(previousAnchor)

    const remappedPreviousFocus = previousFocused === null ? null : remap(previousFocused)
    // 旧焦点行换了新链 id：恢复逻辑因旧 id 消失而猜的后继行及其选区座位要丢弃；
    // 仅限用户期间没有改选，否则以用户的实时选择为准。
    const focusReshaped =
      anchorSnapshotCurrent &&
      remappedPreviousFocus !== null &&
      visible.has(remappedPreviousFocus) &&
      remappedPreviousFocus !== previousFocused

    const selection: string[] = []
    const push = (id: string | null): void => {
      if (id !== null && !selection.includes(id)) selection.push(id)
    }
    if (focusReshaped) {
      for (const id of previousSelection) push(keepPrevious(id))
    } else if (anchorSnapshotCurrent) {
      for (const id of model.selection) push(remap(id))
      for (const id of previousSelection) push(keepPrevious(id))
    } else {
      // 用户在重读期间改选：只映射实时选区，不恢复旧快照里的行。
      for (const id of model.selection) push(remap(id))
    }
    const focused = focusReshaped
      ? remappedPreviousFocus
      : model.focused === null
        ? null
        : remap(model.focused)
    const changed =
      selection.length !== model.selection.length ||
      focused !== model.focused ||
      selection.some((id, i) => id !== model.selection[i])
    if (changed) {
      model.setSelection(selection, focused, {
        reveal: false,
        ...(anchorSnapshotCurrent ? { anchor: remappedAnchor } : {}),
      })
    }
  }

  /**
   * compact 链伸缩让可见行换了 id 时，把原来的展开态迁到接替它的行上
   * （例如中间节点冒出兄弟目录，行 id 从链尾退回该中间节点）。只处理重读前
   * 在屏幕上的 id；藏在折叠祖先下的展开后代不归这里管。
   */
  private _remapExpansionToCompact(state: {
    readonly expandedIds: readonly string[]
    readonly expandedAnchors: ReadonlyMap<string, string>
    readonly visibleIds: ReadonlySet<string>
  }): void {
    const model = this._model
    if (state.expandedIds.length === 0) return
    const visible = new Set(model.getVisibleNodes().map((node) => node.id))
    const updates: Array<readonly [string, boolean]> = []
    for (const id of state.expandedIds) {
      // 用户在重读期间折叠了旧行：这是更新的意图，不能把展开态搬到新行上。
      if (!model.isExpanded(id)) continue
      if (!state.visibleIds.has(id) || visible.has(id)) continue
      const head = state.expandedAnchors.get(id)
      if (head === undefined) continue
      const tail = this._compactChainTail(URI.parse(head)).toString()
      if (tail === id || !visible.has(tail)) continue
      if (!model.isExpanded(tail)) updates.push([tail, true])
      // 旧 id 不再对应任何行；保持折叠，避免链以后再变长时复活用户没设过的展开。
      updates.push([id, false])
    }
    if (updates.length > 0) model.setExpansion(updates)
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

  /**
   * 按需解析单目录链：读取 `resource`（展开时从链头开始，避免绕过中间节点的
   * 变化），然后仅当过滤后的子项恰好是一个目录时继续。遇分叉立即停止——绝不
   * 扫描分叉子树。链续读沿用 compact 日志标签。
   */
  private async _loadChain(
    resource: URI,
    source: LoadSource,
    generation: number,
    walkToHead: boolean,
  ): Promise<void> {
    // 先记下本次请求开始时的显示链头：读取会让链形变化，事后再从旧链尾向上
    // 走就找不到原来的链头了（中间目录可能已经折进新的行里）。
    const head = walkToHead ? this._compactChainHead(resource) : resource
    this._ensureNode(resource).expansionChainHead = head
    let current = head
    let currentSource: LoadSource = sameUri(current, resource) ? source : 'compact'
    for (let depth = 0; depth < 20; depth++) {
      if (generation !== this._generation) return
      const node = this._ensureNode(current)
      const needsRead = node.stale || node.children === null
      const force = node.stale || node.error !== null
      if (needsRead || node.error !== null) {
        await this._scheduleLoad(current, force, currentSource, generation)
        if (generation !== this._generation) return
      }
      const children = node.children
      if (!children || children.length !== 1) return
      const next = children[0]
      if (!next || !next.isDirectory) return
      current = next.resource
      currentSource = 'compact'
    }
  }

  /** `resource` 到其 compact 链头的目录路径（含两端）。 */
  private _compactChainPath(resource: URI): URI[] {
    const chain = [resource]
    let cursor = resource
    for (let depth = 0; depth < 20; depth++) {
      const parent = this.getParent(cursor)
      if (parent === null || !this._isSingleDirChild(parent)) break
      chain.push(parent)
      cursor = parent
    }
    return chain
  }

  /** 行 id 所在的 compact 链（向上到链头）是否都还能回答一次新展开。 */
  private _isCompactChainFresh(resource: URI): boolean {
    let cursor = resource
    for (let depth = 0; depth < 20; depth++) {
      const parent = this.getParent(cursor)
      if (parent === null) return true
      const parentNode = this._nodes.get(parent.toString())
      if (!parentNode) return true
      // 父节点失效时它的单子目录判断也不可信，整条链按未验证处理。
      if (parentNode.stale || parentNode.children === null) return false
      if (!this._isSingleDirChild(parent)) return true
      cursor = parent
    }
    return true
  }

  /** Re-read regardless of what is cached. */
  private _reloadNode(resource: URI, generation = this._generation): Promise<void> {
    return this._scheduleLoad(resource, true, 'refresh', generation)
  }

  /**
   * 所有目录读取的唯一入口（single-flight）。force（刷新 / watcher）不给在途读取另起并发 list，
   * 而是打 trailing 标记让 drain 循环再读一轮。
   */
  private _scheduleLoad(
    resource: URI,
    force: boolean,
    source: LoadSource,
    generation: number,
  ): Promise<void> {
    if (generation !== this._generation) return Promise.resolve()
    const node = this._ensureNode(resource)
    if (!force && node.children !== null && !node.trailing) return Promise.resolve()
    node.source = source
    if (force) node.trailing = true
    if (!node.pending) node.pending = this._drainLoads(resource, node, generation)
    return node.pending
  }

  private async _drainLoads(resource: URI, node: NodeState, generation: number): Promise<void> {
    const key = resource.toString()
    try {
      do {
        node.trailing = false
        await this._loadChildren(resource, node, generation, node.source)
      } while (node.trailing && this._isLiveLoad(key, node, generation))
    } finally {
      // pending 与循环退场在同一同步时刻清空：晚一个微任务会把落在窗口里的请求挂到已停的循环上。
      node.pending = null
    }
  }

  /** 单链续读只在加载/刷新后执行；不可从 _loadChildren 调用，否则会递归整棵树。 */
  private async _loadChildren(
    resource: URI,
    node: NodeState,
    generation: number,
    source: LoadSource,
  ): Promise<void> {
    const key = resource.toString()
    node.loading = true
    node.error = null
    // list 期间到达的失效必须先记下版本：提交时版本变了就不能把 stale 清掉，
    // 否则这次读取的旧结果会被当成最新内容。
    const invalidationAtStart = node.invalidationVersion
    const readStart = performance.now()
    let readWall = 0
    let processStart = readStart
    let processWall = 0
    let sortMs = 0
    let sortStart = readStart
    try {
      const entries = await this._fileService.list(resource)
      // list 跨 IPC + provider await：readWall 是 renderer 等待的墙钟，不是 CPU。
      readWall = performance.now() - readStart
      if (!this._isLiveLoad(key, node, generation)) return
      const root = this._root
      processStart = performance.now()
      const children = await processDirectoryEntries(
        entries,
        resource,
        root ? relativeTo(root, resource) : '',
        root ? (relPath, isDirectory) => this._isPathVisible(relPath, isDirectory) : undefined,
        (ms, startTime) => {
          sortMs = ms
          sortStart = startTime
        },
      )
      processWall = performance.now() - processStart
      if (!this._isLiveLoad(key, node, generation)) return
      node.children = children
      if (node.invalidationVersion === invalidationAtStart) node.stale = false
      this._logger.debug(`loadChildren ${key} entries=${children.length}`)
      this._reportDirectoryRead({
        resource,
        source,
        total: entries.length,
        visible: children.length,
        readStart,
        readWall,
        processStart,
        processWall,
        sortMs,
        sortStart,
      })
    } catch (err) {
      if (!this._isLiveLoad(key, node, generation)) return
      node.children = []
      node.error = err instanceof Error ? err.message : String(err)
      if (node.invalidationVersion === invalidationAtStart) node.stale = false
      this._logger.warn(`loadChildren failed ${key}`, node.error)
    } finally {
      node.loading = false
    }
  }

  /** 这次读取仍是树想要的：generation 未变且 key 上还是同一节点对象。 */
  private _isLiveLoad(key: string, node: NodeState, generation: number): boolean {
    return generation === this._generation && this._nodes.get(key) === node
  }

  /** 慢/超大目录的归因入口，只记条数、来源与 URI，绝不记文件名。 */
  private _reportDirectoryRead(report: IDirectoryReadReport): void {
    const {
      resource,
      source,
      total,
      visible,
      readStart,
      readWall,
      processStart,
      processWall,
      sortMs,
      sortStart,
    } = report
    if (
      readWall < SLOW_LIST_READ_MS &&
      processWall < SLOW_LIST_PROCESS_MS &&
      total < LARGE_DIRECTORY_ENTRIES
    ) {
      return
    }
    pushPerfPhaseSample(`explorer.listReadWall (${source}, ipc, not cpu)`, readStart, readWall)
    pushPerfPhaseSample(
      `explorer.processWall (${source}, awaits, not cpu)`,
      processStart,
      processWall,
    )
    if (sortMs > 0) {
      pushPerfPhaseSample(`explorer.sortEntries (${source}, sync)`, sortStart, sortMs)
    }
    this._logger.warn(
      `slow directory ${resource.toString()} entries=${total} visible=${visible} source=${source} readWall=${readWall.toFixed(1)}ms processWall=${processWall.toFixed(1)}ms sort=${sortMs.toFixed(1)}ms`,
    )
  }

  /**
   * Two independent filters, both anchored on the workspace root: the
   * `files.exclude` blacklist and the focus-folder whitelist. Focus keeps
   * ancestor directories of a focus folder visible so the subtree stays
   * reachable — see focusScopeUtils.
   */
  private _isPathVisible(relPath: string, isDirectory: boolean): boolean {
    if (this._exclude.isExcluded(relPath, 'files')) return false
    return this._focus.isVisible(relPath, isDirectory)
  }

  private _isEntryVisible(root: URI, entry: IExplorerEntry): boolean {
    return this._isPathVisible(relativeTo(root, entry.resource), entry.isDirectory)
  }
}
