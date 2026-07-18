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
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'

const PREVIEW_NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])

export class PeekNavigationContribution extends Disposable implements IWorkbenchContribution {
  private _executeCommand: (<T = unknown>(id: string, ...args: unknown[]) => Promise<T>) | undefined
  private _listService:
    | {
        readonly lastFocusedList:
          | {
              getFocus(): unknown[]
              setSelection(items: unknown[], browserEvent?: unknown): void
              onDidChangeFocus(listener: () => void): { dispose(): void }
            }
          | undefined
      }
    | undefined
  private _pendingFocusMirror: { dispose(): void } | undefined

  constructor() {
    super()
    void MonacoLoader.getCommandService().then((svc) => {
      if (!this._store.isDisposed) this._executeCommand = svc.executeCommand.bind(svc)
    })
    void MonacoLoader.getListService().then((svc) => {
      if (!this._store.isDisposed) this._listService = svc
    })

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || !active.closest('.ref-tree')) return

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
    document.addEventListener('keydown', onKeyDown, true)
    this._register({
      dispose: () => {
        this._pendingFocusMirror?.dispose()
        document.removeEventListener('keydown', onKeyDown, true)
      },
    })
  }
}
