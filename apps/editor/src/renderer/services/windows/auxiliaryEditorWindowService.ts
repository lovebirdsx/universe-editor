/*---------------------------------------------------------------------------------------------
 *  AuxiliaryEditorWindowService — lifecycle of auxiliary editor windows.
 *
 *  Each auxiliary window is a same-origin `about:blank` popup owned by this
 *  renderer. It gets its own `IEditorPart` (layout) but shares every DI service,
 *  editor input, Monaco model and the extension host with the main window. This
 *  service drives creation (through the parent-scoped main IPC channel), the
 *  close/migrate transaction, "restore to main window" and workspace restore.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  Emitter,
  type Event,
  EditorInput,
  GroupDirection,
  GroupsOrder,
  IEditorGroupsService,
  IInstantiationService,
  ILoggerService,
  INotificationService,
  Severity,
  createDecorator,
  localize,
  setParentOfDisposable,
  type IEditorGroup,
  type IEditorPart,
  type ILogger,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { cloneEditorInputForSplit } from '../editor/cloneEditorInput.js'
import type { EditorPart } from '../editor/EditorPart.js'
import type { ISerializedEditorGroupsState } from '../editor/editorGroupsPersistence.js'
import {
  type AuxiliaryWindowBounds,
  type AuxiliaryWindowGeometry,
  IAuxiliaryWindowsService,
} from '../../../shared/ipc/auxiliaryWindowService.js'
import { AUXILIARY_WINDOW_MARKER_KEY } from '../../../shared/ipc/auxiliaryWindowService.js'
import { ensureAuxiliaryRoot, mirrorDocumentChrome } from './mirrorDocumentChrome.js'
import { registerMonacoWindow } from './monacoWindowRegistration.js'
import { IWorkbenchWindowService, type IWorkbenchWindow } from './workbenchWindowService.js'
import { IWindowFocusService } from './windowFocusService.js'

/** Window pre-paint color: the theme's title bar background (main draws it too). */
function readTitleBarBackground(doc: Document): string | undefined {
  const view = doc.defaultView
  if (!view) return undefined
  const value = view
    .getComputedStyle(doc.documentElement)
    .getPropertyValue('--vscode-titleBar-activeBackground')
    .trim()
  return value.length > 0 ? value : undefined
}

export interface IAuxiliaryEditorWindow {
  readonly token: string
  readonly part: IEditorPart
  readonly window: IWorkbenchWindow
  readonly explicitEmpty: boolean
}

export interface CreateAuxiliaryEditorWindowOptions {
  /** Activate the new window immediately (default true). */
  readonly activate?: boolean
  /** Keep an empty window open until the user closes it. */
  readonly explicitEmpty?: boolean
  readonly geometry?: AuxiliaryWindowGeometry
  /** Initial placement (drag-out); clamped by the main process. */
  readonly bounds?: AuxiliaryWindowBounds
  /** Fullscreen on a different display when one exists (see the wire contract). */
  readonly preferOtherDisplayFullscreen?: boolean
  readonly title?: string
  /** Pre-created part (workspace restore creates + hydrates it first). */
  readonly part?: EditorPart
}

export type OpenEditorInNewWindowMode = 'open' | 'move' | 'copy'

export interface OpenEditorInNewWindowOptions {
  /** Defaults to 'open'. `move`/`copy` require `source`. */
  readonly mode?: OpenEditorInNewWindowMode
  /** The group currently holding `editor`; required for `move`/`copy`. */
  readonly source?: IEditorGroup
  /** Pin the opened editor (only used by `open`; default true). */
  readonly pinned?: boolean
  /** Initial placement (drag-out); clamped by the main process. */
  readonly bounds?: AuxiliaryWindowBounds
  readonly preferOtherDisplayFullscreen?: boolean
  /** Activate/focus the new window (default true). */
  readonly activate?: boolean
}

export type OpenEditorInNewWindowResult =
  | {
      readonly ok: true
      readonly window: IAuxiliaryEditorWindow
      /** The instance in the target group (the clone for `copy`). */
      readonly editor: EditorInput
    }
  | { readonly ok: false; readonly reason: 'uncopyable' | 'error' }

export interface AuxiliaryEditorWindowCreateResult {
  readonly window: IAuxiliaryEditorWindow | undefined
  readonly reason?: 'blocked' | 'uncopyable' | 'error'
  readonly uncopyable?: readonly string[]
}

export interface ISerializedAuxiliaryEditorWindow {
  readonly geometry?: AuxiliaryWindowGeometry
  readonly state: ISerializedEditorGroupsState
  readonly explicitEmpty?: boolean
}

export interface ISerializedAuxiliaryWindowsState {
  readonly windows: readonly ISerializedAuxiliaryEditorWindow[]
  /** Index of the window that was focused, if any. */
  readonly activeIndex?: number
}

export interface IAuxiliaryEditorWindowService {
  readonly _serviceBrand: undefined

  readonly windows: readonly IAuxiliaryEditorWindow[]
  /** Geometry/focus/add/remove changed — persists the window snapshot. */
  readonly onDidChangeWindows: Event<void>

