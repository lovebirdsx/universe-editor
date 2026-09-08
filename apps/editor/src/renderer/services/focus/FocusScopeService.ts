/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FocusScopeService — single source of truth for the "focus folders" scope.
 *
 *  On a very large workspace, excluding noise folder by folder via
 *  `files.exclude` does not scale: the user knows which two or three subtrees
 *  they care about, not the hundred they don't. Focus folders invert that — a
 *  path whitelist that drives two separate things from one setting:
 *
 *    - Filter — what the user sees. Composed into IExcludeService, so the
 *      Explorer, search results, Quick Open and @-mention all narrow with no
 *      changes of their own.
 *    - Scope  — what the editor scans. Exposed as `scanRoots`, handed to
 *      ripgrep as positional arguments, to @parcel/watcher as subscribe
 *      directories, and to the workspace file listing.
 *
 *  A focus entry may name a *file* as well as a directory — the setting is a
 *  path whitelist, and "this one batch file" is a legitimate path. Because the
 *  downstream consumers differ in kind (ripgrep takes either as a positional
 *  argument, but a recursive watcher subscription needs a directory), the
 *  service classifies entries against the disk: `folders` / `files` /
 *  `pendingFiles` (configured but currently missing). Classification is async
 *  by nature, so the service is optimistic: entries start out treated as
 *  directories (the historical behaviour, so the first frame is bit-identical)
 *  and the buckets are corrected once stat answers, firing one extra
 *  onDidChange only when the correction actually changed something.
 *
 *  Focus is a *view* constraint, not access control: opening a file outside the
 *  focus set from search results, go-to-definition or SCM keeps working. That
 *  mirrors VSCode, where a file excluded from the Explorer still shows once it
 *  is open in an editor.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  Disposable,
  Emitter,
  IConfigurationService,
  IFileService,
  IFileWatcherService,
  IUriIdentityService,
  IWorkspaceService,
  URI,
  createDecorator,
  registerSingletonFactory,
  type Event,
  type IConfigurationService as IConfigurationServiceType,
  type IFileService as IFileServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type IUriIdentityService as IUriIdentityServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'

import {
  classifyFocusEntries,
  isFocusVisible,
  normalizeFocusFolders,
  type FocusEntryKind,
} from './focusScopeUtils.js'

export const FOCUS_ENABLED = 'workspace.focusEnabled'
export const FOCUS_FOLDERS = 'workspace.focusFolders'
export const FOCUS_SHOW_ROOT_FILES = 'workspace.focusShowRootFiles'

/**
 * File-kind classification inputs. Optional with a sensible default (no
 * classification) so the service can be constructed without the disk-touching
 * dependencies — tests exercise the configuration semantics standalone. The
 * production DI graph always provides both.
 */
export interface FocusClassificationDeps {
  readonly fileService: Pick<IFileServiceType, 'stat'>
  readonly fileWatcher: Pick<IFileWatcherServiceType, 'onDidChangeFiles'>
}

export interface IFocusScopeService {
  readonly _serviceBrand: undefined

  /** Whether focus mode is on *and* resolves to at least one entry. */
  readonly active: boolean

  /**
   * The raw `workspace.focusEnabled` value, independent of whether any entry
   * is configured. The status bar needs this to tell "off" from "on but empty".
   */
  readonly enabled: boolean

  /**
   * Canonical workspace-relative focus entries (forward slashes, no leading or
   * trailing separator, nested entries collapsed), whatever their disk kind.
   * Empty when focus is off. This is the configured set; {@link folders} and
   * {@link files} are the disk-classified split of it.
   */
  readonly entries: readonly string[]

  /**
   * Focus entries the disk reports as directories. Before the async
   * classification lands, *all* entries are optimistically reported here (the
   * historical behaviour), so synchronous consumers never stall on stat.
   */
  readonly folders: readonly string[]

