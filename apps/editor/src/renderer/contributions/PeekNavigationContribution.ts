/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Restores VSCode parity for keyboard navigation inside the references peek
 *  (Peek/Go to Definition · References · Implementations).
 *
 *  A standalone Monaco editor is missing the workbench's list-keybinding layer,
 *  which breaks two keyboard behaviours the peek tree relies on:
 *
 *  1. Enter only *previews* a reference, never follows to the target file. The
 *     tree's ResourceNavigator derives its `pinned` flag from the originating
 *     event, and a raw keyboard Enter carries no `pinned`/`preserveFocus`, so it
 *     defaults to pinned=false → referencesWidget `onDidOpen` takes the `show`
 *     (preview) branch instead of `goto` (jump). (Mouse double-click works
 *     because it hard-codes pinned=true.) VSCode bridges this with its list
 *     `list.select` keybinding; we re-add it by invoking monaco's `openReference`
 *     command (opens pinned=true → goto → our EditorOpenerContribution jumps to
 *     the file and closes the peek).
 *
 *  2. Arrow/Page/Home/End move the *focus* but never the *selection*, and the
 *     ResourceNavigator only listens to selection changes — so moving through the
 *     list shows no live preview. `selectionNavigation: true` only sets a context
 *     key; the actual focus→selection mirroring lives in workbench list
 *     keybindings the standalone editor doesn't ship. We re-add it by mirroring
 *     the new focus onto the selection *after* the tree moves it, which drives the
 *     navigator's `show` (preview) path with focus preserved on the tree.
 *
 *     Timing is the subtle part: the list's KeyboardController moves the focus in
 *     the *bubble* phase (after our capture listener), so we cannot read the new
 *     focus synchronously. A `queueMicrotask` is also wrong — the microtask
 *     checkpoint runs when the capture callback's stack empties, i.e. *before* the
 *     bubble-phase move, so it mirrors the stale (previous) focus and the preview
 *     lags one keystroke behind. Instead we hook the tree's own
 *     `onDidChangeFocus`: it fires exactly when the KeyboardController lands the
 *     move, so mirroring there is correct by construction.
 *
 * 3. Bare h/j/k/l move the tree like the arrow keys (left collapses or steps to
 *    the parent, right expands or enters the first child). These strokes cannot
 *    be plain keybindings: the global dispatcher runs in the document capture
 *    phase without checking `defaultPrevented`. We claim them here in window
 *    capture, mirror focus onto selection synchronously, and stop propagation
 *    before the global dispatcher (or monaco's list typeahead) sees them.
 *
 *    Ctrl+H/J/K/L are deliberately not claimed: they keep their global meanings
 *    (toggle panel / chord leader / replace / expand line selection), so the
 *    Ctrl+K chord works again while the tree has focus. Bare keys work with Vim
 *    mode on or off — while the tree owns DOM focus the host editor has no text
 *    focus, so the Vim controller yields and the stroke reaches us. Matching
 *    lower-cased `e.key` means CapsLock `J` still navigates while Shift+J does
 *    not. Unlike a bare arrow press, these handlers are invoked by us and land
 *    their focus change synchronously, so there is no pending-focus dance.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable, type IWorkbenchContribution } from '@universe-editor/platform'
import {
  isEditableElement,
  isHTMLElementLike,
  isKeybindingChordPending,
  type CtrlNavigationDirection,
} from '@universe-editor/workbench-ui'
import { MonacoLoader, type MonacoListService } from '../workbench/editor/monaco/MonacoLoader.js'
import { installPerWorkbenchDocument } from '../services/windows/workbenchDocumentEvents.js'

const PREVIEW_NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])

/**
 * Bare-key movement alias. Unlike `ctrlNavigationDirection` this matches only
 * strokes with NO modifier: Ctrl+J must still toggle the panel and Ctrl+K must
 * still start a chord while the peek tree has focus. Shift is excluded because
 * uppercase letters name global commands; `e.key` is lower-cased so CapsLock
 * still navigates and non-QWERTY layouts resolve to the letter they produced.
 */
function bareNavigationDirection(e: KeyboardEvent): CtrlNavigationDirection | undefined {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return undefined
  switch (e.key.toLowerCase()) {
    case 'j':
      return 'down'
    case 'k':
      return 'up'
    case 'h':
      return 'left'
    case 'l':
      return 'right'
    default:
      return undefined
  }
}

export class PeekNavigationContribution extends Disposable implements IWorkbenchContribution {
  private _executeCommand: (<T = unknown>(id: string, ...args: unknown[]) => Promise<T>) | undefined
  private _listService: MonacoListService | undefined
  private _pendingFocusMirror: { dispose(): void } | undefined

