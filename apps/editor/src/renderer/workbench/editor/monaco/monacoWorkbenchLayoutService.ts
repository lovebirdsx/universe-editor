/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoWorkbenchLayoutService — align monaco standalone's ILayoutService
 *  with vscode: hovers / context views mount on the workbench root, not the
 *  editor container, so they are never clipped by the editor's overflow.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '@universe-editor/platform'
import {
  currentWorkbenchDocumentOrUndefined,
  getWorkbenchDocuments,
} from '../../../services/windows/workbenchDocuments.js'

// ---------------------------------------------------------------------------
// Why this exists (monaco-editor 0.55.1)
//
// Standalone monaco registers `StandaloneLayoutService` for ILayoutService:
// `getContainer()` returns the ACTIVE EDITOR's container DOM node. Monaco's
// hover service (find-widget button tooltips, parameter hints, etc.) mounts
// its context view into that container — and the editor container has
// `overflow: hidden`, so any tooltip that spills above the widget (find
// widget at the editor's top edge) is hard-clipped.
//
// In vscode the same call returns the workbench container (the element
// covering the whole window), so hovers and context views position against
// viewport coordinates and are never clipped by an editor. This override
// reproduces that: the container is our app root (#root, which is exactly
// the window's client area), and every consumer of monaco's ILayoutService —
// hover service, context-view service (editor context menus), action widget,
// quick input — now renders unclipped, same as vscode.
//
// Multi-window: auxiliary editor windows are separate Documents in the same
// renderer. `activeContainer` must follow the focused workbench document —
// monaco's QuickInputController.shows re-parents its widget to
// `layoutService.activeContainer` whenever the widget's window differs from
// the container's window, so a fixed main-window container sent Go to Line
// (and every other platform quick input) to the main window. `mainContainer`
// stays on the main document on purpose: it anchors monaco's global
// accessibility/clipboard listeners and is the fallback reparent target when
// a window unregisters.
// ---------------------------------------------------------------------------

/** Decorator id string of monaco's ILayoutService (`createDecorator('layoutService')`). */
export const MONACO_LAYOUT_SERVICE_ID = 'layoutService'

interface IMonacoWindowLike {
  document: Document
}

function rootOfDocument(doc: Document | undefined): HTMLElement | undefined {
  if (doc === undefined) return undefined
  return doc.getElementById('root') ?? doc.body
}

class WorkbenchLayoutService {
  private get _mainDocument(): Document | undefined {
    return typeof document === 'undefined' ? undefined : document
  }

  private get _mainRoot(): HTMLElement {
    const root = rootOfDocument(this._mainDocument)
    if (root === undefined) {
      throw new Error('[monacoWorkbenchLayoutService] mainContainer requires a DOM')
    }
    return root
  }

  get mainContainer(): HTMLElement {
    return this._mainRoot
  }

  get activeContainer(): HTMLElement {
    // Follows the focused workbench window; before any auxiliary window is
    // registered this resolves to the main document, same as the old behavior.
    return rootOfDocument(currentWorkbenchDocumentOrUndefined()) ?? this._mainRoot
  }

  get containers(): readonly HTMLElement[] {
    const roots = getWorkbenchDocuments()
      .map((doc) => rootOfDocument(doc))
      .filter((root): root is HTMLElement => root !== undefined)
    return roots.length > 0 ? roots : [this._mainRoot]
  }

  get mainContainerDimension(): { width: number; height: number } {
    const rect = this._mainRoot.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }

  get activeContainerDimension(): { width: number; height: number } {
    const rect = this.activeContainer.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }

  get mainContainerOffset(): { top: number; quickPickTop: number } {
    return { top: 0, quickPickTop: 0 }
  }

  get activeContainerOffset(): { top: number; quickPickTop: number } {
    return { top: 0, quickPickTop: 0 }
  }

  getContainer(monacoWindow: IMonacoWindowLike): HTMLElement {
    // Monaco resolves the container from the target element's window (its hover
    // service does this explicitly "to enable aux window support"). An
    // auxiliary window's overlays must mount into that window's root, not the
    // main window's — the two are different documents.
    return rootOfDocument(monacoWindow.document) ?? monacoWindow.document.body
  }

  whenContainerStylesLoaded(): undefined {
    return undefined
  }

  // Container-lifecycle events stay inert. Monaco 0.55.1's standalone layout
  // service declares all five as Event.None too: the context-view service
  // subscribes to onDidLayoutContainer, which is a no-op on a never-firing
  // event; the clipboard listener is Safari-gated and seeded from
  // mainContainer; the quick-input relays subscribe to their editor-scoped
  // host, not this root. The active container is read lazily on every
  // quick-input show, so a getter is enough.
  readonly onDidLayoutMainContainer = Event.None
  readonly onDidLayoutActiveContainer = Event.None
  readonly onDidLayoutContainer = Event.None
  readonly onDidChangeActiveContainer = Event.None
  readonly onDidAddContainer = Event.None

  focus(): void {
    // Reasonable approximation of StandaloneLayoutService.focus(): give
    // keyboard focus back to whatever element monaco thinks is active.
    // The active editor may live in an auxiliary window, so read that window's
    // document rather than the main realm's global one.
    const active = currentWorkbenchDocumentOrUndefined()?.activeElement
    ;(active as HTMLElement | null)?.focus?.()
  }
}

/** Singleton instance registered as monaco's ILayoutService override. */
export const monacoWorkbenchLayoutService = new WorkbenchLayoutService()
