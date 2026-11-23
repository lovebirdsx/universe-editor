/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Where "focus is inside a webview" is decided, shared by the Vim dispatcher
 *  (which must not touch keys there) and `FocusContextKeyContribution` (which
 *  mirrors it into the `webviewFocus` context key). iframes swallow key events
 *  before the workbench sees them, and surfaces that embed foreign content mark
 *  their container with `data-vim-surface="webview"`.
 *--------------------------------------------------------------------------------------------*/

export const WEBVIEW_MARKER_SELECTOR = '[data-vim-surface="webview"]'

export function isWebviewElement(element: Element | null | undefined): boolean {
  if (element === null || element === undefined) return false
  if (element.tagName.toUpperCase() === 'IFRAME') return true
  return element.closest?.(WEBVIEW_MARKER_SELECTOR) != null
}

export function isWebviewFocus(doc: Document): boolean {
  return isWebviewElement(doc.activeElement)
}
