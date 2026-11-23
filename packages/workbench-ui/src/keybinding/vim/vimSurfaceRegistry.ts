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
import type { IVimKeymapEntry, IVimSurfaceRegistration, VimSurfaceKind } from './vimTypes.js'

const KIND_PRIORITY: Record<VimSurfaceKind, number> = {
  menu: 8,
  overlay: 7,
  list: 6,
  reader: 6,
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

interface KeymapSources {
  readonly sources: readonly (readonly IVimKeymapEntry[])[]
  readonly merged: readonly IVimKeymapEntry[]
}

interface SurfaceEntry extends INavigationLayerView {
  readonly read: () => IVimSurfaceRegistration
  readonly engine: VimSequenceEngine
  /** Last concatenation of the surface's keymap sources, reused while they are unchanged. */
  keymapMemo: KeymapSources | undefined
}

interface KeymapContribution {
  readonly surfaceId: string
  readonly read: () => readonly IVimKeymapEntry[]
}

interface DocumentState {
  readonly surfaces: Map<symbol, SurfaceEntry>
  readonly keymaps: Map<symbol, KeymapContribution>
  readonly listeners: Set<() => void>
}

const NO_ENTRIES: readonly IVimKeymapEntry[] = []

function isDocumentIdle(state: DocumentState): boolean {
  return state.surfaces.size === 0 && state.keymaps.size === 0 && state.listeners.size === 0
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
      if (!state.listeners.delete(listener)) return
      // Do not keep a closed document (and its DOM) alive through an empty
      // state entry once its last surface and listener are gone.
      if (isDocumentIdle(state) && documents.get(doc) === state) documents.delete(doc)
    },
  }
}

function ensureDocument(doc: Document): DocumentState | undefined {
  const existing = documents.get(doc)
  if (existing !== undefined) return existing
  if (doc.defaultView === null) return undefined
  const state: DocumentState = { surfaces: new Map(), keymaps: new Map(), listeners: new Set() }
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
    keymapMemo: undefined,
  })
  notify(state)
  return {
    dispose: () => {
      if (!state.surfaces.delete(id)) return
      notify(state)
      if (isDocumentIdle(state)) documents.delete(doc)
    },
  }
}

/**
 * Attach extra keymap entries to the surface registered under `surfaceId`.
 * For hosts that reach their surface through a shared adapter (Tree, FlatList)
 * and so cannot pass `keymap` in the registration themselves. Several
 * contributions to the same surface are concatenated in registration order.
 */
export function registerVimSurfaceKeymap(
  surfaceId: string,
  read: () => readonly IVimKeymapEntry[],
  doc?: Document,
): { dispose(): void } {
  const target = doc ?? (typeof document === 'undefined' ? undefined : document)
  const state = target === undefined ? undefined : ensureDocument(target)
  if (state === undefined || target === undefined) return { dispose: () => undefined }
  const id = Symbol('vimSurfaceKeymap')
  state.keymaps.set(id, { surfaceId, read })
  return {
    dispose: () => {
      if (!state.keymaps.delete(id)) return
      if (isDocumentIdle(state) && documents.get(target) === state) documents.delete(target)
    },
  }
}

function sameSources(
  a: readonly (readonly IVimKeymapEntry[])[],
  b: readonly (readonly IVimKeymapEntry[])[],
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Registration keymap + sidecar contributions; the same array while nothing changed. */
function resolveSurfaceKeymap(
  state: DocumentState,
  entry: SurfaceEntry,
  surface: IVimSurfaceRegistration,
): readonly IVimKeymapEntry[] {
  const sources: (readonly IVimKeymapEntry[])[] = []
  if (surface.keymap !== undefined && surface.keymap.length > 0) sources.push(surface.keymap)
  for (const contribution of state.keymaps.values()) {
    if (contribution.surfaceId !== surface.id) continue
    const entries = contribution.read()
    if (entries.length > 0) sources.push(entries)
  }
  if (sources.length === 0) return NO_ENTRIES
  if (sources.length === 1) return sources[0]!
  const memo = entry.keymapMemo
  if (memo !== undefined && sameSources(memo.sources, sources)) return memo.merged
  const merged = sources.flat()
  entry.keymapMemo = { sources, merged }
  return merged
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
  /** Entries the surface declared itself (registration `keymap` + sidecar), possibly empty. */
  readonly keymap: readonly IVimKeymapEntry[]
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
  return {
    surface,
    sequence: entry.engine,
    surfaceKey: surface.getSurfaceKey(),
    keymap: resolveSurfaceKeymap(state, entry, surface),
  }
}

/**
 * Drop every in-flight count / prefix on `doc`. Focus moving between surfaces
 * must not carry a sequence across, and unmounting the dispatcher must not let
 * a pending timer replay a command on a dead document.
 */
export function resetVimSequences(doc: Document): void {
  const state = documents.get(doc)
  if (state === undefined) return
  for (const entry of state.surfaces.values()) entry.engine.reset()
}

/** Whether `engine` still belongs to a registered surface on `doc`. */
export function isVimSurfaceEngineRegistered(doc: Document, engine: VimSequenceEngine): boolean {
  const state = documents.get(doc)
  if (state === undefined) return false
  for (const entry of state.surfaces.values()) if (entry.engine === engine) return true
  return false
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

/**
 * React binding for {@link registerVimSurfaceKeymap}. `keymap` is read through a
 * ref, so a new array per render is correct (a stable one avoids rebuilding the
 * merged keymap).
 */
export function useVimSurfaceKeymap(
  surfaceId: string,
  keymap: readonly IVimKeymapEntry[],
  targetDocument?: Document,
): void {
  const contextDoc = useContext(OwnerDocumentContext)
  const keymapRef = useRef(keymap)
  keymapRef.current = keymap
  useEffect(() => {
    return registerVimSurfaceKeymap(
      surfaceId,
      () => keymapRef.current,
      targetDocument ?? contextDoc,
    ).dispose
  }, [surfaceId, contextDoc, targetDocument])
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

/** Test-only: whether the registry still holds an entry for `doc`. */
export function __hasVimDocumentStateForTests(doc: Document): boolean {
  return documents.has(doc)
}
