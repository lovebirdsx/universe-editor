/*---------------------------------------------------------------------------------------------
 *  focusRestore — the single element-level focus save/restore contract for
 *  transient overlays (dialogs, pickers, popovers, the notification center).
 *
 *  Two layers, deliberately split:
 *    - `captureFocus` / `restoreFocus` / `focusElement` are imperative helpers
 *      for hosts that already know when the overlay opens and closes (the
 *      config-bar pickers capture an "opener" when a surface mounts).
 *    - `useFocusRestore` wraps the visible false→true capture / real-close
 *      restore for hosts whose lifetime is a boolean (FocusScopeOverlay, the
 *      notifications center).
 *
 *  StrictMode: dev replays setup→cleanup→setup for newly mounted components.
 *  The captured snapshot is read-only during render and only consumed by the
 *  deferred restore, which also checks a session counter so the rehearsal's
 *  cleanup restores nothing. See docs/development/overlay-layers.md.
 *
 *  `FocusRestoreFallbackContext` carries the workbench's semantic fallback
 *  (focus the active editor) for snapshots whose element left the document —
 *  the editor may have been remounted while a dialog was up.
 *--------------------------------------------------------------------------------------------*/

import { createContext, useContext, useEffect, useRef } from 'react'
import { isHTMLElementLike } from '../dom/domRealm.js'
import { useOwnerDocument } from './ownerDocumentContext.js'

export interface FocusSnapshot {
  /** The element that held focus when the overlay opened. */
  readonly element: HTMLElement
  /** Document that element (and the overlay) belong to. */
  readonly document: Document
}

export interface CaptureFocusOptions {
  /**
   * Subtree the snapshot must not come from — typically the overlay root being
   * replaced (a picker that reopens itself through the same code path), or the
   * trigger a click is about to focus.
   */
  readonly exclude?: Element | null
}

/**
 * Snapshot the element holding focus in `doc`. Returns `null` for "nothing
 * useful is focused" — `<body>`/the document element mean no owner would get
 * the caret back, and an element inside `exclude` is the overlay we are about
 * to replace rather than where the user came from.
 */
export function captureFocus(
  doc: Document,
  options: CaptureFocusOptions = {},
): FocusSnapshot | null {
  const active = doc.activeElement
  if (!isHTMLElementLike(active)) return null
  if (active === doc.body || active === doc.documentElement) return null
  const exclude = options.exclude ?? null
  if (exclude !== null && typeof exclude.contains === 'function' && exclude.contains(active)) {
    return null
  }
  return { element: active, document: doc }
}

/**
 * Focus `element` when it can really take the caret. The post-focus check
 * catches elements the browser silently refuses (inert rows, detached nodes):
 * a bare `focus()` would leave the caret on `<body>`, where no later stroke has
 * an owner.
 */
export function focusElement(
  element: Element | null | undefined,
  doc?: Document | undefined,
): boolean {
  if (element === null || element === undefined) return false
  if (!isHTMLElementLike(element)) return false
  if (element.isConnected === false) return false
  if (typeof element.focus !== 'function') return false
  const targetDocument = doc ?? element.ownerDocument
  if (
    targetDocument !== null &&
    targetDocument !== undefined &&
    (element === targetDocument.body || element === targetDocument.documentElement)
  ) {
    return false
  }
  element.focus({ preventScroll: true })
  if (targetDocument === null || targetDocument === undefined) return true
  const active = targetDocument.activeElement
  return (
    active === element ||
    (active !== null && typeof element.contains === 'function' && element.contains(active))
  )
}

export interface RestoreFocusOptions {
  /** Consulted at restore time; `false` abandons the restore. */
  readonly when?: (() => boolean) | undefined
  /**
   * Only restore while focus still belongs to `container` (or has dropped to
   * `<body>` / `null`). Use it to avoid yanking focus back from a surface the
   * user deliberately moved to while the overlay was open. A getter is
   * evaluated at restore time — the overlay may already be unmounted, and a
   * detached element still answers `contains()` correctly.
   */
  readonly onlyIfLost?: Element | null | (() => Element | null) | undefined
  /**
   * Semantic fallback when the snapshot element is gone or refuses focus
   * (`false` = not handled; focus is left where it is). Never focuses `<body>`.
   */
  readonly fallback?: ((doc: Document) => boolean) | undefined
}

function resolveOnlyIfLost(
  value: Element | null | (() => Element | null) | undefined,
): Element | null {
  if (value === undefined) return null
  if (typeof value === 'function') return value()
  return value
}

/**
 * Return focus to `snapshot.element`. Resolution order:
 *   `when()` false → abandon; `onlyIfLost` mismatch → abandon; element still
 *   connected and focusable → focus it; otherwise the explicit `fallback`.
 * A `null` snapshot is a no-op — hosts that still need a hand-back (e.g. the
 * config bar's trigger) pass their own fallback at the call site.
 */