  createEmptyWindow(
    options?: CreateAuxiliaryEditorWindowOptions,
  ): Promise<AuxiliaryEditorWindowCreateResult>
  /**
   * Open `editor` in a new auxiliary window, or move/copy an already-open editor
   * into it. Sharing one EditorInput instance across groups is unsafe, so `open`
   * refuses an input that is still open elsewhere; callers pick `move`/`copy` for
   * that case. On failure an `open` input is left untouched (the caller may fall
   * back and owns disposal).
   */
  openEditorInNewWindow(
    editor: EditorInput,
    options?: OpenEditorInNewWindowOptions,
  ): Promise<OpenEditorInNewWindowResult>
  moveEditorToNewWindow(
    editor: EditorInput,
    source: IEditorGroup,
    bounds?: AuxiliaryWindowBounds,
  ): Promise<boolean>
  copyEditorToNewWindow(
    editor: EditorInput,
    source: IEditorGroup,
    bounds?: AuxiliaryWindowBounds,
  ): Promise<boolean>
  moveGroupToNewWindow(group: IEditorGroup): Promise<boolean>
  copyGroupToNewWindow(group: IEditorGroup): Promise<boolean>

  requestClose(window: IAuxiliaryEditorWindow): Promise<void>
  closeWindow(window: IAuxiliaryEditorWindow): Promise<boolean>
  zoomIn(window: IAuxiliaryEditorWindow): Promise<void>
  zoomOut(window: IAuxiliaryEditorWindow): Promise<void>
  resetZoom(window: IAuxiliaryEditorWindow): Promise<void>

  restoreAllToMainWindow(): void
  /** Drop every window without migrating editors (workspace scope swap). */
  discardAllWindows(): void

  serialize(): ISerializedAuxiliaryWindowsState
  /**
   * Recreate auxiliary windows from a snapshot. Returns the editor instances
   * materialized from the snapshot (also those salvaged after a failed window
   * creation) so the caller can tell them apart from user-opened editors.
   */
  restore(
    state: ISerializedAuxiliaryWindowsState | undefined,
    accessor: ServicesAccessor,
  ): Promise<readonly EditorInput[]>

  getWindowForToken(token: string): IAuxiliaryEditorWindow | undefined
}

export const IAuxiliaryEditorWindowService = createDecorator<IAuxiliaryEditorWindowService>(
  'auxiliaryEditorWindowService',
)

interface WindowEntry {
  readonly token: string
  readonly part: EditorPart
  readonly window: IWorkbenchWindow
  readonly document: Document
  readonly disposables: DisposableStore
  explicitEmpty: boolean
  closing: boolean
  geometry: AuxiliaryWindowGeometry | undefined
}

const EMPTY_STATE: ISerializedAuxiliaryWindowsState = { windows: [] }

function waitForAuxiliaryMarker(child: Window, timeoutMs = 5000): Promise<boolean> {
  const read = (): unknown =>
    (child as Window & { [AUXILIARY_WINDOW_MARKER_KEY]?: unknown })[AUXILIARY_WINDOW_MARKER_KEY]
  const isMarked = (): boolean => {
    const value = read()
    // The dedicated preload exposes an object ({ marker: true }) through
    // contextBridge; contextBridge may also collapse a bare `true` in future.
    return (
      value === true ||
      (typeof value === 'object' &&
        value !== null &&
        (value as { marker?: unknown }).marker === true)
    )
  }
  if (isMarked()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const poll = (): void => {
      if (isMarked()) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline || child.closed) {
        resolve(false)
        return
      }
      setTimeout(poll, 10)
    }
    setTimeout(poll, 0)
  })
}

