/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Routes Monaco's internal unexpected-error channel into the workbench's
 *  onUnexpectedError. Monaco's default handler rethrows every error it swallows
 *  (language-provider rejections included) as a synthetic
 *  `new Error(message + '\n\n' + stack)` inside a setTimeout — the copy loses the
 *  original class and name, so the global handlers' benign-error classification
 *  (e.g. IpcChannelDisposedError when an extension-host relaunch tears down
 *  in-flight provider calls on a workspace swap) can never match it, and each
 *  torn-down call lands in the log as a spurious error.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '@universe-editor/platform'

export interface MonacoErrorsModuleLike {
  errorHandler: { unexpectedErrorHandler: (e: unknown) => void }
}

/**
 * Replace Monaco's rethrow-in-setTimeout default with a direct forward, so the
 * original error instance reaches the workbench handler — and its benign-error
 * filtering — intact.
 */
export function installMonacoErrorRouting(errors: MonacoErrorsModuleLike): void {
  errors.errorHandler.unexpectedErrorHandler = (e: unknown) => onUnexpectedError(e)
}

/** Load Monaco's errors module (shared singleton across all esm entrypoints)
 *  and install the routing. */
export async function initMonacoErrorRouting(): Promise<void> {
  const errors = await import('monaco-editor/esm/vs/base/common/errors.js')
  installMonacoErrorRouting(errors)
}
