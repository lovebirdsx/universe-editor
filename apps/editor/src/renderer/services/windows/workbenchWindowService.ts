/*---------------------------------------------------------------------------------------------
 *  WorkbenchWindowService — the renderer's registry of workbench windows.
 *
 *  Every workbench window (the main workspace window plus any auxiliary editor
 *  windows) owns exactly one `IEditorPart`. The React tree is still a single
 *  runtime: auxiliary parts are rendered through React portals from the main
 *  tree, so DI services, contexts and Monaco models stay shared.
 *
 *  This service is the single source of truth for:
 *  - which editor part belongs to which DOM document / Window;
 *  - which window is focused (keybindings, dialogs and quick input open there);
 *  - mapping a DOM node or document back to its window (anchor-based overlays).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  createDecorator,
  type Event,
  type IEditorPart,
  type IDisposable,
} from '@universe-editor/platform'
import { registerWorkbenchDocument, setActiveWorkbenchDocument } from './workbenchDocuments.js'

export interface IWorkbenchWindow {
  /** Stable renderer-local id (part id for aux windows; 0 for the main window). */
  readonly id: number
  readonly isMain: boolean
  readonly part: IEditorPart
  readonly document: Document
  readonly window: Window
  /** Auxiliary-window capability token; undefined for the main window. */
  readonly token: string | undefined
}

export interface IWorkbenchWindowService {
  readonly _serviceBrand: undefined

  readonly mainWindow: IWorkbenchWindow
  readonly windows: readonly IWorkbenchWindow[]
  readonly activeWindow: IWorkbenchWindow

  readonly onDidAddWindow: Event<IWorkbenchWindow>
  readonly onDidRemoveWindow: Event<IWorkbenchWindow>
  readonly onDidChangeActiveWindow: Event<IWorkbenchWindow>

  registerMainWindow(part: IEditorPart, doc: Document): IWorkbenchWindow
  registerAuxiliaryWindow(part: IEditorPart, win: Window, token: string): IWorkbenchWindow
  unregisterWindow(win: IWorkbenchWindow): void

  setActiveWindow(win: IWorkbenchWindow): void
  activatePart(part: IEditorPart | number): IWorkbenchWindow | undefined

  getWindowForPart(part: IEditorPart | number): IWorkbenchWindow | undefined
  getWindowForDocument(doc: Document | null | undefined): IWorkbenchWindow | undefined
  getWindowForElement(node: Node | null | undefined): IWorkbenchWindow | undefined
  getWindowForToken(token: string): IWorkbenchWindow | undefined
}

export const IWorkbenchWindowService =
  createDecorator<IWorkbenchWindowService>('workbenchWindowService')

interface WindowEntry extends IWorkbenchWindow {
  readonly focusDisposables: IDisposable[]
}

export class WorkbenchWindowService extends Disposable implements IWorkbenchWindowService {
  declare readonly _serviceBrand: undefined

  private _mainWindow: WindowEntry | undefined
  private readonly _entries: WindowEntry[] = []
  private _active: WindowEntry | undefined

  private readonly _onDidAddWindow = this._register(new Emitter<IWorkbenchWindow>())
  readonly onDidAddWindow: Event<IWorkbenchWindow> = this._onDidAddWindow.event
  private readonly _onDidRemoveWindow = this._register(new Emitter<IWorkbenchWindow>())
  readonly onDidRemoveWindow: Event<IWorkbenchWindow> = this._onDidRemoveWindow.event
  private readonly _onDidChangeActiveWindow = this._register(new Emitter<IWorkbenchWindow>())
  readonly onDidChangeActiveWindow: Event<IWorkbenchWindow> = this._onDidChangeActiveWindow.event

  get mainWindow(): IWorkbenchWindow {
    if (!this._mainWindow) throw new Error('main workbench window is not registered yet')
    return this._mainWindow
  }

  get windows(): readonly IWorkbenchWindow[] {
    return this._allEntries()
  }

  get activeWindow(): IWorkbenchWindow {
    return this._active ?? this.mainWindow
  }

  registerMainWindow(part: IEditorPart, doc: Document): IWorkbenchWindow {
    if (this._mainWindow) return this._mainWindow
    const entry = this._createEntry(0, true, part, doc.defaultView ?? window, undefined, doc)
    this._mainWindow = entry
    this._active = entry
    return entry
  }

