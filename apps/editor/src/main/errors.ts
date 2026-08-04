/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process global error handlers. Must be called before any async work.
 *  Besides the text log, every failure is folded into the structured error
 *  sink (errors.jsonl) via `record` so post-mortem analysis is machine-readable.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'

export type MainErrorRecorder = (event: string, error: unknown) => void

export function installMainErrorHandlers(logger: ILogger, record?: MainErrorRecorder): void {
  process.on('uncaughtException', (err) => {
    logger.error('[uncaughtException]', err.stack ?? err.message)
    record?.('uncaughtException', err)
  })

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    logger.error('[unhandledRejection]', msg)
    record?.('unhandledRejection', reason)
  })
}
