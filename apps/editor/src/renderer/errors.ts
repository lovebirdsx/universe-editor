/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-process error classification + global handlers. `isBenignError` is
 *  environment-agnostic (imported by CommandService too); the window-global
 *  installer stays DOM-only and is declared locally so the file typechecks in
 *  every consumer's lib set.
 *--------------------------------------------------------------------------------------------*/

import { IpcChannelDisposedError, onUnexpectedError } from '@universe-editor/platform'

declare const window: {
  addEventListener(
    type: 'error',
    listener: (e: { message: string; stopImmediatePropagation(): void }) => void,
  ): void
  onerror:
    | ((
        message: unknown,
        source: unknown,
        lineno: unknown,
        colno: unknown,
        error: unknown,
      ) => boolean | void)
    | null
  onunhandledrejection: ((event: { reason: unknown; preventDefault(): void }) => void) | null
}

/**
 * Benign errors that surface through the global error paths during normal
 * lifecycle transitions and carry no actionable meaning. They must not be logged
 * as errors or surfaced to the user.
 */
export function isBenignError(error: unknown): boolean {
  const errorStr = String(error)
  if (errorStr.startsWith('ResizeObserver loop completed with undelivered notifications')) {
    return true
  }

  // Monaco's diff worker throws "no diff result available" when the models it was
  // asked to diff are disposed mid-flight — i.e. the diff editor swapped inputs or
  // closed while a computeDiff() request was still in the worker. The result is
  // simply discarded; cancellation just hadn't propagated yet. It carries no
  // actionable meaning (no data loss, nothing to retry), so treat it as benign
  // lifecycle noise rather than logging it / toasting it on every diff-view switch.
  if (errorStr.includes('no diff result available')) {
    return true
  }

  // A request still in flight when its IPC channel is torn down (extension-host
  // restart on workspace swap / trust flip / crash recovery) rejects with
  // IpcChannelDisposedError — the channel being gone is the whole message, and
  // the consumer's state has already been reset by the teardown. The name check
  // covers a duplicate platform module instance (dev-server graph split), where
  // instanceof would miss.
  if (
    error instanceof IpcChannelDisposedError ||
    (error instanceof Error && error.name === 'IpcChannelDisposedError')
  ) {
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
    if (isBenignError(e.message)) {
      e.stopImmediatePropagation()
    }
  })

  window.onerror = (_message, _source, _lineno, _colno, error) => {
    if (isBenignError(error ?? _message)) {
      return true
    }
    onUnexpectedError(error ?? _message)
    return false
  }

  window.onunhandledrejection = (event) => {
    if (isBenignError(event.reason)) {
      event.preventDefault()
      return
    }
    onUnexpectedError(event.reason)
  }
}
