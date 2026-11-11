/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ctrlNavigationRegistry — one window-capture listener per document that routes the
 *  Ctrl movement aliases (Ctrl+P/N/J/K/H/L) to the innermost active list surface.
 *
 *  A listener per component does not work here. Menus paint with virtual focus
 *  (`aria-activedescendant`), so DOM focus stays on the tree or list underneath;
 *  two window-capture listeners would both see the same stroke, and
 *  `stopPropagation()` does not stop the other listeners on the same target. The
 *  registry picks exactly one layer: menu > dialog > overlay > list, with nested
 *  elements of the same kind resolved innermost-first.
 *
 *  Window capture is required. The workbench keybinding dispatcher listens on
 *  document capture and resolves chord prefixes before single strokes, so
 *  Ctrl+P/N/J/K are claimed by their global commands (quick open, new file,
 *  toggle panel) and Ctrl+K starts every Ctrl+K chord. Only a window-capture
 *  listener runs early enough to turn those strokes into list movement. The
 *  price, accepted by design: while a list/menu/overlay owns the keyboard,
 *  Ctrl+K chords are unavailable.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useRef } from 'react'
import { isEditableElement } from '../dom/domRealm.js'
import { OwnerDocumentContext } from '../overlay/ownerDocumentContext.js'
import { ctrlNavigationDirection, type CtrlNavigationDirection } from './ctrlNavigation.js'
export type { CtrlNavigationDirection }

export type CtrlNavigationLayerKind = 'menu' | 'dialog' | 'overlay' | 'list'

export interface ICtrlNavigationLayerOptions {
  readonly kind: CtrlNavigationLayerKind
  readonly directions: readonly CtrlNavigationDirection[]
  readonly onMove: (direction: CtrlNavigationDirection, event: KeyboardEvent) => void
  /**
   * Layers that mount/unmount with their surface should pass their open state.
   * The hook re-registers when this flips, so a closed menu leaves no listener
   * claiming strokes for it.
   */
  readonly enabled?: boolean | undefined
  /**
   * Focus-checked layers (overlay/list) only. The element that owns the
   * keyboard, read at keydown time so a callback ref mounting later still works.
   * Menu/dialog layers do not need it: they are active for as long as they are
   * registered.
   */
  readonly getElement?: (() => HTMLElement | null) | undefined
  /**
   * `self` requires the element itself to be `activeElement` (the house model
   * for Tree/FlatList: the container holds focus, rows do not). `within` accepts
   * any focused descendant (overlays, graphs with focusable rows). Defaults to
   * `self` for lists and `within` for everything else.
   */
  readonly focus?: 'self' | 'within' | undefined
  /**
   * Focus-checked layers ignore editable targets by default, so a search box or
   * inline editor inside the list keeps its own keys. Dialogs whose interactive
   * rows are checkboxes opt in.
   */
  readonly allowEditableFocus?: boolean | undefined
  readonly targetDocument?: Document | undefined
}

interface LayerEntry {
  /** Read on every stroke so a caller may change kind/directions without re-registering. */
  readonly options: { current: ICtrlNavigationLayerOptions }
  readonly sequence: number
}

interface DocumentState {
  readonly view: Window
  readonly layers: Map<symbol, LayerEntry>
  readonly listener: (event: KeyboardEvent) => void
}

const KIND_PRIORITY: Record<CtrlNavigationLayerKind, number> = {
  menu: 3,
  dialog: 2,
  overlay: 1,
  list: 0,
}

const documents = new Map<Document, DocumentState>()
let nextSequence = 1

function elementDepth(element: Element): number {
  let depth = 0
  for (let node = element.parentElement; node !== null; node = node.parentElement) depth++
  return depth
}

function isLayerActive(entry: LayerEntry, doc: Document): boolean {
  const options = entry.options.current
  if (options.enabled === false) return false
  // Menus paint with virtual focus and dialogs are modal: both own the keyboard
  // while mounted, regardless of where DOM focus happens to sit.
  if (options.kind === 'menu' || options.kind === 'dialog') return true
  const element = options.getElement?.() ?? null
  if (element === null) return false
  const active = doc.activeElement
  if (active === null) return false
  if (options.allowEditableFocus !== true && isEditableElement(active)) return false
  const focus = options.focus ?? (options.kind === 'list' ? 'self' : 'within')
  return focus === 'within' ? element.contains(active) : active === element
}

