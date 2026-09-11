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
import {
  flattenProcessTree,
  formatProcessTreeMemory,
  type ProcessItem,
} from './services/processMonitor/processList.js'

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

/** How often per-process memory/CPU snapshots are logged while the heap is calm. */
export const PROCESS_METRICS_NORMAL_INTERVAL_MS = 30_000

/** Denser sampling once the heap is climbing — fast OOMs need a curve, not a point. */
export const PROCESS_METRICS_BUSY_INTERVAL_MS = 10_000

/** heapUsed above this switches sampling to the busy interval. */
export const MAIN_HEAP_BUSY_BYTES = 512 * 1024 * 1024

/** heapUsed above this logs at warn — the clearest pre-OOM signal we get. */
export const MAIN_HEAP_WARN_BYTES = 1536 * 1024 * 1024

/**
 * Working set of a single renderer (`type: 'Tab'`) above which we log at warn.
 * The metrics line has always carried every child process's working set, but
 * nothing ever compared it to anything — a renderer that climbed from 0.7GB to
 * 5.4GB over two hours and was then OOM-killed left a complete curve in the log
 * and not one warning. Picked below the kill point, mirroring how
 * {@link MAIN_HEAP_WARN_BYTES} leaves room to react.
 */
export const TAB_WORKING_SET_WARN_BYTES = 2 * 1024 * 1024 * 1024

/** Sampling interval for the cycle AFTER a reading of `heapUsed` bytes.
 *  `rendererBusy` forces the dense interval when a renderer is climbing even
 *  though the main heap itself is calm. */
export function processMetricsIntervalMs(heapUsed: number, rendererBusy = false): number {
  return rendererBusy || heapUsed > MAIN_HEAP_BUSY_BYTES
    ? PROCESS_METRICS_BUSY_INTERVAL_MS
    : PROCESS_METRICS_NORMAL_INTERVAL_MS
}

/** Cadence of the hosted-process tree walk while every hosted process is small. */
export const PROCESS_TREE_NORMAL_INTERVAL_MS = 60_000
/** …and once one of them is over {@link HOSTED_PROCESS_WARN_BYTES}. */
export const PROCESS_TREE_BUSY_INTERVAL_MS = 15_000

/**
 * Working set of a spawned Node child (extension host, ACP agent) above which the tree
 * line logs at warn. These processes are `child_process.spawn`ed, so they are absent
 * from `app.getAppMetrics()` entirely — the shipped crash had a 3.71GB extension host
 * that never appeared on the memory curve, and its death arrived as an unexplained
 * "silent" abort. Same order of magnitude as {@link TAB_WORKING_SET_WARN_BYTES}.
 */
export const HOSTED_PROCESS_WARN_BYTES = 2 * 1024 * 1024 * 1024

export interface ProcessMetricsOptions {
  /**
   * Reads the full process tree rooted at the main process. Injected because it needs
   * services that do not exist yet when this is installed, and omitted entirely in
   * tests / contexts without a process monitor.
   */
  readonly listProcessTree?: () => Promise<ProcessItem | undefined>
}

/**
 * `app.getAppMetrics()` only reports OS working-set — the main process can sit
 * at 160MB working set while its V8 heap is 2.6GB and seconds from aborting.
 * Sample our own `process.memoryUsage()` alongside so a diagnostic bundle
 * shows the real heap growth curve.
 */
export function formatMainHeapSample(mem: {
  heapUsed: number
  heapTotal: number
  external: number
  rss: number
}): string {
  const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024)
  return `main-heap heapUsed=${mb(mem.heapUsed)}MB heapTotal=${mb(mem.heapTotal)}MB external=${mb(mem.external)}MB rss=${mb(mem.rss)}MB`
}

/**
 * Periodic per-process memory/CPU snapshot. A native crash cuts the log
 * mid-stream with no memory evidence at all; these compact lines are the only
 * way to reconstruct a memory growth curve (e.g. a workspace walk leaking)
 * from a diagnostic bundle after the fact.
 *
 * Two independent loops: `app.getAppMetrics()` (Electron's own children) and a
 * process-tree walk (everything else, which is where the spawned Node children hide).
 * They have separate cadences because the tree walk is far more expensive.
 */
