/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-process global error handlers. Install once at bootstrap top.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '@universe-editor/platform'

function isThirdPartyError(error: unknown): boolean {
  const errorStr = String(error)
  if (errorStr.startsWith('ResizeObserver loop completed with undelivered notifications')) {
    return true
  }

  return false
}

export function installRendererErrorHandlers(): void {
  // Suppress the benign "ResizeObserver loop" browser warning. It fires when a
  // ResizeObserver callback causes more resize notifications than can be
  // delivered in a single animation frame — typically from third-party layout
  // libraries (Allotment) during panel show/hide transitions. Belt-and-suspenders
  // on top of the rAF deferral in WorkbenchLayout.
  window.addEventListener('error', (e) => {
    if (isThirdPartyError(e.message)) {
      e.stopImmediatePropagation()
    }
  })

  window.onerror = (_message, _source, _lineno, _colno, error) => {
    if (isThirdPartyError(_message)) {
      return true
    }
    onUnexpectedError(error ?? _message)
    return false
  }

  window.onunhandledrejection = (event) => {
    onUnexpectedError(event.reason)
  }
}
