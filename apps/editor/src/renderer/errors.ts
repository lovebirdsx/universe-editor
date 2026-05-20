/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-process global error handlers. Install once at bootstrap top.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '@universe-editor/platform'

export function installRendererErrorHandlers(): void {
  // Suppress the benign "ResizeObserver loop" browser warning. It fires when a
  // ResizeObserver callback causes more resize notifications than can be
  // delivered in a single animation frame — typically from third-party layout
  // libraries (Allotment) during panel show/hide transitions. Belt-and-suspenders
  // on top of the rAF deferral in WorkbenchLayout.
  window.addEventListener('error', (e) => {
    if (e.message === 'ResizeObserver loop completed with undelivered notifications') {
      e.stopImmediatePropagation()
    }
  })

  window.onerror = (_message, _source, _lineno, _colno, error) => {
    if (_message === 'ResizeObserver loop completed with undelivered notifications') return true
    onUnexpectedError(error ?? _message)
    return false
  }

  window.onunhandledrejection = (event) => {
    onUnexpectedError(event.reason)
  }
}