export function restoreFocus(
  snapshot: FocusSnapshot | null,
  options: RestoreFocusOptions = {},
): boolean {
  if (options.when?.() === false) return false
  if (snapshot === null) return false
  const { document: doc, element } = snapshot

  const onlyIfLost = resolveOnlyIfLost(options.onlyIfLost)
  if (onlyIfLost !== null) {
    const active = doc.activeElement
    const atBody = active === null || active === doc.body || active === doc.documentElement
    const inContainer =
      active !== null &&
      (active === onlyIfLost ||
        (typeof onlyIfLost.contains === 'function' && onlyIfLost.contains(active)))
    if (!atBody && !inContainer) return false
  }

  if (focusElement(element, doc)) return true
  return options.fallback?.(doc) === true
}

/** Focus dropped with the overlay: `<body>`, nothing, or a node removed from the DOM. */
function isFocusLost(doc: Document): boolean {
  const active = doc.activeElement
  return (
    active === null ||
    active === doc.body ||
    active === doc.documentElement ||
    active.isConnected === false
  )
}

/** Workbench-wide semantic fallback — see `FocusRestoreFallbackContext`. */
export type FocusRestoreFallback = (doc: Document) => boolean

/**
 * Supplied by the workbench root: focus the active editor when a snapshot
 * element no longer exists. `undefined` in packages/tests that have no editor.
 */
export const FocusRestoreFallbackContext = createContext<FocusRestoreFallback | undefined>(
  undefined,
)

export interface UseFocusRestoreOptions {
  /** Document the overlay belongs to (resolved via `useOwnerDocument` when omitted). */
  readonly targetDocument?: Document | undefined
  /** See `CaptureFocusOptions.exclude`. */
  readonly exclude?: Element | null
  /** See `RestoreFocusOptions.when`. */
  readonly shouldRestore?: (() => boolean) | undefined
  /** See `RestoreFocusOptions.onlyIfLost`. */
  readonly onlyIfLost?: Element | null | (() => Element | null) | undefined
  /** Overrides `FocusRestoreFallbackContext` for this overlay. */
  readonly fallback?: ((doc: Document) => boolean) | undefined
}

/**
 * Capture during the render that turns `visible` false→true (before the
 * overlay's own autoFocus layout effect runs) and restore on a real close.
 * The snapshot is never consumed by the cleanup itself: it is read-only there,
 * and the restore runs one microtask later guarded by a session counter, so
 * StrictMode's rehearsal cleanup restores nothing while a real close still
 * hands focus back.
 */
export function useFocusRestore(visible: boolean, options: UseFocusRestoreOptions = {}): void {
  const contextFallback = useContext(FocusRestoreFallbackContext)
  const doc = useOwnerDocument(options.targetDocument)

  const snapshotRef = useRef<FocusSnapshot | null>(null)
  const wasVisibleRef = useRef(false)
  if (visible && !wasVisibleRef.current) {
    snapshotRef.current =
      doc === undefined ? null : captureFocus(doc, { exclude: options.exclude ?? null })
  }
  wasVisibleRef.current = visible

  const optionsRef = useRef(options)
  optionsRef.current = options
  const contextFallbackRef = useRef(contextFallback)
  contextFallbackRef.current = contextFallback

  const sessionStateRef = useRef({ session: 0 })
  useEffect(() => {
    if (!visible) return
    const sessionState = sessionStateRef.current
    const session = ++sessionState.session
    return () => {
      // Deferred one microtask: StrictMode's mount rehearsal runs
      // cleanup→setup synchronously, and restoring there would fire spurious
      // focus/context-key events. The snapshot itself is read-only so the real
      // close still has it.
      queueMicrotask(() => {
        if (sessionState.session !== session) return
        const snapshot = snapshotRef.current
        snapshotRef.current = null
        if (snapshot === null) return
        const current = optionsRef.current
        // Deferral opens a window for whatever runs right after the close (an
        // accepted command focusing its target, Monaco's quick input opening).
        // Without an explicit `onlyIfLost`, only reclaim focus that was lost.
        if (current.onlyIfLost === undefined && !isFocusLost(snapshot.document)) return
        const fallback = current.fallback ?? contextFallbackRef.current
        restoreFocus(snapshot, {
          ...(current.shouldRestore !== undefined ? { when: current.shouldRestore } : {}),
          ...(current.onlyIfLost !== undefined ? { onlyIfLost: current.onlyIfLost } : {}),
          ...(fallback !== undefined ? { fallback } : {}),
        })
      })
    }
    // `optionsRef` keeps the predicates out of the deps: inline arrows would
    // otherwise re-run this effect (and restore focus) on every render.
  }, [visible, doc])
}
