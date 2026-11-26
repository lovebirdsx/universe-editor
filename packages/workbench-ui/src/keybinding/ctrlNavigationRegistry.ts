/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ctrlNavigationRegistry — one window-capture listener per document that routes
 *  the Ctrl movement aliases (Ctrl+J/K/H/L) to the active menu, dialog, overlay
 *  or config-bar surface.
 *
 *  Pure view lists and trees deliberately do not register a layer: they use the
 *  bare Vim keys or the arrow keys, so Ctrl+J/K/H/L keep their global workbench
 *  meaning (toggle panel / chord leader / replace / expand-line-selection). Only
 *  pickers whose focus lives in an editable input, menus with virtual focus,
 *  dialogs and the config bar need the aliases.
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
 *  Ctrl+J is claimed by Toggle Panel and Ctrl+K starts every Ctrl+K chord;
 *  Ctrl+H/L otherwise fall through to Replace / line selection. Only a
 *  window-capture listener runs early enough to turn those strokes into list
 *  movement. Ctrl+P/N are deliberately absent: they stay with Quick Open / New
 *  File everywhere, including list surfaces. The price, accepted by design:
 *  while a menu/overlay/dialog owns the keyboard, Ctrl+K chords are unavailable.
 *
 *  Vim no longer lives in this file. The workbench installs one provider via
 *  `setVimKeyHandlerProvider`; it runs after the Ctrl aliases and returns true
 *  when it consumed the stroke. This listener is installed even when no list
 *  layer is registered (`ensureNavigationDocument`) so bare Vim keys work on
 *  the editor and the chrome surfaces too. Surfaces register themselves with
 *  `vim/vimSurfaceRegistry`, not through the Ctrl layer.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useRef } from 'react'
import { OwnerDocumentContext } from '../overlay/ownerDocumentContext.js'
import { hideKeyboardTooltip } from '../tooltip/keyboardTooltip.js'
import { ctrlNavigationDirection, type CtrlNavigationDirection } from './ctrlNavigation.js'
import { isKeybindingChordPending } from './keybindingChordState.js'
import { isNavigationLayerActive, navigationLayerOutranks } from './vim/navigationLayers.js'
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
  /** Number of callers that must keep the listener installed regardless of layers. */
  pinned: number
}

const KIND_PRIORITY: Record<CtrlNavigationLayerKind, number> = {
  menu: 3,
  dialog: 2,
  overlay: 1,
  list: 0,
}

const documents = new Map<Document, DocumentState>()
let nextSequence = 1

let vimKeyHandlerProvider: ((doc: Document, event: KeyboardEvent) => boolean) | undefined

/**
 * Installed by the workbench dispatcher so the pure UI package stays DI-free.
 * The provider receives the document the stroke was captured on, performs every
 * suppression it needs, and returns true when Vim consumed the stroke.
 */
export function setVimKeyHandlerProvider(
  provider: ((doc: Document, event: KeyboardEvent) => boolean) | undefined,
): void {
  vimKeyHandlerProvider = provider
}

function isAlwaysActive(kind: string): boolean {
  return kind === 'menu' || kind === 'dialog'
}

function layerPriority(kind: string): number {
  return KIND_PRIORITY[kind as CtrlNavigationLayerKind] ?? -1
}

function pickLayer(
  state: DocumentState,
  doc: Document,
  direction: CtrlNavigationDirection,
): LayerEntry | undefined {
  let best: LayerEntry | undefined
  for (const entry of state.layers.values()) {
    if (!entry.options.current.directions.includes(direction)) continue
    const layer = toNavigationLayer(entry)
    if (!isNavigationLayerActive(layer, doc, isAlwaysActive)) continue
    if (
      best === undefined ||
      navigationLayerOutranks(layer, toNavigationLayer(best), layerPriority)
    ) {
      best = entry
    }
  }
  return best
}

