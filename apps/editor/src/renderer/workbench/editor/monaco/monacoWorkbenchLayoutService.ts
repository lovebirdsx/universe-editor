/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoWorkbenchLayoutService — align monaco standalone's ILayoutService
 *  with vscode: hovers / context views mount on the workbench root, not the
 *  editor container, so they are never clipped by the editor's overflow.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '@universe-editor/platform'
import { currentWorkbenchDocumentOrUndefined } from '../../../services/windows/workbenchDocuments.js'

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
// ---------------------------------------------------------------------------

/** Decorator id string of monaco's ILayoutService (`createDecorator('layoutService')`). */
export const MONACO_LAYOUT_SERVICE_ID = 'layoutService'

interface IMonacoWindowLike {
  document: Document
}

class WorkbenchLayoutService {
  private get _root(): HTMLElement {
    return document.getElementById('root') ?? document.body
  }

  get mainContainer(): HTMLElement {
    return this._root
  }

  get activeContainer(): HTMLElement {
    return this._root
  }

  get containers(): readonly HTMLElement[] {
    return [this._root]
  }

  get mainContainerDimension(): { width: number; height: number } {
    const rect = this._root.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }

  get activeContainerDimension(): { width: number; height: number } {
    return this.mainContainerDimension
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
    const doc = monacoWindow.document
    return doc.getElementById('root') ?? doc.body
  }

  whenContainerStylesLoaded(): undefined {
    return undefined
  }

  // Single-window app: every container-lifecycle event never fires, matching
  // StandaloneLayoutService's `Event.None` shape.
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
