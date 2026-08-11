/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Crash diagnostics for failures that bypass every JS-level handler: native
 *  crashes (main / GPU / utility process) leave no uncaughtException and no log
 *  line — a local minidump plus a child-process-gone entry is the only evidence
 *  a "silent quit" leaves behind.
 *--------------------------------------------------------------------------------------------*/

import { app, crashReporter } from 'electron'
import { join } from 'node:path'
import {
  createNamedLogger,
  toDisposable,
  type IDisposable,
  type ILogChannel,
  type ILogger,
} from '@universe-editor/platform'

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
 * Non-clean exits are also folded into the structured error sink.
 */
export function installChildProcessGoneLogging(
  logger: ILogger,
  record?: (event: string, error: unknown) => void,
): void {
  app.on('child-process-gone', (_event, details) => {
    const line =
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}` +
      (details.serviceName ? ` service=${details.serviceName}` : '') +
      (details.name ? ` name=${details.name}` : '')
    if (details.reason === 'clean-exit') {
      logger.info(line)
    } else {
      logger.error(line)
      record?.('childProcessGone', line)
    }
  })
}

/** How often per-process memory/CPU snapshots are logged. */
export const PROCESS_METRICS_INTERVAL_MS = 120_000

/**
 * Periodic per-process memory/CPU snapshot. A native crash cuts the log
 * mid-stream with no memory evidence at all; these compact lines are the only
 * way to reconstruct a memory growth curve (e.g. a workspace walk leaking)
 * from a diagnostic bundle after the fact.
 */
export function installProcessMetricsLogging(loggerService: {
  createLogger(channel: ILogChannel): ILogger
}): IDisposable {
  const logger = createNamedLogger(loggerService, {
    id: 'processMetrics',
    name: 'Process Metrics',
  })
  const timer = setInterval(() => {
    try {
      const line = app
        .getAppMetrics()
        .map(
          (metric) =>
            `pid=${metric.pid} type=${metric.type} mem=${Math.round(metric.memory.workingSetSize / 1024)}MB cpu=${Math.round(metric.cpu.percentCPUUsage)}%`,
        )
        .join(' | ')
      logger.info(line)
    } catch {
      // Metrics are best-effort diagnostics; never let sampling kill the main process.
    }
  }, PROCESS_METRICS_INTERVAL_MS)
  timer.unref()
  return toDisposable(() => clearInterval(timer))
}
