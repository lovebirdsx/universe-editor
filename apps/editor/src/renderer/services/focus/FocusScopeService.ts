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
  IUriIdentityService,
  IWorkspaceService,
  InstantiationType,
  URI,
  createDecorator,
  registerSingleton,
  type Event,
  type IConfigurationService as IConfigurationServiceType,
  type IUriIdentityService as IUriIdentityServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'

import { isFocusVisible, normalizeFocusFolders } from './focusScopeUtils.js'

export const FOCUS_ENABLED = 'workspace.focusEnabled'
export const FOCUS_FOLDERS = 'workspace.focusFolders'
export const FOCUS_SHOW_ROOT_FILES = 'workspace.focusShowRootFiles'

export interface IFocusScopeService {
  readonly _serviceBrand: undefined

  /** Whether focus mode is on *and* resolves to at least one folder. */
  readonly active: boolean

  /**
   * The raw `workspace.focusEnabled` value, independent of whether any folder
   * is configured. The status bar needs this to tell "off" from "on but empty".
   */
  readonly enabled: boolean

  /**
   * Canonical workspace-relative focus folders (forward slashes, no leading or
   * trailing separator, nested entries collapsed). Empty when focus is off.
   */
  readonly folders: readonly string[]

  /** Whether files directly in the workspace root stay visible. */
  readonly showRootFiles: boolean

  /**
   * Directories the editor should scan. The focus folders when focus is active,
   * otherwise the single workspace root. Empty when no workspace is open.
   *
   * Callers that scan *recursively* should use this directly. Callers that also
   * need root-level files (which live outside every focus folder) should pair it
   * with {@link rootFilesInScope}.
   */
  readonly scanRoots: readonly URI[]

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
   * Enabling with no folders configured leaves `active` false — the toggle and
   * the folder list are separate settings, and silently inventing a folder set
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
   * Whether `relPath` is one of the configured focus folders (as opposed to
   * merely being inside one). Drives which context-menu entries are offered.
   */
  isFocusFolder(relPath: string): boolean

  /**
   * A value that changes whenever the resolved scope changes. Consumers that
   * cache scan results keyed by scope mix this into their cache key.
   */
  readonly fingerprint: string

  readonly onDidChange: Event<void>
}

export const IFocusScopeService = createDecorator<IFocusScopeService>('focusScopeService')

export class FocusScopeService extends Disposable implements IFocusScopeService {
  declare readonly _serviceBrand: undefined

  private _enabled = false
  private _folders: readonly string[] = []
  private _showRootFiles = true
  private _fingerprint = ''

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  constructor(
    @IConfigurationService private readonly _config: IConfigurationServiceType,
    @IWorkspaceService private readonly _workspace: IWorkspaceServiceType,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityServiceType,
  ) {
    super()
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
  }

  get active(): boolean {
    return this._enabled && this._folders.length > 0
  }

  get enabled(): boolean {
    return this._enabled
  }

  get folders(): readonly string[] {
    return this._folders
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
      this._showRootFiles,
      this._uriIdentity,
    )
  }

  /**
   * Recompute and notify when anything observable changed.
   *
   * The comparison covers `enabled` on top of the fingerprint: with no folders
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
    const key = this._folderKey(relPath)
    if (key === undefined) return false
    return this._folders.some((folder) => this._folderKey(folder) === key)
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
    const addedKeys = new Set(added.map((rel) => this._folderKey(rel)))
    const kept = this._folders.filter((rel) => !addedKeys.has(this._folderKey(rel)))
    await this._writeFolders([...kept, ...added])
  }

  async removeFolders(relPaths: readonly string[]): Promise<void> {
    const keys = new Set(this._canonicalize(relPaths).map((rel) => this._folderKey(rel)))
    if (keys.size === 0) return
    const kept = this._folders.filter((rel) => !keys.has(this._folderKey(rel)))
    if (kept.length === this._folders.length) return
    await this._writeFolders(kept)
  }

  /**
   * Persist `folders` as the complete focus set and align the enable flag with
   * it: an empty set means focus off, since focus-on-with-nothing-focused looks
   * exactly like unfocused while still claiming otherwise in the status bar.
   *
   * Both keys go to the **Project** layer. Focus folders are workspace-relative
   * paths — `Client` means nothing in the next workspace — so persisting them
   * globally would carry a stale focus into every folder the user opens. Project
   * is also what makes the set committable for a team, which is the point.
   *
   * Project is the highest writable layer for these keys, so there is no
   * shadowing layer to clear first and the write takes effect immediately; the
   * resulting configuration event drives the recompute. Folders are written
   * before the flag so the intermediate state is never "focus on, set unknown".
   *
   * The map is written as an explicit `{ path: true }` object, plus `false` for
   * every entry a *lower* layer still contributes. Writing only the survivors
   * would silently re-inherit a removed folder from the user's global settings,
   * so a removal has to be recorded as an explicit cancellation.
   */
  private async _writeFolders(folders: readonly string[]): Promise<void> {
    const next: Record<string, boolean> = {}
    for (const rel of folders) next[rel] = true

    const keptKeys = new Set(folders.map((rel) => this._folderKey(rel)))
    for (const lower of this._lowerLayerFolderKeys()) {
      if (!keptKeys.has(this._folderKey(lower))) next[lower] = false
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

  /** Identity key for a path, or undefined when it isn't a valid focus folder. */
  private _folderKey(rel: string): string | undefined {
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
    this._folders = this._enabled ? normalizeFocusFolders(raw, this._uriIdentity) : []

    // Joined with a separator that cannot appear in a folder name or a URI, so
    // two different focus sets never collide. A space would: `['a b', 'c']` and
    // `['a', 'b c']` produce the same string, and folder names with spaces are
    // common enough that a cache keyed on this would serve stale results.
    this._fingerprint = [
      this.active ? '1' : '0',
      this._showRootFiles ? '1' : '0',
      this._workspace.current?.folder.toString() ?? '',
      ...this._folders,
    ].join('\n')
  }
}

registerSingleton(IFocusScopeService, FocusScopeService, InstantiationType.Eager)
