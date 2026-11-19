/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim surface registry — the workbench tells this registry which concrete
 *  widgets can receive Vim keys, and the dispatcher asks it which one owns the
 *  current stroke. Arbitration reuses the Ctrl-alias rules: menu beats overlay
 *  beats list beats terminal beats editor beats the chrome surfaces; within one
 *  kind the innermost element, then the most recently mounted, wins.
 *
 *  One sequence engine is stored per surface so a count / pending prefix cannot
 *  leak from one list into the next.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useRef } from 'react'
import { OwnerDocumentContext } from '../../overlay/ownerDocumentContext.js'
import { pickNavigationLayer, type INavigationLayerView } from './navigationLayers.js'
import { VimSequenceEngine } from './vimSequence.js'
import type { IVimSurfaceRegistration, VimSurfaceKind } from './vimTypes.js'

const KIND_PRIORITY: Record<VimSurfaceKind, number> = {
  menu: 8,
  overlay: 7,
  list: 6,
  terminal: 5,
  editor: 4,
  tabs: 3,
  activityBar: 3,
  viewContainerTabs: 3,
  // The dispatcher rejects webview focus before surface arbitration; the kind
  // exists only so adapters can mark the DOM.
  webview: -1,
}

function priority(kind: string): number {
  return KIND_PRIORITY[kind as VimSurfaceKind] ?? -1
}

function isAlwaysActive(kind: string): boolean {
  return kind === 'menu'
}

function defaultFocus(kind: VimSurfaceKind): 'self' | 'within' {
  return kind === 'list' ||
    kind === 'tabs' ||
    kind === 'activityBar' ||
    kind === 'viewContainerTabs'
    ? 'self'
    : 'within'
}

interface SurfaceEntry extends INavigationLayerView {
  readonly read: () => IVimSurfaceRegistration
  readonly engine: VimSequenceEngine
}

interface DocumentState {
  readonly surfaces: Map<symbol, SurfaceEntry>
  readonly listeners: Set<() => void>
}

const documents = new Map<Document, DocumentState>()
let nextSequence = 1

/** Re-evaluate the active surface when a widget mounts/unmounts, not just on focus. */
export function onDidChangeVimSurfaces(doc: Document, listener: () => void): { dispose(): void } {
  const state = ensureDocument(doc)
  if (state === undefined) return { dispose: () => undefined }
  state.listeners.add(listener)
  return {
    dispose: () => {
      state.listeners.delete(listener)
    },
  }
}

function ensureDocument(doc: Document): DocumentState | undefined {
  const existing = documents.get(doc)
  if (existing !== undefined) return existing
  if (doc.defaultView === null) return undefined
  const state: DocumentState = { surfaces: new Map(), listeners: new Set() }
  documents.set(doc, state)
  return state
}

function notify(state: DocumentState): void {
  for (const listener of state.listeners) listener()
}

function addSurface(doc: Document, read: () => IVimSurfaceRegistration): { dispose(): void } {
  const state = ensureDocument(doc)
  if (state === undefined) return { dispose: () => undefined }
  const registration = read()
  const id = Symbol('vimSurface')
  state.surfaces.set(id, {
    kind: registration.kind,
    sequence: nextSequence++,
    focus: registration.focus ?? defaultFocus(registration.kind),
    // Monaco and xterm keep focus on a TEXTAREA inside their container; without
    // this the editable-target guard would reject them.
    allowEditableFocus: registration.kind === 'editor' || registration.kind === 'terminal',
    getElement: () => read().getElement?.() ?? null,
    get enabled() {
      return read().enabled
    },
    read,
    engine: new VimSequenceEngine(),
  })
  notify(state)
  return {
    dispose: () => {
      if (!state.surfaces.delete(id)) return
      notify(state)
      if (state.surfaces.size === 0 && state.listeners.size === 0) documents.delete(doc)
    },
  }
}

/** Register a surface directly (non-React callers such as the Ctrl-alias bridge). */
export function registerVimSurface(
  registration: IVimSurfaceRegistration,
  doc?: Document,
): { dispose(): void } {
  const target =
    doc ??
    registration.getElement?.()?.ownerDocument ??
    (typeof document === 'undefined' ? undefined : document)
  if (target === undefined) return { dispose: () => undefined }
  return addSurface(target, () => registration)
}

export interface IActiveVimSurface {
  readonly surface: IVimSurfaceRegistration
  readonly sequence: VimSequenceEngine
  readonly surfaceKey: string
}

/**
 * The surface that owns the keyboard in `doc`, or undefined when focus is not
 * inside any registered surface. `surfaceKey` is resolved now so mode memory
 * and trace lines agree with the surface that actually handled the stroke.
 */
export function getActiveVimSurface(doc: Document): IActiveVimSurface | undefined {
  const state = documents.get(doc)
  if (state === undefined) return undefined
  // Menu surfaces paint with virtual focus and stay active while mounted.
  const entry = pickNavigationLayer(state.surfaces.values(), doc, isAlwaysActive, priority)
  if (entry === undefined) return undefined
  const surface = entry.read()
  return { surface, sequence: entry.engine, surfaceKey: surface.getSurfaceKey() }
}

/**
 * React binding. The registration is read through a ref so per-render handler
 * identities do not tear down and re-register the surface on every keystroke.
 * `targetDocument` wins over the owner-document context for portals whose host
 * already knows where it renders (Select, menus, popups).
 */
export function useVimSurface(
  registration: IVimSurfaceRegistration,
  targetDocument?: Document,
): void {
  const contextDoc = useContext(OwnerDocumentContext)
  const registrationRef = useRef(registration)
  registrationRef.current = registration
  // Resolve inside the effect: callback refs are attached by then, and portals
  // carry their owner document through context.
  const elementDoc = registration.getElement?.()?.ownerDocument
  useEffect(() => {
    const doc =
      targetDocument ??
      contextDoc ??
      elementDoc ??
      (typeof document === 'undefined' ? undefined : document)
    if (doc === undefined) return undefined
    return addSurface(doc, () => registrationRef.current).dispose
  }, [contextDoc, elementDoc, targetDocument])
}

/** Test-only: drop every registered surface and listener. */
export function __resetVimSurfacesForTests(): void {
  documents.clear()
  nextSequence = 1
}

/** Test-only: number of live surfaces for a document. */
export function __getVimSurfaceCountForTests(doc: Document): number {
  return documents.get(doc)?.surfaces.size ?? 0
}
