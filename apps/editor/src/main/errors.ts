/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process global error handlers. Must be called before any async work.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'

export function installMainErrorHandlers(logger: ILogger): void {
  process.on('uncaughtException', (err) => {
    logger.error('[uncaughtException]', err.stack ?? err.message)
  })

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    logger.error('[unhandledRejection]', msg)
  })
}