export function installProcessMetricsLogging(
  loggerService: {
    createLogger(channel: ILogChannel): ILogger
  },
  options: ProcessMetricsOptions = {},
): IDisposable {
  const logger = createNamedLogger(loggerService, {
    id: 'processMetrics',
    name: 'Process Metrics',
  })
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let treeTimer: ReturnType<typeof setTimeout> | undefined
  const sample = (): void => {
    let heapUsed = 0
    let rendererBusy = false
    try {
      const metrics = app.getAppMetrics()
      const line = metrics
        .map(
          (metric) =>
            `pid=${metric.pid} type=${metric.type} mem=${Math.round(metric.memory.workingSetSize / 1024)}MB cpu=${Math.round(metric.cpu.percentCPUUsage)}%`,
        )
        .join(' | ')
      logger.info(line)
      for (const metric of metrics) {
        if (metric.type !== 'Tab') continue
        // workingSetSize is reported in KB.
        const workingSetBytes = metric.memory.workingSetSize * 1024
        if (workingSetBytes <= TAB_WORKING_SET_WARN_BYTES) continue
        rendererBusy = true
        logger.warn(
          `pid=${metric.pid} type=Tab mem=${Math.round(workingSetBytes / 1024 / 1024)}MB — renderer working set above ${Math.round(TAB_WORKING_SET_WARN_BYTES / 1024 / 1024)}MB, OOM risk`,
        )
      }
      const mem = process.memoryUsage()
      heapUsed = mem.heapUsed
      const heapLine = formatMainHeapSample(mem)
      if (mem.heapUsed > MAIN_HEAP_WARN_BYTES) {
        logger.warn(
          `${heapLine} — main V8 heap above ${Math.round(MAIN_HEAP_WARN_BYTES / 1024 / 1024)}MB, OOM risk`,
        )
      } else {
        logger.info(heapLine)
      }
    } catch {
      // Metrics are best-effort diagnostics; never let sampling kill the main process.
    }
    // Self-rescheduling timeout (not setInterval): the next cycle's delay
    // depends on THIS sample's heap, and the first sample runs synchronously
    // at install so a fast crash still leaves at least one data point.
    if (!disposed) {
      timer = setTimeout(sample, processMetricsIntervalMs(heapUsed, rendererBusy))
      timer.unref()
    }
  }
  sample()

  const sampleTree = async (): Promise<void> => {
    let heavy = false
    try {
      const root = await options.listProcessTree?.()
      if (root) {
        const items = flattenProcessTree(root)
        const line = `hosted-processes cnt=${items.length} ${formatProcessTreeMemory(items)}`
        // The main process has its own heap line above; counting its RSS as a runaway
        // hosted child would fire the warning on every healthy launch.
        const over = items.filter(
          (item) => item.pid !== process.pid && item.mem > HOSTED_PROCESS_WARN_BYTES,
        )
        if (over.length > 0) {
          heavy = true
          logger.warn(
            `${line} — above ${Math.round(HOSTED_PROCESS_WARN_BYTES / 1024 / 1024)}MB: ${over.map((item) => `${item.name}#${item.pid}`).join(', ')}`,
          )
        } else {
          logger.info(line)
        }
      }
    } catch {
      // Best-effort, and the walk spawns a native helper / `ps` — a failure here must
      // never take down the process it is trying to observe.
    }
    if (!disposed) {
      treeTimer = setTimeout(
        () => void sampleTree(),
        heavy ? PROCESS_TREE_BUSY_INTERVAL_MS : PROCESS_TREE_NORMAL_INTERVAL_MS,
      )
      treeTimer.unref()
    }
  }
  if (options.listProcessTree) void sampleTree()

  return toDisposable(() => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    if (treeTimer !== undefined) clearTimeout(treeTimer)
  })
}