/** Whether `a` should beat `b` for the same stroke. */
function outranks(a: LayerEntry, b: LayerEntry): boolean {
  const aOptions = a.options.current
  const bOptions = b.options.current
  const priorityDelta = KIND_PRIORITY[aOptions.kind] - KIND_PRIORITY[bOptions.kind]
  if (priorityDelta !== 0) return priorityDelta > 0
  const aElement = aOptions.getElement?.() ?? null
  const bElement = bOptions.getElement?.() ?? null
  if (aElement !== null && bElement !== null && aElement !== bElement) {
    // Nested overlays: the inner surface owns the stroke.
    if (aElement.contains(bElement)) return false
    if (bElement.contains(aElement)) return true
    const depthDelta = elementDepth(aElement) - elementDepth(bElement)
    if (depthDelta !== 0) return depthDelta > 0
  }
  // Same layer, or unrelated elements: the most recently mounted surface wins.
  return a.sequence > b.sequence
}

function pickLayer(
  state: DocumentState,
  doc: Document,
  direction: CtrlNavigationDirection,
): LayerEntry | undefined {
  let best: LayerEntry | undefined
  for (const entry of state.layers.values()) {
    if (!entry.options.current.directions.includes(direction)) continue
    if (!isLayerActive(entry, doc)) continue
    if (best === undefined || outranks(entry, best)) best = entry
  }
  return best
}

function handleKeyDown(state: DocumentState, doc: Document, event: KeyboardEvent): void {
  // An earlier listener already acted on the stroke.
  if (event.defaultPrevented) return
  // Mid-composition strokes are the IME's.
  if (event.isComposing || event.keyCode === 229) return
  const direction = ctrlNavigationDirection(event)
  if (direction === undefined) return
  const layer = pickLayer(state, doc, direction)
  if (layer === undefined) return
  // Claim before invoking: the dispatcher on document capture must not also run
  // the global command / enter the Ctrl+K chord, and other window listeners must
  // not move a second surface.
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  layer.options.current.onMove(direction, event)
}

function ensureDocument(doc: Document): DocumentState | undefined {
  const existing = documents.get(doc)
  if (existing !== undefined) return existing
  const view = doc.defaultView
  if (view === null) return undefined
  const listener = (event: KeyboardEvent): void => handleKeyDown(state, doc, event)
  const state: DocumentState = {
    view,
    layers: new Map(),
    listener,
  }
  view.addEventListener('keydown', state.listener, true)
  documents.set(doc, state)
  return state
}

function registerLayer(doc: Document, entry: LayerEntry): () => void {
  const state = ensureDocument(doc)
  if (state === undefined) return () => undefined
  const id = Symbol('ctrlNavigationLayer')
  state.layers.set(id, entry)
  return () => {
    if (!state.layers.delete(id)) return
    if (state.layers.size > 0) return
    state.view.removeEventListener('keydown', state.listener, true)
    documents.delete(doc)
  }
}

/**
 * Register the calling component as the current document's list-navigation
 * layer. Register only the directions the surface really implements: a Tree
 * leaves Ctrl+H/L alone, so replace/select-line keep their global meaning.
 */
export function useCtrlNavigationLayer(options: ICtrlNavigationLayerOptions): void {
  const contextDoc = useContext(OwnerDocumentContext)
  const enabled = options.enabled !== false
  // Read as a value so a caller that only learns its document after mount
  // re-registers: resolving `optionsRef.current` inside the effect would pin
  // the layer to the fallback document forever.
  const targetDocument = options.targetDocument
  // Handlers change every render; the entry reads through this ref so the
  // listener is not torn down and re-installed on every keystroke-driven render.
  const optionsRef = useRef(options)
  optionsRef.current = options
  useEffect(() => {
    if (!enabled) return undefined
    // Resolve inside the effect: a callback ref (the popup element, the list
    // container) is attached by the time effects run. `getElement` also carries
    // the owner document for portals rendered into an auxiliary window without
    // an explicit OwnerDocumentProvider.
    const doc =
      targetDocument ??
      contextDoc ??
      optionsRef.current.getElement?.()?.ownerDocument ??
      (typeof document === 'undefined' ? undefined : document)
    if (doc === undefined) return undefined
    return registerLayer(doc, { options: optionsRef, sequence: nextSequence++ })
  }, [contextDoc, enabled, targetDocument])
}

/** Test-only: drop every registered document and listener. */
export function __resetCtrlNavigationForTests(): void {
  for (const [doc, state] of documents) {
    state.view.removeEventListener('keydown', state.listener, true)
    documents.delete(doc)
  }
  nextSequence = 1
}

/** Test-only: number of live layers for a document. */
export function __getCtrlNavigationLayerCountForTests(doc: Document): number {
  return documents.get(doc)?.layers.size ?? 0
}