  /**
   * Focus entries the disk reports as files. A file entry scopes exactly that
   * one file — search, watcher and the tree all treat it as a point, not a
   * subtree.
   */
  readonly files: readonly string[]

  /**
   * Focus entries whose stat failed (deleted, or not synced yet). They stay
   * out of the scope but keep a watcher so the scope self-corrects when the
   * entry appears.
   */
  readonly pendingFiles: readonly string[]

  /** Whether files directly in the workspace root stay visible. */
  readonly showRootFiles: boolean

  /**
   * Directories the editor should scan. The focus folders when focus is active,
   * otherwise the single workspace root. Empty when no workspace is open.
   *
   * Callers that scan *recursively* should use this directly. Callers that also
   * need root-level files (which live outside every focus folder) should pair it
   * with {@link rootFilesInScope}. Callers that take ripgrep positional
   * arguments (which accept files too) should use {@link scanPaths} instead.
   */
  readonly scanRoots: readonly URI[]

  /**
   * Workspace-relative paths to hand to ripgrep as positional arguments:
   * {@link folders} plus {@link files}, minus any root-level file already
   * covered by a root enumeration when {@link rootFilesInScope} is on. Empty
   * when focus is off. **Active-with-empty is meaningful** ("focused on
   * nothing scannable yet") and callers must forward the empty array rather
   * than dropping it — dropping it reads as "unfocused" downstream.
   */
  readonly scanPaths: readonly string[]

  /**
   * URIs of the file-kind entries (confirmed and pending) needing a file-level
   * watch — the watcher subscribes to their parent directories non-recursively
   * and filters to exact hits.
   */
  readonly fileWatchPaths: readonly URI[]

  /**
   * Whether the workspace root needs covering beyond {@link scanRoots} to pick
   * up its direct files — true only when focus is active and `showRootFiles` is
   * on. The watcher answers this with a non-recursive subscription; a search
   * answers it by adding the root's own files to the query.
   */
  readonly rootFilesInScope: boolean

  /** Whether a workspace-relative path is visible under the current focus set. */
  isVisible(relPath: string, isDirectory: boolean): boolean

  /**
   * Turn focus mode on or off, persisting to the Project layer (same as the
   * folder set — see `_writeFolders` for why that layer and not User).
   *
   * Enabling with no entries configured leaves `active` false — the toggle and
   * the entry list are separate settings, and silently inventing an entry set
   * would be worse than a visibly empty focus, which the status bar calls out.
   */
  setEnabled(enabled: boolean): Promise<void>

  /**
   * Replace the whole focus set with `relPaths` and turn focus on. An empty list
   * turns focus off.
   */
  setFolders(relPaths: readonly string[]): Promise<void>

  /** Add `relPaths` to the focus set and turn focus on. */
  addFolders(relPaths: readonly string[]): Promise<void>

  /**
   * Remove `relPaths` from the focus set. Removing the last one turns focus off
   * rather than leaving it on with nothing focused, which would look identical
   * to unfocused but keep the status bar claiming otherwise.
   */
  removeFolders(relPaths: readonly string[]): Promise<void>

  /**
   * Whether `relPath` is one of the configured focus entries that the disk
   * reports as a directory (as opposed to merely being inside one). Drives
   * which context-menu entries are offered.
   */
  isFocusFolder(relPath: string): boolean

  /** Whether `relPath` is a configured focus entry the disk reports as a file. */
  isFocusFile(relPath: string): boolean

  /**
   * Whether `relPath` is any configured focus entry (directory or file).
   * Drives which context-menu entries are offered on the entry itself.
   */
  isFocusEntry(relPath: string): boolean

  /**
   * A value that changes whenever the resolved scope changes. Consumers that
   * cache scan results keyed by scope mix this into their cache key.
   */
  readonly fingerprint: string

  readonly onDidChange: Event<void>
}

export const IFocusScopeService = createDecorator<IFocusScopeService>('focusScopeService')

const RECLASSIFY_DEBOUNCE_MS = 300