  constructor() {
    super()
    void MonacoLoader.getCommandService().then((svc) => {
      if (!this._store.isDisposed) this._executeCommand = svc.executeCommand.bind(svc)
    })
    void MonacoLoader.getListService().then((svc) => {
      if (!this._store.isDisposed) this._listService = svc
    })

    const onKeyDown = (doc: Document, e: KeyboardEvent): void => {
      // IME composition owns every keystroke until it commits.
      if (e.isComposing || e.keyCode === 229) return
      // An earlier window-capture listener already acted on this stroke.
      if (e.defaultPrevented) return
      // A pending chord's second stroke belongs to the global dispatcher, which
      // claims it unconditionally (even when it matches nothing). Handling it
      // here would move the tree or open a reference instead of completing or
      // cancelling the chord.
      if (isKeybindingChordPending(doc)) return

      const direction = bareNavigationDirection(e)
      if (direction !== undefined) {
        // The peek can live in an auxiliary window; use that document's focus.
        const active = doc.activeElement
        if (!isHTMLElementLike(active) || !active.closest('.ref-tree')) return
        // A search box or inline editing control inside the tree keeps its keys.
        if (isEditableElement(active)) return
        // lastFocusedList is renderer-wide and can still point at another
        // editor group's tree; only move the tree that owns the focused element.
        const list = this._listService?.lastFocusedList
        if (!list || !list.getHTMLElement().contains(active)) return
        // ReferencesTree extends AsyncDataTree, which wraps the actual
        // AbstractTree focus/collapse controller; the arrow methods live there.
        const tree = list.tree
        if (!tree) return

        // Window capture runs before the document-capture global dispatcher,
        // which deliberately no longer checks defaultPrevented, and before
        // monaco's list typeahead. Stopping propagation is what keeps bare j/k
        // away from global commands (e.g. the ACP timeline's j/k) and from
        // double-acting on the tree. Same claim pattern as ctrlNavigationRegistry.
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()

        // A bare-arrow press at a boundary may have left a mirror pending.
        this._pendingFocusMirror?.dispose()
        this._pendingFocusMirror = undefined

        const before = list.getFocus()[0]
        switch (direction) {
          case 'down':
            tree.focusNext(1, false, e)
            break
          case 'up':
            tree.focusPrevious(1, false, e)
            break
          case 'left':
            tree.onLeftArrow?.(e)
            break
          case 'right':
            tree.onRightArrow?.(e)
            break
        }

        // These calls move focus synchronously (unlike the bubble-phase
        // KeyboardController behind the bare arrows), so mirror right away.
        // Passing the keyboard event keeps preserveFocus: the navigator takes
        // its preview branch and focus stays on the tree.
        const focused = list.getFocus()
        const element = focused[0]
        if (element === undefined || element === before) return
        list.setSelection(focused, e)
        list.reveal(element)
        return
      }

      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      // The peek can live in an auxiliary window; use that document's focus.
      const active = doc.activeElement
      if (!isHTMLElementLike(active) || !active.closest('.ref-tree')) return

      if (e.key === 'Enter') {
        // Multi-file group headers keep the tree's own Enter handling so they
        // still expand/collapse; only leaf references are hijacked to jump.
        const row = active.closest('.monaco-list-row')
        if (row?.querySelector('.monaco-tl-twistie')?.classList.contains('collapsible')) return
        const exec = this._executeCommand
        if (!exec) return
        e.preventDefault()
        e.stopPropagation()
        void exec('openReference')
        return
      }

      if (PREVIEW_NAV_KEYS.has(e.key)) {
        const list = this._listService?.lastFocusedList
        if (!list) return
        // The bubble-phase KeyboardController is about to move the focus. Hook a
        // one-shot focus-change listener so we mirror focus → selection at the
        // exact moment the move lands (not a keystroke early). A rapid second
        // press before the first move fires supersedes the still-pending one.
        this._pendingFocusMirror?.dispose()
        const sub = list.onDidChangeFocus(() => {
          sub.dispose()
          if (this._pendingFocusMirror === sub) this._pendingFocusMirror = undefined
          // Passing the keyboard event keeps preserveFocus (focus stays on the tree).
          list.setSelection(list.getFocus(), e)
        })
        this._pendingFocusMirror = sub
      }
    }
    this._register(
      installPerWorkbenchDocument((doc) => {
        const view = doc.defaultView
        if (!view) return toDisposable(() => {})
        const handler = (e: KeyboardEvent): void => onKeyDown(doc, e)
        view.addEventListener('keydown', handler, true)
        return toDisposable(() => {
          view.removeEventListener('keydown', handler, true)
        })
      }),
    )
    this._register({
      dispose: () => {
        this._pendingFocusMirror?.dispose()
      },
    })
  }
}