function toNavigationLayer(entry: LayerEntry): {
  kind: string
  sequence: number
  enabled?: boolean | undefined
  getElement?: (() => HTMLElement | null) | undefined
  focus?: 'self' | 'within' | undefined
  allowEditableFocus?: boolean | undefined
} {
  const options = entry.options.current
  return {
    kind: options.kind,
    sequence: entry.sequence,
    enabled: options.enabled,
    getElement: options.getElement,
    focus: options.focus ?? (options.kind === 'list' ? 'self' : 'within'),
    allowEditableFocus: options.allowEditableFocus,
  }
}

function consume(event: KeyboardEvent): void {
  // Claim before invoking: the dispatcher on document capture must not also run
  // the global command / enter the Ctrl+K chord, and other window listeners must
  // not move a second surface.
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

function handleKeyDown(state: DocumentState, doc: Document, event: KeyboardEvent): void {
  // Any stroke dismisses a keyboard-triggered tooltip. This must run before the
  // early returns below: Vim claims strokes with stopPropagation (the provider's
  // own document listener never sees them), and Ctrl aliases / pending chords
  // return before the provider runs. Mouse/focus tooltips are unaffected.
  hideKeyboardTooltip(doc)
  // An earlier listener already acted on the stroke.
  if (event.defaultPrevented) return
  // Mid-composition strokes are the IME's.
  if (event.isComposing || event.keyCode === 229) return
  // A pending chord second stroke belongs to the dispatcher, not to navigation.
  if (isKeybindingChordPending(doc)) return
  const direction = ctrlNavigationDirection(event)
  if (direction !== undefined) {
    const layer = pickLayer(state, doc, direction)
    if (layer === undefined) return
    consume(event)
    layer.options.current.onMove(direction, event)
    return
  }
  const provider = vimKeyHandlerProvider
  if (provider === undefined) return
  if (provider(doc, event)) consume(event)
}

function ensureDocument(doc: Document): DocumentState | undefined {
  const existing = documents.get(doc)
  if (existing !== undefined) return existing
  const view = doc.defaultView
  if (view === null) return undefined
  const state: DocumentState = {
    view,
    layers: new Map(),
    pinned: 0,
    listener: (event: KeyboardEvent) => handleKeyDown(state, doc, event),
  }
  view.addEventListener('keydown', state.listener, true)
  documents.set(doc, state)
  return state
}

function releaseIfIdle(doc: Document, state: DocumentState): void {
  if (state.layers.size > 0 || state.pinned > 0) return
  state.view.removeEventListener('keydown', state.listener, true)
  documents.delete(doc)
}

/**
 * Pin the window-capture listener for `doc` even when no list layer is
 * registered. The workbench dispatcher needs Vim strokes on editor and chrome
 * surfaces, which never use `useCtrlNavigationLayer`. Dispose un-pins.
 */
export function ensureNavigationDocument(doc: Document): { dispose(): void } {
  const state = ensureDocument(doc)
  if (state === undefined) return { dispose: () => undefined }
  state.pinned++
  let released = false
  return {
    dispose: () => {
      if (released) return
      released = true
      state.pinned--
      releaseIfIdle(doc, state)
    },
  }
}

function registerLayer(doc: Document, entry: LayerEntry): () => void {
  const state = ensureDocument(doc)
  if (state === undefined) return () => undefined
  const id = Symbol('ctrlNavigationLayer')
  state.layers.set(id, entry)
  return () => {
    if (!state.layers.delete(id)) return
    releaseIfIdle(doc, state)
  }
}

/**
 * Register the calling component as the current document's list-navigation
 * layer. Register only the directions the surface really implements: a flat
 * list with no horizontal semantics leaves Ctrl+H/L to replace/select-line.
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
    const sequence = nextSequence++
    return registerLayer(doc, { options: optionsRef, sequence })
  }, [contextDoc, enabled, targetDocument])
}

/** Test-only: drop every registered document and listener. */
export function __resetCtrlNavigationForTests(): void {
  for (const [doc, state] of documents) {
    state.view.removeEventListener('keydown', state.listener, true)
    documents.delete(doc)
  }
  nextSequence = 1
  vimKeyHandlerProvider = undefined
}

/** Test-only: number of live layers for a document. */
export function __getCtrlNavigationLayerCountForTests(doc: Document): number {
  return documents.get(doc)?.layers.size ?? 0
}