export class FocusScopeService extends Disposable implements IFocusScopeService {
  declare readonly _serviceBrand: undefined

  private _enabled = false
  private _entries: readonly string[] = []
  private _folders: readonly string[] = []
  private _files: readonly string[] = []
  private _pendingFiles: readonly string[] = []
  private _showRootFiles = true
  private _fingerprint = ''

  /**
   * Generation counter guarding the async classification: a recompute (config
   * or workspace change) invalidates any stat round still in flight, which
   * must never land its now-stale buckets over a newer configuration.
   */
  private _generation = 0
  private _reclassifyTimer: ReturnType<typeof setTimeout> | undefined
  private readonly _classificationDeps: FocusClassificationDeps | undefined

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  constructor(
    @IConfigurationService private readonly _config: IConfigurationServiceType,
    @IWorkspaceService private readonly _workspace: IWorkspaceServiceType,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityServiceType,
    @IFileService fileService: IFileServiceType | undefined,
    @IFileWatcherService fileWatcher: IFileWatcherServiceType | undefined,
  ) {
    super()
    this._classificationDeps = fileService && fileWatcher ? { fileService, fileWatcher } : undefined
    this._recompute()

    this._register(
      this._config.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(FOCUS_ENABLED) ||
          e.affectsConfiguration(FOCUS_FOLDERS) ||
          e.affectsConfiguration(FOCUS_SHOW_ROOT_FILES)
        ) {
          this._recomputeAndFire()
        }
      }),
    )

    // The scan roots are derived from the workspace root, so a folder switch
    // invalidates them even when the settings themselves did not change.
    this._register(this._workspace.onDidChangeWorkspace(() => this._recomputeAndFire()))

    // A focus entry changing kind on disk (a focused file deleted, a pending
    // entry created, a file replaced by a directory) never touches the
    // configuration, so only the watcher can correct the buckets. Debounced:
    // a sync may rewrite a whole subtree in one burst.
    const deps = this._classificationDeps
    if (deps) {
      this._register(
        deps.fileWatcher.onDidChangeFiles((events) => {
          if (this._entries.length === 0) return
          if (!events.some((event) => this._touchesFocusEntry(event.resource))) return
          this._scheduleReclassify()
        }),
      )
    }
  }

  override dispose(): void {
    if (this._reclassifyTimer !== undefined) clearTimeout(this._reclassifyTimer)
    super.dispose()
  }

  get active(): boolean {
    return this._enabled && this._entries.length > 0
  }

  get enabled(): boolean {
    return this._enabled
  }

  get entries(): readonly string[] {
    return this._entries
  }

  get folders(): readonly string[] {
    return this._folders
  }

  get files(): readonly string[] {
    return this._files
  }

  get pendingFiles(): readonly string[] {
    return this._pendingFiles
  }

  get showRootFiles(): boolean {
    return this._showRootFiles
  }

  get scanRoots(): readonly URI[] {
    const root = this._workspace.current?.folder
    if (!root) return []
    if (!this.active) return [root]
    return this._folders.map((rel) => URI.joinPath(root, rel))
  }

  get scanPaths(): readonly string[] {
    if (!this.active) return []
    // A root-level focus file is already covered by the root enumeration a
    // rootFilesInScope consumer performs; passing it as a positional argument
    // too would report it twice.
    const coveredByRoot = this.rootFilesInScope
      ? new Set(
          this._files.filter((rel) => !rel.includes('/')).map((rel) => this._entryKey(rel) ?? rel),
        )
      : undefined
    return [
      ...this._folders,
      ...this._files.filter((rel) => {
        if (rel.includes('/')) return true
        const key = this._entryKey(rel) ?? rel
        return !(coveredByRoot?.has(key) ?? false)
      }),
    ]
  }

  get fileWatchPaths(): readonly URI[] {
    const root = this._workspace.current?.folder
    if (!root || !this.active) return []
    return [...this._files, ...this._pendingFiles].map((rel) => URI.joinPath(root, rel))
  }
  get rootFilesInScope(): boolean {
    return this.active && this._showRootFiles
  }

  get fingerprint(): string {
    return this._fingerprint
  }

  isVisible(relPath: string, isDirectory: boolean): boolean {
    if (!this.active) return true
    return isFocusVisible(
      relPath,
      isDirectory,
      this._folders,
      this._files,
      this._showRootFiles,
      this._uriIdentity,
    )
  }

  /**
   * Recompute and notify when anything observable changed.
   *
   * The comparison covers `enabled` on top of the fingerprint: with no entries
   * configured, flipping the toggle leaves the resolved scope untouched, but the
   * status bar still distinguishes "off" from "on with nothing focused". The
   * fingerprint deliberately stays scope-only so scan caches keyed on it are not
   * invalidated by a toggle that cannot change a scan result.
   */
  private _recomputeAndFire(): void {
    const before = this._fingerprint
    const wasEnabled = this._enabled
    this._recompute()
    if (this._fingerprint !== before || this._enabled !== wasEnabled) this._onDidChange.fire()
  }

  isFocusFolder(relPath: string): boolean {
    const key = this._entryKey(relPath)
    if (key === undefined) return false
    return this._folders.some((folder) => this._entryKey(folder) === key)
  }

  isFocusFile(relPath: string): boolean {
    const key = this._entryKey(relPath)
    if (key === undefined) return false
    return this._files.some((file) => this._entryKey(file) === key)
  }

  isFocusEntry(relPath: string): boolean {
    return this.isFocusFolder(relPath) || this.isFocusFile(relPath)
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this._enabled === enabled) return
    this._config.update(FOCUS_ENABLED, enabled, ConfigurationTarget.Project)
  }

  async setFolders(relPaths: readonly string[]): Promise<void> {
    await this._writeFolders(this._canonicalize(relPaths))
  }

  async addFolders(relPaths: readonly string[]): Promise<void> {
    const added = this._canonicalize(relPaths)
    if (added.length === 0) return
    const addedKeys = new Set(added.map((rel) => this._entryKey(rel)))
    const kept = this._entries.filter((rel) => !addedKeys.has(this._entryKey(rel)))
    await this._writeFolders([...kept, ...added])
  }

  async removeFolders(relPaths: readonly string[]): Promise<void> {
    const keys = new Set(this._canonicalize(relPaths).map((rel) => this._entryKey(rel)))
    if (keys.size === 0) return
    const kept = this._entries.filter((rel) => !keys.has(this._entryKey(rel)))
    if (kept.length === this._entries.length) return
    await this._writeFolders(kept)
  }

  /**
   * Persist `folders` as the complete focus set and align the enable flag with
   * it: an empty set means focus off, since focus-on-with-nothing-focused looks
   * exactly like unfocused while still claiming otherwise in the status bar.
   *
   * Both keys go to the **Project** layer. Focus entries are workspace-relative
   * paths — `Client` means nothing in the next workspace — so persisting them
   * globally would carry a stale focus into every folder the user opens. Project
   * is also what makes the set committable for a team, which is the point.
   *
   * Project is the highest writable layer for these keys, so there is no
   * shadowing layer to clear first and the write takes effect immediately; the
   * resulting configuration event drives the recompute. Entries are written
   * before the flag so the intermediate state is never "focus on, set unknown".
   *
   * The map is written as an explicit `{ path: true }` object, plus `false` for
   * every entry a *lower* layer still contributes. Writing only the survivors
   * would silently re-inherit a removed entry from the user's global settings,
   * so a removal has to be recorded as an explicit cancellation.
   */
  private async _writeFolders(folders: readonly string[]): Promise<void> {
    const next: Record<string, boolean> = {}
    for (const rel of folders) next[rel] = true

    const keptKeys = new Set(folders.map((rel) => this._entryKey(rel)))
    for (const lower of this._lowerLayerFolderKeys()) {
      if (!keptKeys.has(this._entryKey(lower))) next[lower] = false
    }

    this._config.update(FOCUS_FOLDERS, next, ConfigurationTarget.Project)
    this._config.update(FOCUS_ENABLED, folders.length > 0, ConfigurationTarget.Project)
  }

  /**
   * Focus-folder keys owned by layers below Project, e.g. the user's own global
   * focus set. These are the entries a removal must cancel explicitly with
   * `false`, because the per-key merge would otherwise re-inherit them.
   */
  private _lowerLayerFolderKeys(): string[] {
    const out: string[] = []
    for (const target of [
      ConfigurationTarget.Default,
      ConfigurationTarget.VSCodeUser,
      ConfigurationTarget.User,
      ConfigurationTarget.VSCodeWorkspace,
    ]) {
      const raw = this._config.getLayerSnapshot(target)[FOCUS_FOLDERS]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value === true) out.push(key)
      }
    }
    return out
  }

  private _canonicalize(relPaths: readonly string[]): string[] {
    const raw: Record<string, boolean> = {}
    for (const rel of relPaths) raw[rel] = true
    return normalizeFocusFolders(raw, this._uriIdentity)
  }

  /** Identity key for a path, or undefined when it isn't a valid focus entry. */
  private _entryKey(rel: string): string | undefined {
    const canonical = this._canonicalize([rel])[0]
    if (canonical === undefined) return undefined
    return this._uriIdentity.getPathComparisonKey('/' + canonical)
  }

  private _recompute(): void {
    this._enabled = this._config.get<boolean>(FOCUS_ENABLED) ?? false
    this._showRootFiles = this._config.get<boolean>(FOCUS_SHOW_ROOT_FILES) ?? true

    // getMerged (not get) so a higher layer can cancel a lower layer's entry
    // with `false` — the same per-key merge `files.exclude` relies on. That is
    // what lets a user's global focus set and a project's committed one compose
    // instead of one wholly replacing the other.
    const raw = this._config.getMerged<Record<string, unknown>>(FOCUS_FOLDERS)
    this._entries = this._enabled ? normalizeFocusFolders(raw, this._uriIdentity) : []

    // Optimistic classification: every entry a directory. Stat answers on the
    // next tick; until then the scope is exactly what it always was, so the
    // first frame and every synchronous getter are unaffected by the disk.
    // Entries the disk already classified keep their bucket — a config event
    // that does not touch the entry set must not flap a file back to a
    // directory for the duration of one stat round.
    const previousKind = new Map<string, 'directory' | 'file' | 'pending'>()
    for (const rel of this._folders) previousKind.set(this._entryKey(rel) ?? rel, 'directory')
    for (const rel of this._files) previousKind.set(this._entryKey(rel) ?? rel, 'file')
    for (const rel of this._pendingFiles) previousKind.set(this._entryKey(rel) ?? rel, 'pending')

    this._generation++
    const folders: string[] = []
    const files: string[] = []
    const pendingFiles: string[] = []
    for (const rel of this._entries) {
      const kind = previousKind.get(this._entryKey(rel) ?? rel) ?? 'directory'
      if (kind === 'directory') folders.push(rel)
      else if (kind === 'file') files.push(rel)
      else pendingFiles.push(rel)
    }
    this._applyBuckets(folders, files, pendingFiles, this._generation)

    this._reclassify(this._generation)
  }

  /** Land buckets and recompute the fingerprint. */
  private _applyBuckets(
    folders: readonly string[],
    files: readonly string[],
    pendingFiles: readonly string[],
    generation: number,
  ): void {
    if (generation !== this._generation) return
    this._folders = folders
    this._files = files
    this._pendingFiles = pendingFiles

    // Joined with a separator that cannot appear in a folder name or a URI, so
    // two different focus sets never collide. A space would: `['a b', 'c']` and
    // `['a', 'b c']` produce the same string, and folder names with spaces are
    // common enough that a cache keyed on this would serve stale results.
    this._fingerprint = [
      this.active ? '1' : '0',
      this._showRootFiles ? '1' : '0',
      this._workspace.current?.folder.toString() ?? '',
      ...this._folders,
      ...this._files.map((rel) => 'f:' + rel),
      ...this._pendingFiles.map((rel) => 'p:' + rel),
    ].join('\n')
  }

  /** Stat every entry and land the corrected buckets, guarded by generation. */
  private _reclassify(generation: number): void {
    const root = this._workspace.current?.folder
    const entries = this._entries
    const deps = this._classificationDeps
    if (!root || entries.length === 0 || !deps) return

    const stat = async (rel: string): Promise<FocusEntryKind> => {
      const resolved = await deps.fileService.stat(URI.joinPath(root, rel))
      return resolved.isDirectory ? 'directory' : 'file'
    }

    void classifyFocusEntries(entries, stat, this._uriIdentity).then((buckets) => {
      if (generation !== this._generation) return
      if (
        sameSet(buckets.folders, this._folders) &&
        sameSet(buckets.files, this._files) &&
        sameSet(buckets.pendingFiles, this._pendingFiles)
      ) {
        return
      }
      const before = this._fingerprint
      this._applyBuckets(buckets.folders, buckets.files, buckets.pendingFiles, generation)
      if (this._fingerprint !== before) this._onDidChange.fire()
    })
  }

  private _scheduleReclassify(): void {
    if (this._reclassifyTimer !== undefined) clearTimeout(this._reclassifyTimer)
    const generation = this._generation
    this._reclassifyTimer = setTimeout(() => {
      this._reclassifyTimer = undefined
      if (generation !== this._generation) return
      this._reclassify(generation)
    }, RECLASSIFY_DEBOUNCE_MS)
  }

  /** Whether a watcher event can change the disk-kind of a focus entry. */
  private _touchesFocusEntry(resource: URI): boolean {
    const root = this._workspace.current?.folder
    if (!root) return false
    const rootKey = this._uriIdentity.getPathComparisonKey(root.path)
    const key = this._uriIdentity.getPathComparisonKey(resource.path)
    // getPathComparisonKey strips a trailing slash, so compare on `rootKey + '/'`.
    if (!key.startsWith(rootKey + '/')) return false
    const rel = key.slice(rootKey.length + 1)
    if (rel.length === 0) return false
    return this._entries.some((entry) => {
      // Entries are already canonical, so the comparison key is a plain prefix
      // strip — no re-canonicalization per event.
      const relEntry = this._uriIdentity.getPathComparisonKey('/' + entry).slice(1)
      // The event is the entry itself, or something inside it (a directory-kind
      // entry replaced by a file deletes its whole subtree), or an ancestor of
      // it (a parent renamed away strands a pending entry).
      return rel === relEntry || rel.startsWith(relEntry + '/') || relEntry.startsWith(rel + '/')
    })
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((rel) => set.has(rel))
}

// `registerSingletonFactory` rather than the plain ctor overload: the file
// service / watcher are optional injections (production wires both, unit tests
// omit them to disable classification), and the `registerSingleton(id, ctor)`
// signature requires every constructor parameter to be a branded service —
// `T | undefined` fails that constraint even though the runtime resolves an
// unregistered dependency to `undefined`.
registerSingletonFactory(
  IFocusScopeService,
  (acc) =>
    new FocusScopeService(
      acc.get(IConfigurationService),
      acc.get(IWorkspaceService),
      acc.get(IUriIdentityService),
      acc.get(IFileService),
      acc.get(IFileWatcherService),
    ),
  // Eager: the original registration was InstantiationType.Eager; keep
  // supportsDelayedInstantiation=false so event subscriptions land on the real
  // instance synchronously (a lazy proxy would buffer them).
  false,
)
