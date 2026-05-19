/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-process global error handlers. Install once at bootstrap top.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '@universe-editor/platform'

export function installRendererErrorHandlers(): void {
  window.onerror = (_message, _source, _lineno, _colno, error) => {
    onUnexpectedError(error ?? _message)
    return false
  }

  window.onunhandledrejection = (event) => {
    onUnexpectedError(event.reason)
  }
}
