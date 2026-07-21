/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Crash diagnostics for failures that bypass every JS-level handler: native
 *  crashes (main / GPU / utility process) leave no uncaughtException and no log
 *  line — a local minidump plus a child-process-gone entry is the only evidence
 *  a "silent quit" leaves behind.
 *--------------------------------------------------------------------------------------------*/

import { app, crashReporter } from 'electron'
import { join } from 'node:path'
import type { ILogger } from '@universe-editor/platform'

/**
 * Keep minidumps locally under <userData>/Crashes. Must run after
 * applyProductIdentity (userData resolved) and before app ready so child
 * processes (GPU / utility / renderer) are covered too.
 */
export function installCrashReporter(): void {
  app.setPath('crashDumps', join(app.getPath('userData'), 'Crashes'))
  crashReporter.start({ uploadToServer: false })
}

/**
 * GPU / utility process deaths never surface through render-process-gone (that
 * only covers renderers) — without this hook they are completely invisible.
 */
export function installChildProcessGoneLogging(logger: ILogger): void {
  app.on('child-process-gone', (_event, details) => {
    const line =
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}` +
      (details.serviceName ? ` service=${details.serviceName}` : '') +
      (details.name ? ` name=${details.name}` : '')
    if (details.reason === 'clean-exit') logger.info(line)
    else logger.error(line)
  })
}
