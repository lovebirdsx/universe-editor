/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keyboard context-menu plumbing for FileEditor's Monaco surface.
 *
 *  With `contextmenu: false` Monaco's own menu is off, but its standalone
 *  keybinding service still owns Shift+F10 (`editor.action.showContextMenu`,
 *  weight EditorContrib): it preventDefault+stopPropagation()s on the editor
 *  container's bubble phase and then no-ops, so the browser never dispatches the
 *  native contextmenu FileEditor's mouse handler listens for. FileEditor claims
 *  both context-menu keystrokes through editor.onKeyDown (text-input target
 *  phase, before that container listener), like VSCode's ContextMenuController.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from './MonacoLoader.js'

/** The subset of the editor this module needs; keeps the unit test monaco-free. */
export interface ContextMenuAnchorEditor {
  getPosition(): { readonly lineNumber: number; readonly column: number } | null
  revealPosition(
    position: { readonly lineNumber: number; readonly column: number },
    scrollType: monaco.editor.ScrollType,
  ): void
  render(forceRedraw?: boolean): void
  getScrolledVisiblePosition(position: {
    readonly lineNumber: number
    readonly column: number
  }): { readonly top: number; readonly left: number; readonly height: number } | null
  getDomNode(): { getBoundingClientRect(): { readonly left: number; readonly top: number } } | null
}

/**
 * True for the two keystrokes that raise a context menu inside the editor.
 * Stricter than workbench-ui's `isContextMenuKey`: F10 must be a bare Shift+F10,
 * because Monaco binds Ctrl+Shift+F10 to Peek Definition on Linux.
 */
export function isEditorContextMenuKey(e: {
  readonly key: string
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
}): boolean {
  if (e.key === 'ContextMenu') return true
  return e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
}

const FALLBACK_INSET = 8

/**
 * Viewport coordinates for a keyboard-raised context menu, anchored under the
 * caret. Mirrors VSCode's `_doShowContextMenu`: reveal + render first, because
 * `getScrolledVisiblePosition` is documented as inaccurate outside the viewport.
 * Its result is editor-relative; translate with the DOM node's client rect (this
 * repo's ContextMenu anchors are viewport coordinates, not VSCode's page ones).
 */
export function computeEditorContextMenuAnchor(
  editor: ContextMenuAnchorEditor,
  scrollType: monaco.editor.ScrollType,
): { readonly x: number; readonly y: number } | null {
  const position = editor.getPosition()
  if (!position) return null
  editor.revealPosition(position, scrollType)
  editor.render()
  const domNode = editor.getDomNode()
  if (!domNode) return null
  const rect = domNode.getBoundingClientRect()
  const caret = editor.getScrolledVisiblePosition(position)
  if (!caret) return { x: rect.left + FALLBACK_INSET, y: rect.top + FALLBACK_INSET }
  return { x: rect.left + caret.left, y: rect.top + caret.top + caret.height }
}