export class AuxiliaryEditorWindowService
  extends Disposable
  implements IAuxiliaryEditorWindowService
{
  declare readonly _serviceBrand: undefined

  private readonly _entries: WindowEntry[] = []
  private readonly _onDidChangeWindows = this._register(new Emitter<void>())
  readonly onDidChangeWindows: Event<void> = this._onDidChangeWindows.event
  private readonly _logger: ILogger
  private _restoring = false

  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IWorkbenchWindowService private readonly _workbenchWindows: IWorkbenchWindowService,
    @IAuxiliaryWindowsService private readonly _aux: IAuxiliaryWindowsService,
    @IWindowFocusService private readonly _windowFocus: IWindowFocusService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @INotificationService private readonly _notifications: INotificationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'auxiliaryEditorWindow',
      name: 'Auxiliary Editor Windows',
    })

    this._register(
      this._aux.onDidChangeWindowState((state) => {
        const entry = this.getEntry(state.token)
        if (!entry) return
        entry.geometry = state.geometry
        this._onDidChangeWindows.fire()
        // Window focus is the authoritative signal — the DOM focus listener also
        // runs, but offscreen/E2E windows may never receive real OS focus.
        if (state.isFocused) this._activateEntry(entry)
      }),
    )
    this._register(
      this._aux.onDidRequestClose(({ token }) => {
        const entry = this.getEntry(token)
        if (!entry) return
        void this.closeWindow(entry)
      }),
    )
    this._register(
      this._aux.onDidCloseWindow(({ token }) => {
        void this._handleExternalClose(token)
      }),
    )
    this._register(
      this._groups.onDidActivePartChange((part) => {
        // Main is a real window too: switching back to it (focus/pointer in the
        // main document) must make the main window active, otherwise the next
        // open still targets the auxiliary part. `getWindowForPart` enumerates
        // the main entry as well.
        const window = this._workbenchWindows.getWindowForPart(part)
        if (!window) return
        this._workbenchWindows.setActiveWindow(window)
      }),
    )
    this._register(
      this._workbenchWindows.onDidChangeActiveWindow((window) => {
        // The reverse direction. Both `_setActive` and `_setActivePart` bail out
        // when the target is already current, so the two subscriptions cannot
        // ping-pong.
        if (this._groups.activePart === window.part) return
        this._groups.activatePart(window.part, { preserveFocus: true })
      }),
    )
  }

  get windows(): readonly IAuxiliaryEditorWindow[] {
    return this._entries.map((entry) => this._toPublic(entry))
  }

  getWindowForToken(token: string): IAuxiliaryEditorWindow | undefined {
    const entry = this.getEntry(token)
    return entry ? this._toPublic(entry) : undefined
  }

  async createEmptyWindow(
    options: CreateAuxiliaryEditorWindowOptions = {},
  ): Promise<AuxiliaryEditorWindowCreateResult> {
    const entry = await this._createWindow(options)
    return entry ? { window: this._toPublic(entry) } : { window: undefined, reason: 'error' }
  }

  async openEditorInNewWindow(
    editor: EditorInput,
    options: OpenEditorInNewWindowOptions = {},
  ): Promise<OpenEditorInNewWindowResult> {
    const mode = options.mode ?? 'open'
    const source = options.source
    if (mode === 'open') {
      // Two groups must not share one input instance: closing one would dispose
      // the other's tab. Callers pick move/copy when the editor is already open.
      if (this._findGroupContaining(editor)) {
        this._logger.warn(`open in new window refused: editor already open id=${editor.id}`)
        return { ok: false, reason: 'error' }
      }
    } else if (!source || !this._isMoveSourceValid(editor, source)) {
      return { ok: false, reason: 'error' }
    }

    const sticky = mode === 'copy' && source ? source.isSticky(editor) : false
    let clone: EditorInput | undefined
    if (mode === 'copy') {
      clone = this._cloneForCopy(editor)
      if (!clone) {
        this._notifyUncopyable([editor.label])
        return { ok: false, reason: 'uncopyable' }
      }
    }

    const entry = await this._createWindow({
      activate: options.activate !== false,
      explicitEmpty: true,
      ...(options.bounds ? { bounds: options.bounds } : {}),
      ...(options.preferOtherDisplayFullscreen === true
        ? { preferOtherDisplayFullscreen: true }
        : {}),
    })
    if (!entry) {
      clone?.dispose()
      return { ok: false, reason: 'error' }
    }

    const target = entry.part.activeGroup
    try {
      if (mode === 'copy') {
        if (!source || !this._isMoveSourceValid(editor, source) || !this._isEntryOpen(entry)) {
          clone?.dispose()
          await this._discardFailedTarget(entry)
          return { ok: false, reason: 'error' }
        }
        this._groups.copyEditor(clone!, target, { sticky })
        entry.explicitEmpty = false
        return { ok: true, window: this._toPublic(entry), editor: clone! }
      }
      if (mode === 'move') {
        if (!source || !this._isMoveSourceValid(editor, source) || !this._isEntryOpen(entry)) {
          await this._discardFailedTarget(entry)
          return { ok: false, reason: 'error' }
        }
        this._moveEditorOrThrow(editor, target, source)
        entry.explicitEmpty = false
        return { ok: true, window: this._toPublic(entry), editor }
      }
      if (!this._isEntryOpen(entry) || editor.isDisposed) {
        await this._discardFailedTarget(entry)
        return { ok: false, reason: 'error' }
      }
      target.openEditor(editor, { activate: true, pinned: options.pinned !== false })
      entry.explicitEmpty = false
      return { ok: true, window: this._toPublic(entry), editor }
    } catch (err) {
      this._logger.warn(`${mode} editor in new window failed: ${String(err)}`)
      // A clone that never landed is owned by this call; a moved/opened input
      // stays reachable or belongs to the caller.
      if (clone && !this._groups.groups.some((group) => group.contains(clone))) clone.dispose()
      await this._discardFailedTarget(entry)
      return { ok: false, reason: 'error' }
    }
  }

  async moveEditorToNewWindow(
    editor: EditorInput,
    source: IEditorGroup,
    bounds?: AuxiliaryWindowBounds,
  ): Promise<boolean> {
    const result = await this.openEditorInNewWindow(editor, {
      mode: 'move',
      source,
      ...(bounds ? { bounds } : {}),
    })
    return result.ok
  }

  async copyEditorToNewWindow(
    editor: EditorInput,
    source: IEditorGroup,
    bounds?: AuxiliaryWindowBounds,
  ): Promise<boolean> {
    const result = await this.openEditorInNewWindow(editor, {
      mode: 'copy',
      source,
      ...(bounds ? { bounds } : {}),
    })
    return result.ok
  }

  async moveGroupToNewWindow(group: IEditorGroup): Promise<boolean> {
    const snapshot = this._snapshotGroup(group)
    const entry = await this._createWindow({ activate: true, explicitEmpty: true })
    if (!entry) return false
    if (!this._isGroupLive(group) || !this._isEntryOpen(entry)) {
      await this._discardFailedTarget(entry)
      return false
    }
    const target = entry.part.activeGroup
    try {
      for (const editor of snapshot.editors) {
        // The source group may have lost an editor while the window opened.
        if (editor.isDisposed || group.findEditor(editor) !== editor) continue
        this._moveEditorOrThrow(editor, target, group)
        this._restoreSticky(target, editor, snapshot.sticky.has(editor))
      }
      if (snapshot.active && target.contains(snapshot.active)) target.setActive(snapshot.active)
      if (snapshot.locked && target.count > 0) target.lock(true)
      // The source group was the thing being moved; drop it once empty so the
      // main window does not keep a blank split (VSCode moves the group itself).
      if (group.count === 0 && group.part.groups.length > 1) {
        this._groups.removeGroup(group)
      }
      entry.explicitEmpty = false
      return true
    } catch (err) {
      this._logger.warn(`move group failed: ${String(err)}`)
      // Keep whatever landed; only an empty window is closed.
      await this._discardFailedTarget(entry)
      return false
    }
  }

  async copyGroupToNewWindow(group: IEditorGroup): Promise<boolean> {
    // Snapshot everything before the await: the live group may be mutated or
    // torn down while the native window is being created.
    const snapshot = this._snapshotGroup(group)
    const clones: EditorInput[] = []
    const uncopyable: string[] = []
    for (const editor of snapshot.editors) {
      const clone = this._instantiation.invokeFunction((accessor) =>
        cloneEditorInputForSplit(editor, accessor),
      )
      if (clone) clones.push(clone)
      else uncopyable.push(editor.label)
    }
    if (uncopyable.length > 0) {
      for (const clone of clones) clone.dispose()
      this._notifyUncopyable(uncopyable)
      return false
    }
    const entry = await this._createWindow({ activate: true, explicitEmpty: true })
    if (!entry) {
      for (const clone of clones) clone.dispose()
      return false
    }
    if (!this._isGroupLive(group) || !this._isEntryOpen(entry)) {
      for (const clone of clones) clone.dispose()
      await this._discardFailedTarget(entry)
      return false
    }
    const target = entry.part.activeGroup
    try {
      for (let i = 0; i < clones.length; i++) {
        const source = snapshot.editors[i]
        this._groups.copyEditor(clones[i]!, target, {
          sticky: source ? snapshot.sticky.has(source) : false,
        })
      }
      const activeIndex = snapshot.active ? snapshot.editors.indexOf(snapshot.active) : -1
      if (activeIndex >= 0 && clones[activeIndex]) target.setActive(clones[activeIndex]!)
      if (snapshot.locked && target.count > 0) target.lock(true)
      entry.explicitEmpty = false
      return true
    } catch (err) {
      this._logger.warn(`copy group failed: ${String(err)}`)
      // Any clone that never landed in a group is still owned by this call.
      for (const clone of clones) {
        if (!this._groups.groups.some((candidate) => candidate.contains(clone))) {
          clone.dispose()
        }
      }
      await this._discardFailedTarget(entry)
      return false
    }
  }

  async requestClose(window: IAuxiliaryEditorWindow): Promise<void> {
    await this._aux.requestClose(window.token)
  }

  async zoomIn(window: IAuxiliaryEditorWindow): Promise<void> {
    await this._aux.zoomIn(window.token)
  }

  async zoomOut(window: IAuxiliaryEditorWindow): Promise<void> {
    await this._aux.zoomOut(window.token)
  }

  async resetZoom(window: IAuxiliaryEditorWindow): Promise<void> {
    await this._aux.resetZoom(window.token)
  }

  /**
   * Close an auxiliary window the way VSCode does: clean editors are closed,
   * protected (dirty / custom-confirm) editors are migrated to the main window.
   * Returns false when the preflight cannot place a protected editor (veto).
   */
  async closeWindow(window: IAuxiliaryEditorWindow): Promise<boolean> {
    const entry = this.getEntry(window.token)
    if (!entry || entry.closing) return false
    entry.closing = true
    try {
      const groups = entry.part.groups
      const protectedEditors: Array<{ editor: EditorInput; group: IEditorGroup }> = []
      for (const group of groups) {
        for (const editor of group.editors) {
          if (editor.isDirty || editor.confirmClose !== undefined) {
            protectedEditors.push({ editor, group })
          }
        }
      }

      const target = protectedEditors.length > 0 ? this._mainTargetGroup() : undefined
      if (protectedEditors.length > 0 && !target) {
        this._logger.warn(`close vetoed: no unlocked main group for part=${entry.part.id}`)
        entry.closing = false
        return false
      }

      for (const { editor, group } of protectedEditors) {
        // A no-op move here would let the loop below close a dirty tab as
        // "clean". Verify the editor actually left the auxiliary group and
        // landed in the main target (same-id migration still counts).
        this._moveEditorOrThrow(editor, target!, group)
      }
      // Everything left is clean (or was just migrated). Close without prompts.
      for (const group of groups) {
        for (const editor of [...group.editors]) {
          group.closeEditor(editor)
        }
      }

      this._teardownEntry(entry)
      await this._aux.finalizeClose(entry.token)
      this._logger.info(`closed part=${entry.part.id}`)
      return true
    } catch (err) {
      this._logger.warn(`close failed part=${entry.part.id}: ${String(err)}`)
      entry.closing = false
      return false
    }
  }

  discardAllWindows(): void {
    for (const entry of [...this._entries]) {
      this._teardownEntry(entry)
      void this._aux.finalizeClose(entry.token).catch(() => undefined)
    }
    this._discardOrphanParts()
  }

  /**
   * Product behavior (not VSCode's global merge): fold every editor from every
   * auxiliary part into the main part's active group, then close the auxiliary
   * windows. `IMainEditorPart.mergeAllGroups` in VSCode only merges the active
   * part's own groups, so this command deliberately spans parts while leaving
   * the main window's existing layout untouched.
   */
  restoreAllToMainWindow(): void {
    const target = this._groups.mainPart.activeGroup
    for (const entry of [...this._entries]) {
      const complete = this._salvagePart(entry.part, target)
      if (!complete) {
        // Keep the window (and its remaining editors) visible rather than
        // hiding a part that still owns documents.
        this._logger.error(
          `restore all: part ${entry.part.id} still holds editors; leaving token=${entry.token} open`,
        )
        continue
      }
      this._teardownEntry(entry)
      void this._aux.finalizeClose(entry.token)
    }
    // Parts whose window creation/teardown failed have no entry but can still
    // own editors (and are serialized as orphans). Retry them on every restore;
    // a still-failing part is kept, never force-destroyed.
    for (const part of this._auxPartsWithoutWindow()) {
      if (!this._salvagePart(part, target)) continue
      this._groups.removePart(part, { force: true })
    }
    this._workbenchWindows.setActiveWindow(this._workbenchWindows.mainWindow)
    this._groups.activatePart(this._groups.mainPart, { preserveFocus: true })
    this._windowFocus.focusMainWindow()
  }

  serialize(): ISerializedAuxiliaryWindowsState {
    const windows: ISerializedAuxiliaryEditorWindow[] = this._entries.map((entry) => ({
      ...(entry.geometry ? { geometry: entry.geometry } : {}),
      state: entry.part.toJSON(),
      ...(entry.explicitEmpty ? { explicitEmpty: true } : {}),
    }))
    // A part kept after a failed migration has no window entry; persist it too
    // or a reload loses the editors it was kept for.
    for (const part of this._auxPartsWithoutWindow()) {
      if (!part.isEmpty) windows.push({ state: part.toJSON() })
    }
    if (windows.length === 0) return EMPTY_STATE
    const activeIndex = this._entries.findIndex((entry) => entry.window === this._activeWindow())
    return {
      windows,
      ...(activeIndex >= 0 ? { activeIndex } : {}),
    }
  }

  async restore(
    state: ISerializedAuxiliaryWindowsState | undefined,
    accessor: ServicesAccessor,
  ): Promise<readonly EditorInput[]> {
    if (!state || state.windows.length === 0) return []
    const restoredEditors: EditorInput[] = []
    const collectEditors = (part: EditorPart): void => {
      for (const group of part.groups) restoredEditors.push(...group.editors)
    }
    this._restoring = true
    let activeEntry: WindowEntry | undefined
    try {
      for (let i = 0; i < state.windows.length; i++) {
        const saved = state.windows[i]!
        // Hydrate into a detached part first: if the native window cannot be
        // created, its editors can still be moved into the main window instead
        // of being lost with the failed window.
        const part = this._groups.createAuxiliaryPart({ activate: false }) as EditorPart
        try {
          part.restore(saved.state, accessor)
          collectEditors(part)
        } catch (err) {
          // Collect before salvaging: the instances move out of `part`.
          collectEditors(part)
          this._logger.warn(`restore: part state failed for window ${i}: ${String(err)}`)
          this._salvageFailedPart(part)
          continue
        }
        const entry = await this._createWindow({
          activate: false,
          explicitEmpty: saved.explicitEmpty === true,
          ...(saved.geometry ? { geometry: saved.geometry } : {}),
          part,
        })
        if (!entry) {
          this._logger.warn(`restore: window ${i} failed; salvaging editors to main`)
          this._salvageFailedPart(part)
          continue
        }
        if (i === state.activeIndex) activeEntry = entry
      }
      if (activeEntry) this._activateEntry(activeEntry)
      else if (state.windows.length > 0) {
        const first = this._entries[0]
        if (first) this._activateEntry(first)
      }
    } finally {
      this._restoring = false
    }
    return restoredEditors
  }

  // Internals -----------------------------------------------------------------

  private _toPublic(entry: WindowEntry): IAuxiliaryEditorWindow {
    return {
      token: entry.token,
      part: entry.part,
      window: entry.window,
      explicitEmpty: entry.explicitEmpty,
    }
  }

  private getEntry(token: string): WindowEntry | undefined {
    return this._entries.find((entry) => entry.token === token)
  }

  private _isPartLive(part: EditorPart): boolean {
    return this._groups.parts.includes(part)
  }

  /**
   * Auxiliary parts that currently have no window entry: restored/failed parts
   * kept for their editors (and parts whose window is still being created).
   */
  private _auxPartsWithoutWindow(): EditorPart[] {
    const owned = new Set<IEditorPart>(this._entries.map((entry) => entry.part))
    return this._groups.parts.filter(
      (part): part is EditorPart => part !== this._groups.mainPart && !owned.has(part),
    )
  }

  /**
   * Salvage a part whose window is gone. A part that still holds editors after
   * both attempts is kept (and therefore serialized); it is never force
   * destroyed, since that would drop its documents.
   */
  private _salvageFailedPart(part: EditorPart): void {
    // The workspace scope may have cleared the part while its window was being
    // prepared; its editors are outgoing and must not be pulled into the new
    // scope.
    if (!this._isPartLive(part)) return
    if (!this._salvagePart(part)) {
      this._logger.error(`part ${part.id} still holds editors; keeping it reachable`)
      return
    }
    this._groups.removePart(part, { force: true })
  }

  private _discardOrphanParts(): void {
    for (const part of this._auxPartsWithoutWindow()) {
      this._groups.removePart(part, { force: true })
    }
  }

  private _activeWindow(): IWorkbenchWindow | undefined {
    return this._workbenchWindows.activeWindow
  }

  private _activateEntry(entry: WindowEntry): void {
    this._workbenchWindows.setActiveWindow(entry.window)
    this._groups.activatePart(entry.part, { preserveFocus: true })
  }

  private _cloneForCopy(editor: EditorInput): EditorInput | undefined {
    return this._instantiation.invokeFunction((accessor) =>
      cloneEditorInputForSplit(editor, accessor),
    )
  }

  private _notifyUncopyable(labels: readonly string[]): void {
    this._notifications.notify({
      severity: Severity.Warning,
      message: localize(
        'auxiliaryWindow.copyUnsupported',
        'This editor cannot be copied to a new window: {label}',
        { label: labels.join(', ') },
      ),
    })
  }

  /**
   * A double move failure leaves the editor in a part that no window owns.
   * Tell the user where it is and how to retry; the part itself stays
   * serialized so a reload does not drop it.
   */
  private _notifyRestoreFailure(editor: EditorInput): void {
    this._notifications.notify({
      severity: Severity.Error,
      message: localize(
        'auxiliaryWindow.restoreFailed',
        'Could not move "{label}" back to the main window. The editor is kept in a reachable auxiliary window; use "Restore Editors to Main Window" to retry.',
        { label: editor.label },
      ),
      actions: [
        {
          label: localize('auxiliaryWindow.restoreFailed.action', 'Restore Editors to Main Window'),
          run: () => this.restoreAllToMainWindow(),
        },
      ],
    })
  }

  /** Main-window target for migrated editors: most-recent unlocked group. */
  private _mainTargetGroup(): IEditorGroup {
    const main = this._groups.mainPart
    for (const group of main.getGroups(GroupsOrder.MostRecentlyActive)) {
      if (!group.isLocked) return group
    }
    // Every group is locked: create a fresh unlocked one next to the active group.
    return main.activeGroupForOpen
  }

  /**
   * Move every editor out of a part that is about to lose its window. Returns
   * whether the part is now empty. A failed move is retried once in a fresh
   * main group: that empty target cannot hit a same-id `migrateFrom` hook and
   * also cannot collide with an editor already in the preferred group. Callers
   * must only dispose the part when this returns true.
   */
  private _salvagePart(part: EditorPart, target = this._mainTargetGroup()): boolean {
    if (part.isEmpty) return true
    let fallback: IEditorGroup | undefined
    for (const group of [...part.groups]) {
      for (const editor of [...group.editors]) {
        try {
          this._moveEditorOrThrow(editor, target, group)
          continue
        } catch (err) {
          this._logger.warn(
            `failed to salvage restored editor, retrying in a new group: ${String(err)}`,
          )
        }
        fallback ??= this._groups.addGroup(this._groups.mainPart.activeGroup, GroupDirection.Right)
        try {
          this._moveEditorOrThrow(editor, fallback, group)
        } catch (err) {
          this._logger.error(
            `failed to salvage editor ${editor.id}; keeping part ${part.id} to preserve it: ${String(err)}`,
          )
          this._notifyRestoreFailure(editor)
        }
      }
    }
    return part.isEmpty
  }

  /** True when `editor` is still the same live instance inside a live group. */
  private _isMoveSourceValid(editor: EditorInput, source: IEditorGroup): boolean {
    if (editor.isDisposed) return false
    if (!this._isGroupLive(source)) return false
    return source.findEditor(editor) === editor
  }

  private _isGroupLive(group: IEditorGroup): boolean {
    return this._groups.getGroup(group.id) === group
  }

  private _findGroupContaining(editor: EditorInput): IEditorGroup | undefined {
    for (const group of this._groups.groups) {
      if (group.contains(editor)) return group
    }
    return undefined
  }

  private _isEntryOpen(entry: WindowEntry): boolean {
    return this._entries.includes(entry) && !entry.closing
  }

  private _snapshotGroup(group: IEditorGroup): {
    editors: EditorInput[]
    sticky: Set<EditorInput>
    active: EditorInput | undefined
    locked: boolean
  } {
    const editors = [...group.editors]
    return {
      editors,
      sticky: new Set(editors.filter((editor) => group.isSticky(editor))),
      active: group.activeEditor,
      locked: group.isLocked,
    }
  }

  private _restoreSticky(target: IEditorGroup, editor: EditorInput, sticky: boolean): void {
    if (sticky && !target.isSticky(editor)) target.stickEditor(editor)
    else if (!sticky && target.isSticky(editor)) target.unstickEditor(editor)
  }

  /**
   * `moveEditor` is a silent no-op when the source/target cannot be resolved.
   * Treat that as a failure: windows are closed based on it, and a swallowed
   * no-op used to close protected/clean editors with their documents still in
   * the source.
   */
  private _moveEditorOrThrow(
    editor: EditorInput,
    target: IEditorGroup,
    source: IEditorGroup,
  ): void {
    this._groups.moveEditor(editor, target, source)
    if (source.contains(editor) || !target.contains(editor)) {
      throw new Error(
        `move did not land: editor=${editor.id} source=${source.id} target=${target.id}`,
      )
    }
  }

  /** Close a window created for a failed move/copy, but never one that has editors. */
  private async _discardFailedTarget(entry: WindowEntry): Promise<void> {
    if (!this._isEntryOpen(entry)) return
    if (!entry.part.isEmpty) {
      entry.explicitEmpty = false
      return
    }
    await this.closeWindow(this._toPublic(entry))
  }

  private async _createWindow(
    options: CreateAuxiliaryEditorWindowOptions,
  ): Promise<WindowEntry | undefined> {
    let token: string | undefined
    let child: Window | undefined
    let entry: WindowEntry | undefined
    let failed = true
    // Dynamic per-window lifetime, but rooted at the (singleton) service so an
    // open (or in-flight) auxiliary window never shows up as a teardown leak.
    const disposables = new DisposableStore()
    setParentOfDisposable(disposables, this)
    const ownedPart = options.part === undefined
    const part =
      options.part ?? (this._groups.createAuxiliaryPart({ activate: false }) as EditorPart)
    try {
      const initialGeometry = options.geometry ?? options.bounds
      const themeBackground = readTitleBarBackground(this._workbenchWindows.mainWindow.document)
      const prepared = await this._aux.prepareOpen({
        ...(initialGeometry ? { geometry: initialGeometry } : {}),
        ...(options.title ? { title: options.title } : {}),
        ...(themeBackground ? { backgroundColor: themeBackground } : {}),
        ...(options.preferOtherDisplayFullscreen === true
          ? { preferOtherDisplayFullscreen: true }
          : {}),
      })
      token = prepared.token
      // A workspace scope swap can clear every auxiliary part while the native
      // window is being prepared. Never create/register a window for a part
      // that no longer belongs to the grid.
      if (!this._isPartLive(part)) {
        this._logger.warn('auxiliary part removed while the window was being prepared')
        return undefined
      }
      const opened = window.open('about:blank', prepared.frameName)
      if (!opened) {
        this._logger.warn('window.open was blocked by the renderer')
        return undefined
      }
      child = opened
      // The minimal preload marks itself; a missing marker means the popup did
      // not get the auxiliary preload and must not be used as a workbench window.
      const marked = await waitForAuxiliaryMarker(child)
      if (!marked) {
        this._logger.warn('auxiliary window preload marker missing; closing popup')
        return undefined
      }
      if (!this._isPartLive(part)) {
        this._logger.warn('auxiliary part removed during window creation')
        return undefined
      }

      const document = child.document
      // 不复制主工作区标题，否则 Alt+Tab/任务栏出现多个同名窗口；workbench
      // 挂载后由标题栏同步活动编辑器名。
      document.title = options.title ?? localize('auxiliaryWindow.windowTitle', 'Editor Window')
      disposables.add(mirrorDocumentChrome(this._workbenchWindows.mainWindow.document, document))
      ensureAuxiliaryRoot(document)
      disposables.add(await registerMonacoWindow(child))
      // The window can be destroyed while `registerMonacoWindow` is resolving;
      // never publish an entry for an already-dead popup or a cleared part.
      if (child.closed) {
        this._logger.warn('auxiliary window closed during creation')
        return undefined
      }
      if (!this._isPartLive(part)) {
        this._logger.warn('auxiliary part removed during window creation')
        return undefined
      }

      const workbenchWindow = this._workbenchWindows.registerAuxiliaryWindow(part, child, token)
      entry = {
        token,
        part,
        window: workbenchWindow,
        document,
        disposables,
        explicitEmpty: options.explicitEmpty === true,
        closing: false,
        geometry: options.geometry,
      }
      this._entries.push(entry)
      this._onDidChangeWindows.fire()
      this._watchEmpty(entry)
      // about:blank fires ready-to-show almost immediately; focus explicitly so
      // activation is deterministic (E2E windows use showInactive). Restore
      // creates windows with `activate: false` and activates the saved window
      // once at the end — flipping the active document per window mid-restore
      // would leave overlays/dialogs momentarily pointing at the wrong one.
      if (options.activate !== false) this._windowFocus.focusWindow(workbenchWindow)
      // An external close (or a scope swap) may have torn the entry/part down
      // before callers observe the result; returning it would leave callers
      // acting on a dead window.
      if (this.getEntry(token) !== entry || !this._isPartLive(part)) {
        this._logger.warn('auxiliary window disappeared during creation')
        return undefined
      }
      if (options.activate !== false) this._activateEntry(entry)
      failed = false
      this._logger.info(
        `created token=${token} part=${part.id} activate=${options.activate !== false}`,
      )
      return entry
    } catch (err) {
      this._logger.warn(`create auxiliary window failed: ${String(err)}`)
      return undefined
    } finally {
      if (failed) {
        await this._cleanupFailedWindow({ token, child, part, ownedPart, entry, disposables })
      }
    }
  }

  /**
   * Single failure path for every exit of `_createWindow`. A part created here
   * is ours to discard; a caller-provided part (workspace restore) must survive
   * so its editors can be salvaged after the window failed. When the entry was
   * already published, remove it without force-destroying that caller part.
   */
  private async _cleanupFailedWindow(params: {
    token: string | undefined
    child: Window | undefined
    part: EditorPart
    ownedPart: boolean
    entry: WindowEntry | undefined
    disposables: DisposableStore
  }): Promise<void> {
    const { token, child, part, ownedPart, entry, disposables } = params
    if (entry && this._entries.includes(entry)) {
      const index = this._entries.indexOf(entry)
      this._entries.splice(index, 1)
      entry.closing = true
      entry.disposables.dispose()
      this._workbenchWindows.unregisterWindow(entry.window)
      this._onDidChangeWindows.fire()
    } else {
      disposables.dispose()
    }
    if (ownedPart) {
      this._salvageFailedPart(part)
    }
    if (child && !child.closed) child.close()
    if (token) {
      await this._aux.cancelPrepared(token).catch(() => undefined)
      await this._aux.finalizeClose(token).catch(() => undefined)
    }
  }

  private _watchEmpty(entry: WindowEntry): void {
    const check = (): void => {
      queueMicrotask(() => {
        if (entry.closing || !this._entries.includes(entry)) return
        if (!entry.part.isEmpty) {
          entry.explicitEmpty = false
          return
        }
        if (entry.explicitEmpty || this._restoring) return
        // An editor window with no editors closes itself (VSCode parity). A veto
        // or migration failure keeps it open.
        void this.requestClose(entry)
      })
    }
    const attach = (group: IEditorGroup): void => {
      entry.disposables.add(group.onDidChangeModel(check))
      entry.disposables.add(group.onDidActiveEditorChange(check))
      check()
    }
    for (const group of entry.part.groups) attach(group)
    entry.disposables.add(entry.part.onDidAddGroup(attach))
    entry.disposables.add(entry.part.onDidRemoveGroup(check))
  }

  /**
   * The window was destroyed outside our close transaction (parent close, crash,
   * or a finalize we initiated). Never drop its editors silently while the
   * renderer is alive: move whatever remains back to the main window.
   */
  private async _handleExternalClose(token: string): Promise<void> {
    const entry = this.getEntry(token)
    if (!entry) return
    // A closed transaction already moved protected editors and closed the rest;
    // otherwise salvage whatever remains. Only a fully emptied part may be
    // disposed — losing a document here is worse than retaining a part.
    const complete = entry.closing || this._salvagePart(entry.part)
    if (!complete) {
      this._logger.error(
        `external close: part ${entry.part.id} still holds editors; keeping them reachable`,
      )
    }
    this._teardownEntry(entry, { removePart: complete })
  }

  private _teardownEntry(entry: WindowEntry, options: { removePart?: boolean } = {}): void {
    const index = this._entries.indexOf(entry)
    if (index === -1) return
    this._entries.splice(index, 1)
    this._onDidChangeWindows.fire()
    entry.closing = true
    entry.disposables.dispose()
    this._workbenchWindows.unregisterWindow(entry.window)
    if (options.removePart !== false) {
      this._groups.removePart(entry.part, { force: true })
    }
    this._logger.info(`torn down part=${entry.part.id}`)
  }

  /** Persistable state of every auxiliary part, for debugging/E2E symmetry. */
  toJSON(): ISerializedAuxiliaryWindowsState {
    return this.serialize()
  }

  override dispose(): void {
    for (const entry of [...this._entries]) {
      this._teardownEntry(entry)
    }
    this._discardOrphanParts()
    super.dispose()
  }
}