  registerAuxiliaryWindow(part: IEditorPart, win: Window, token: string): IWorkbenchWindow {
    const existing = this.getWindowForToken(token)
    if (existing) return existing
    const entry = this._createEntry(part.id, false, part, win, token, win.document)
    this._entries.push(entry)
    this._onDidAddWindow.fire(entry)
    return entry
  }

  unregisterWindow(win: IWorkbenchWindow): void {
    const index = this._entries.findIndex((entry) => entry.id === win.id)
    if (index === -1) return
    const [entry] = this._entries.splice(index, 1)
    if (!entry) return
    this._disposeEntryListeners(entry)
    if (this._active === entry) {
      // Go through `_setActive` so the module-level active document switches
      // back to the main window too; a bare field assignment left overlay and
      // dialog anchoring pointed at the destroyed document.
      if (this._mainWindow) this._setActive(this._mainWindow)
      else this._active = undefined
    }
    this._onDidRemoveWindow.fire(entry)
  }

  setActiveWindow(win: IWorkbenchWindow): void {
    const entry = this._allEntries().find((candidate) => candidate.id === win.id)
    if (!entry) return
    this._setActive(entry)
  }

  activatePart(part: IEditorPart | number): IWorkbenchWindow | undefined {
    const id = typeof part === 'number' ? part : part.id
    const entry = this._allEntries().find((candidate) => candidate.part.id === id)
    if (!entry) return undefined
    this._setActive(entry)
    return entry
  }

  getWindowForPart(part: IEditorPart | number): IWorkbenchWindow | undefined {
    const id = typeof part === 'number' ? part : part.id
    return this._allEntries().find((entry) => entry.part.id === id)
  }

  getWindowForDocument(doc: Document | null | undefined): IWorkbenchWindow | undefined {
    if (!doc) return undefined
    return this._allEntries().find((entry) => entry.document === doc)
  }

  getWindowForElement(node: Node | null | undefined): IWorkbenchWindow | undefined {
    return this.getWindowForDocument(node?.ownerDocument)
  }

  getWindowForToken(token: string): IWorkbenchWindow | undefined {
    return this._entries.find((entry) => entry.token === token)
  }

  private _allEntries(): WindowEntry[] {
    return this._mainWindow ? [this._mainWindow, ...this._entries] : [...this._entries]
  }

  private _createEntry(
    id: number,
    isMain: boolean,
    part: IEditorPart,
    win: Window,
    token: string | undefined,
    doc: Document,
  ): WindowEntry {
    const focusDisposables: IDisposable[] = []
    const focus = (): void => {
      const entry = this._allEntries().find((candidate) => candidate.document === doc)
      if (entry) this._setActive(entry)
    }
    // Capture phase: a click anywhere in a window proves it is the active one
    // even when the OS (or offscreen X) never grants real focus.
    doc.addEventListener('pointerdown', focus, true)
    doc.addEventListener('focusin', focus, true)
    win.addEventListener('focus', focus)
    focusDisposables.push({
      dispose: () => {
        doc.removeEventListener('pointerdown', focus, true)
        doc.removeEventListener('focusin', focus, true)
        win.removeEventListener('focus', focus)
      },
    })
    const registration = registerWorkbenchDocument(doc)
    focusDisposables.push(registration)
    return { id, isMain, part, document: doc, window: win, token, focusDisposables }
  }

  private _setActive(entry: WindowEntry): void {
    setActiveWorkbenchDocument(entry.document)
    if (this._active === entry) return
    this._active = entry
    this._onDidChangeActiveWindow.fire(entry)
  }

  private _disposeEntryListeners(entry: WindowEntry): void {
    for (const d of entry.focusDisposables) d.dispose()
    entry.focusDisposables.length = 0
  }

  override dispose(): void {
    // The main window's listeners are rooted here too. Disposing only `_entries`
    // leaked the main document/pointer/focus listeners (and its document
    // registration) past renderer teardown.
    if (this._mainWindow) this._disposeEntryListeners(this._mainWindow)
    for (const entry of this._entries) this._disposeEntryListeners(entry)
    this._mainWindow = undefined
    this._active = undefined
    this._entries.length = 0
    super.dispose()
  }
}
