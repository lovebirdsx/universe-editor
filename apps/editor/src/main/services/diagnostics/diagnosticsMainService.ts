/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Diagnostics facade: hands the previous session's abnormal-exit report to the
 *  first renderer that asks (consume-once, so only one window notifies), reveals
 *  the crashpad dump directory, and powers the Report Issue flow — markdown
 *  summary + diagnostics zip (sysinfo, recent errors.jsonl, session log tails,
 *  crash-dump listing).
 *--------------------------------------------------------------------------------------------*/

import AdmZip from 'adm-zip'
import { app, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { cpus, freemem, release as osRelease, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { getAppVersion } from '../../appVersion.js'
import {
  Disposable,
  Emitter,
  Event,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type {
  AbnormalExitInfo,
  HeapSnapshotEvent,
  HeapSnapshotStatus,
  IDiagnosticsService,
  WireHeapCount,
  WireHeapFlow,
  WireHeapGauge,
  WireHeapHolder,
  WireRendererHeapSample,
} from '../../../shared/ipc/services.js'
import type { AbnormalExitReport } from '../../sessionSentinel.js'
import { SESSION_DIR_RE } from '../log/logMainService.js'
import { collectSessionLogTails } from '../log/logTails.js'
import { HEAP_SNAPSHOT_THRESHOLDS } from './heapSnapshotPolicy.js'
import type { HeapSnapshotController, HeapSnapshotWindowHost } from './heapSnapshotController.js'
import {
  aggregateErrorFingerprints,
  buildIssueMarkdown,
  type DiagnosticsExtensionEntry,
  type DiagnosticsSystemInfo,
} from './diagnosticsReport.js'

export interface DiagnosticsMainServiceOptions {
  /** <userData>/Crashes (crashpad dump root). */
  readonly crashDumpsDir: string
  /** <userData>/logs — session dirs live directly under it. */
  readonly logRoot: string
  /** Output dir for diagnostics zips (<userData>/diagnostics). */
  readonly diagnosticsDir: string
  /** dev | release | e2e */
  readonly mode: string
  /** Extension listing for the report; injected so tests stay electron-light. */
  readonly listExtensions?: () => Promise<DiagnosticsExtensionEntry[]>
  /** Process tree snapshot for the zip; injected so tests stay electron-light. */
  readonly collectProcesses?: () => Promise<string>
  /**
   * Main-side IPC frame ring (recent frames + the largest ever seen). Synchronous on
   * purpose: the case it exists for is a renderer that died mid-frame, and a renderer
   * cannot report what it was decoding when it ran out of memory — this side can.
   */
  readonly readIpcFrames?: () => string
  /**
   * Memory snapshot beyond what `app.getAppMetrics()` can see: the main V8 heap, and
   * the spawned Node children (extension host, ACP agents) that are absent from the app
   * metrics entirely.
   */
  readonly collectMemory?: () => Promise<string>
  /**
   * Whether exports reveal themselves via shell.showItemInFolder. Disabled in
   * E2E: popping an Explorer/Finder window mid-test serves no one.
   */
  readonly revealInShell?: boolean
  /** How many of the newest dumps get packed into the zip; injected so tests stay small. */
  readonly crashDumpMaxFiles?: number
  /** Per-dump size cap in bytes; larger dumps are listed but not packed. */
  readonly crashDumpMaxBytes?: number
}

/** How many recent log sessions feed the report and the zip. */
const REPORT_SESSION_COUNT = 2
/** Per-file tail cap for logs packed into the zip. */
const LOG_TAIL_BYTES = 512 * 1024
/** Minidumps are a few MB; anything past this is abnormal and bloats the zip. */
const CRASH_DUMP_MAX_FILES = 2
const CRASH_DUMP_MAX_BYTES = 64 * 1024 * 1024
/**
 * Renderer heap samples kept for the zip. At the normal 30s cadence that is 16 minutes;
 * once the watermark crosses a line the renderer tightens to 5s and the same 32 slots
 * become a 160-second close-up of the ramp, which is the window a crash is read for.
 */
const RENDERER_HEAP_RING = 32
/**
 * Holder names are renderer-supplied strings that end up on a log line. The cap sits
 * above every name the renderer ships today (`acp`, `monaco`) with room to spare: a name
 * rejected here disappears from the breakdown silently, and the breakdown is the whole
 * point of the field.
 */
const HOLDER_NAME_RE = /^[a-z][a-z0-9_.-]{0,31}$/i
const HOLDER_MAX_ENTRIES = 8
/** Flow and gauge are one list each rather than a breakdown, so they get a bit more room. */
const WIRE_LIST_MAX_ENTRIES = 12
/** Scan cap, so an array of junk names cannot cost one regex per entry. */
const HOLDER_MAX_SCAN = 64

function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

export interface RendererHeapRecord {
  readonly window: number
  readonly used: number
  readonly limit: number
  readonly level: string
  readonly holders: readonly WireHeapHolder[]
  /** Work counted since the previous sample, already drained on the renderer side. */
  readonly flow?: readonly WireHeapFlow[]
  /** Absolute proxies for memory the V8 heap reading cannot see. */
  readonly gauge?: readonly WireHeapGauge[]
  /** Populations the renderer knows exactly; a zero here is a reading, not silence. */
  readonly counts?: readonly WireHeapCount[]
  /**
   * renderer 自报的每次启动 id。不打印——它的用处是让快照控制器把「上一个 renderer 的迟到
   * 样本」和新鲜样本区分开。
   */
  readonly incarnation?: string
}

function formatHolders(holders: readonly WireHeapHolder[]): string {
  const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024)
  return holders
    .map((h) => `${h.name}:${mb(h.bytes)}MB${h.count === undefined ? '' : `(${h.count})`}`)
    .join(',')
}

function formatFlow(flow: readonly WireHeapFlow[]): string {
  return flow.map((f) => `${f.name}:${f.calls}c/${Math.round(f.chars / 1024 / 1024)}MB`).join(',')
}

function formatGauge(gauge: readonly WireHeapGauge[]): string {
  return gauge.map((g) => `${g.name}:${g.value}`).join(',')
}

function formatCounts(counts: readonly WireHeapCount[]): string {
  return counts.map((c) => `${c.name}:${c.value}`).join(',')
}

/**
 * What the reported holders do not account for, in MB — the number the 2026-09-18
 * package could not state ("2GB heap, 32MB of registered caches, nothing in between").
 *
 * Deliberately named `unexplained`: the holder estimates cover a subset of what lives
 * in the JS heap (the V8 internals, Monaco's own objects and everything unmeasured sit
 * on the other side), so the difference is "not explained by the current estimates" and
 * nothing more. It is not a leak, not a lost allocation, and not a defect count.
 *
 * Omitted when no holder was reported at all: there the whole reading is unexplained by
 * construction, and the absence of the `holders=` segment already says so.
 */
function unexplainedMB(record: RendererHeapRecord): number | undefined {
  if (record.holders.length === 0) return undefined
  let accounted = 0
  for (const holder of record.holders) accounted += holder.bytes
  return Math.max(0, Math.round((record.used - accounted) / 1024 / 1024))
}

export function formatRendererHeapSample(record: RendererHeapRecord): string {
  const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024)
  const pct = record.limit > 0 ? ` usedPct=${((record.used / record.limit) * 100).toFixed(1)}` : ''
  const holders = record.holders.length > 0 ? ` holders=${formatHolders(record.holders)}` : ''
  const unexplained = unexplainedMB(record)
  const unexplainedField = unexplained === undefined ? '' : ` unexplained=${unexplained}MB`
  const flow = record.flow && record.flow.length > 0 ? ` flow=${formatFlow(record.flow)}` : ''
  const gauge = record.gauge && record.gauge.length > 0 ? ` gauge=${formatGauge(record.gauge)}` : ''
  const counts =
    record.counts && record.counts.length > 0 ? ` counts=${formatCounts(record.counts)}` : ''
  return (
    `renderer-heap window=${record.window} used=${mb(record.used)}MB ` +
    `limit=${mb(record.limit)}MB${pct} level=${record.level}${holders}${unexplainedField}${flow}${gauge}${counts}`
  )
}

/**
 * The flow and gauge lists get the holders treatment: renderer-supplied names that end
 * up on a log line, and numbers that either held when sent or are not evidence. Sampling
 * cap first, so a junk array cannot cost one regex per entry.
 */
function scanWireList<T>(
  raw: unknown,
  build: (entry: Record<string, unknown>) => T | undefined,
): T[] {
  const out: T[] = []
  const candidates = Array.isArray(raw) ? (raw as readonly unknown[]) : []
  const scanLimit = Math.min(candidates.length, HOLDER_MAX_SCAN)
  for (let i = 0; i < scanLimit; i++) {
    if (out.length >= WIRE_LIST_MAX_ENTRIES) break
    const entry = candidates[i]
    if (!entry || typeof entry !== 'object') continue
    const built = build(entry as Record<string, unknown>)
    if (built !== undefined) out.push(built)
  }
  return out
}

function wireName(entry: Record<string, unknown>): string | undefined {
  const name = entry['name']
  return typeof name === 'string' && HOLDER_NAME_RE.test(name) ? name : undefined
}

function wireAmount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function wireCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Everything on this path is renderer-supplied and ends up on a log line. Drop what
 * cannot be true rather than clamping it: a sample that needed correcting is not
 * evidence, and a holder name carrying a newline would forge log lines.
 */
function sanitizeHeapSample(
  sample: WireRendererHeapSample | undefined,
  windowId: number,
): RendererHeapRecord | undefined {
  if (!sample || typeof sample !== 'object') return undefined
  if (!Number.isFinite(sample.used) || sample.used <= 0) return undefined
  const limit = Number.isFinite(sample.limit) && sample.limit > 0 ? sample.limit : 0
  const level =
    typeof sample.level === 'string' && /^[a-z]{1,12}$/.test(sample.level)
      ? sample.level
      : 'unknown'
  const holders: WireHeapHolder[] = []
  // A payload that lost its `holders` field must not take the heap reading down with
  // it: iterating `undefined` throws, and the throw is swallowed on the far side of
  // IPC, so the sample would vanish without leaving a trace of any kind.
  const candidates = Array.isArray(sample.holders) ? sample.holders : []
  const scanLimit = Math.min(candidates.length, HOLDER_MAX_SCAN)
  for (let i = 0; i < scanLimit; i++) {
    if (holders.length >= HOLDER_MAX_ENTRIES) break
    const holder = candidates[i]
    if (!holder || typeof holder.name !== 'string' || !HOLDER_NAME_RE.test(holder.name)) continue
    if (!Number.isFinite(holder.bytes) || holder.bytes < 0) continue
    const count =
      typeof holder.count === 'number' && Number.isFinite(holder.count) && holder.count >= 0
        ? holder.count
        : undefined
    holders.push({
      name: holder.name,
      bytes: holder.bytes,
      ...(count === undefined ? {} : { count }),
    })
  }
  const flow = scanWireList<WireHeapFlow>(sample.flow, (entry) => {
    const name = wireName(entry)
    const calls = wireCount(entry['calls'])
    const chars = wireAmount(entry['chars'])
    return name === undefined || calls === undefined || chars === undefined
      ? undefined
      : { name, calls, chars }
  })
  const gauge = scanWireList<WireHeapGauge>(sample.gauge, (entry) => {
    const name = wireName(entry)
    const value = wireAmount(entry['value'])
    return name === undefined || value === undefined ? undefined : { name, value }
  })
  // `wireCount` (not `wireAmount`): a population is a non-negative integer, and 0 is
  // accepted here — unlike a gauge, "no session is live" is a reading worth keeping.
  const counts = scanWireList<WireHeapCount>(sample.counts, (entry) => {
    const name = wireName(entry)
    const value = wireCount(entry['value'])
    return name === undefined || value === undefined ? undefined : { name, value }
  })
  const incarnation =
    typeof sample.incarnation === 'string' && /^[a-z0-9-]{1,40}$/i.test(sample.incarnation)
      ? sample.incarnation
      : undefined
  return {
    window: windowId,
    used: sample.used,
    limit,
    level,
    holders,
    ...(flow.length === 0 ? {} : { flow }),
    ...(gauge.length === 0 ? {} : { gauge }),
    ...(counts.length === 0 ? {} : { counts }),
    ...(incarnation === undefined ? {} : { incarnation }),
  }
}

/** 快照已接线但没武装任何轮次时，窗口看到的状态。 */
function offStatus(): HeapSnapshotStatus {
  return {
    active: false,
    phase: 'off',
    attempts: 0,
    attemptLimit: HEAP_SNAPSHOT_THRESHOLDS.maxAttemptsPerRound,
    appAttempts: 0,
    appAttemptLimit: HEAP_SNAPSHOT_THRESHOLDS.maxAttemptsPerApp,
    artifacts: 0,
    bytes: 0,
  }
}

/** Binds the renderer-facing surface to one window, so the stamped id cannot be forged. */
export function createWindowScopedDiagnostics(
  diagnostics: DiagnosticsMainService,
  windowId: number,
): IDiagnosticsService {
  return {
    _serviceBrand: undefined,
    consumeAbnormalExitReport: () => diagnostics.consumeAbnormalExitReport(),
    revealCrashesFolder: () => diagnostics.revealCrashesFolder(),
    collectIssueReport: () => diagnostics.collectIssueReport(),
    exportDiagnosticsZip: () => diagnostics.exportDiagnosticsZip(),
    createDiagnosticsZip: () => diagnostics.createDiagnosticsZip(),
    reportRendererHeapSample: (sample) => diagnostics.reportRendererHeapSample(sample, windowId),
    startHeapSnapshotRound: () => diagnostics.startHeapSnapshotRound(windowId),
    stopHeapSnapshotRound: () => diagnostics.stopHeapSnapshotRound(windowId),
    getHeapSnapshotStatus: () => diagnostics.getHeapSnapshotStatus(windowId),
    revealHeapSnapshotsFolder: () => diagnostics.revealHeapSnapshotsFolder(),
    // 在这里按 main 自己的窗口 id 过滤：无论载荷怎么构造，A 窗口的轮次报告都不会在
    // B 窗口弹出通知。
    onDidChangeHeapSnapshot: Event.filter(
      diagnostics.onDidChangeHeapSnapshot,
      (event) => event.windowId === windowId,
    ),
  }
}

export class DiagnosticsMainService extends Disposable implements IDiagnosticsService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  /**
   * Same channel id `installProcessMetricsLogging` uses, so the renderer's curve lands in
   * `processMetrics.log` between the main-heap and process-tree lines instead of in a
   * file of its own that nobody would think to open.
   */
  private readonly _metricsLogger: ILogger
  private _pendingAbnormalExit: AbnormalExitInfo | null = null

  /**
   * Absent until main-services wires one (and in the zip/notification-only tests).
   * Everything the facade exposes degrades to "off" without it rather than throwing:
   * a diagnostics build that cannot snapshot must still be able to report.
   */
  private _heapSnapshots: HeapSnapshotController | undefined

  private readonly _onDidChangeHeapSnapshot = new Emitter<HeapSnapshotEvent>()
  /** One stream for the whole app; each window's wrapper filters it by window id. */
  readonly onDidChangeHeapSnapshot: Event<HeapSnapshotEvent> = this._onDidChangeHeapSnapshot.event

  // Preallocated so recording never allocates: the samples arrive over IPC and the
  // interesting ones arrive while the sender is already out of heap.
  private readonly _heapRing: { at: number; line: string }[] = []
  private _heapCursor = 0
  private _heapFilled = 0
  private _heapDropped = 0

  constructor(
    private readonly _options: DiagnosticsMainServiceOptions,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'diagnostics', name: 'Diagnostics' })
    this._metricsLogger = createNamedLogger(loggerService, {
      id: 'processMetrics',
      name: 'Process Metrics',
    })
    for (let i = 0; i < RENDERER_HEAP_RING; i++) this._heapRing.push({ at: 0, line: '' })
  }

  /**
   * Record one renderer heap reading. The renderer is the only observer of its own V8
   * heap, so a sample that never leaves it dies with the process that needed explaining —
   * this is the hop that makes the growth curve outlive the crash.
   *
   * `windowId` is stamped by the per-window wrapper; `0` marks a call that did not come
   * through a window.
   */
  reportRendererHeapSample(sample: WireRendererHeapSample, windowId = 0): Promise<void> {
    const record = sanitizeHeapSample(sample, windowId)
    // A renderer that cannot read its own heap must look absent, not empty: a zeroed
    // sample would read as "the heap was fine" on exactly the report where it was not.
    // Counted rather than logged — a broken sender repeats every 30 seconds, and the
    // count is what tells a rejected report apart from a build that never had one.
    if (!record) {
      this._heapDropped++
      return Promise.resolve()
    }
    const line = formatRendererHeapSample(record)
    this._metricsLogger.info(line)
    const slot = this._heapRing[this._heapCursor]
    if (slot) {
      slot.at = Date.now()
      slot.line = line
    }
    this._heapCursor = (this._heapCursor + 1) % RENDERER_HEAP_RING
    if (this._heapFilled < RENDERER_HEAP_RING) this._heapFilled++
    this._feedHeapSnapshots(record)
    return Promise.resolve()
  }

  /**
   * 把*已消毒*的读数交给快照控制器。控制器按自己的钟重新判断，这里绝不等它：堆样本的 IPC
   * 回复不能被一次可能冻结窗口几十秒的抓取卡在后面。
   */
  private _feedHeapSnapshots(record: RendererHeapRecord): void {
    const controller = this._heapSnapshots
    if (controller === undefined) return
    let holdersBytes = 0
    for (const holder of record.holders) holdersBytes += holder.bytes
    try {
      controller.reportSample({
        windowId: record.window,
        at: Date.now(),
        used: record.used,
        limit: record.limit,
        holdersBytes,
        ...(record.incarnation === undefined ? {} : { incarnation: record.incarnation }),
      })
    } catch (err) {
      this._logger.warn(
        `heap snapshot sample rejected: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 接上跨窗口的快照控制器。它在 main-services 里构造（那边管快照目录和共享采样器），在这里
   * 挂上是因为控制器要经本服务的事件流上报。
   */
  attachHeapSnapshotController(controller: HeapSnapshotController): void {
    this._heapSnapshots = controller
  }

  /** 控制器每报告一次就调用；再由 emitter 按窗口分发出去。 */
  publishHeapSnapshotEvent(event: HeapSnapshotEvent): void {
    this._onDidChangeHeapSnapshot.fire(event)
  }

  /** Late-bound by main/index.ts, exactly like the bug recorder's window provider. */
  setHeapSnapshotWindowHost(host: HeapSnapshotWindowHost): void {
    this._heapSnapshots?.setWindowHost(host)
  }

  /** Reload / close: the round measured a renderer that is gone, so it ends with it. */
  invalidateWindowRenderer(windowId: number, reason: 'window-reloaded' | 'window-closed'): void {
    this._heapSnapshots?.invalidateWindow(windowId, reason)
  }

  /**
   * 为一个窗口武装一轮。额度按轮和按应用运行各算一份：已武装时再调用是空操作，第二次点击
   * 不会白送一对新的尝试机会。
   *
   * `windowId` 默认 0 =「没有窗口」，与 `reportRendererHeapSample` 一致：不是从按窗口包装的
   * 通道进来的调用报不出窗口，而窗口 0 解析不到活 renderer，所以结果是被拒绝，而不是抓错堆。
   */
  startHeapSnapshotRound(windowId = 0): Promise<HeapSnapshotStatus> {
    return Promise.resolve(this._heapSnapshots?.start(windowId) ?? offStatus())
  }

  stopHeapSnapshotRound(windowId = 0): Promise<HeapSnapshotStatus> {
    return Promise.resolve(this._heapSnapshots?.stop(windowId) ?? offStatus())
  }

  getHeapSnapshotStatus(windowId = 0): Promise<HeapSnapshotStatus> {
    return Promise.resolve(this._heapSnapshots?.status(windowId) ?? offStatus())
  }

  /**
   * 打开快照目录，需要时先创建。系统拒绝打开时抛错：用户是显式点了这个动作的，静默无响应会
   * 让人以为快照丢了。
   */
  async revealHeapSnapshotsFolder(): Promise<void> {
    const dir = this._heapSnapshots?.directory
    if (dir === undefined) return
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (err) {
      throw new Error(
        `cannot create the snapshot directory: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (this._options.revealInShell === false) return
    const failure = await shell.openPath(dir)
    if (failure) throw new Error(failure)
  }

  override dispose(): void {
    this._onDidChangeHeapSnapshot.dispose()
    this._heapSnapshots?.dispose()
    this._heapSnapshots = undefined
    super.dispose()
  }

  /** Called by the bootstrap once the sentinel has been read (before any window asks). */
  setAbnormalExitReport(report: AbnormalExitReport | undefined): void {
    this._pendingAbnormalExit = report ?? null
  }

  consumeAbnormalExitReport(): Promise<AbnormalExitInfo | null> {
    const report = this._pendingAbnormalExit
    this._pendingAbnormalExit = null
    return Promise.resolve(report)
  }

  async revealCrashesFolder(): Promise<void> {
    if (this._options.revealInShell === false) return
    const dumps = await this._listCrashDumps()
    const newest = dumps[0]
    if (newest !== undefined) {
      this._logger.info(`reveal crash dump ${newest.path}`)
      shell.showItemInFolder(newest.path)
      return
    }
    const err = await shell.openPath(this._options.crashDumpsDir)
    if (err) this._logger.warn(`openPath crashedumps failed: ${err}`)
  }

  async collectIssueReport(): Promise<string> {
    const info = this._collectSystemInfo()
    const extensions = (await this._options.listExtensions?.().catch(() => [])) ?? []
    const errorTop = aggregateErrorFingerprints(await this._readRecentErrorsJsonl())
    return buildIssueMarkdown(info, extensions, errorTop)
  }

  async exportDiagnosticsZip(): Promise<string> {
    const zipPath = await this.createDiagnosticsZip()
    if (this._options.revealInShell !== false) {
      shell.showItemInFolder(zipPath)
    }
    return zipPath
  }

  async createDiagnosticsZip(): Promise<string> {
    const zip = new AdmZip()
    const markdown = await this.collectIssueReport()
    zip.addFile('sysinfo.md', Buffer.from(markdown, 'utf8'))

    const sessions = await this._recentSessionDirs()
    for (const session of sessions) {
      const dir = join(this._options.logRoot, session)
      const errors = await this._readFileIfExists(join(dir, 'errors.jsonl'))
      if (errors !== null) {
        zip.addFile(`errors-${session}.jsonl`, errors)
      }
      for (const logFile of await collectSessionLogTails(dir, LOG_TAIL_BYTES)) {
        zip.addFile(`logs/${session}/${logFile.name}`, logFile.content)
      }
    }

    const dumps = await this._listCrashDumps()
    const dumpStatus = await this._packCrashDumps(zip, dumps)
    const dumpListing = dumps.length
      ? dumps
          .map(
            (d) => `${new Date(d.mtime).toISOString()}  ${d.path}${dumpStatus.get(d.path) ?? ''}`,
          )
          .join('\n') + '\n'
      : '(no crash dumps)\n'
    zip.addFile('crash-dumps.txt', Buffer.from(dumpListing, 'utf8'))

    const processList = await this._options.collectProcesses?.().catch(() => undefined)
    zip.addFile('processes.txt', Buffer.from(processList ?? '(process list unavailable)\n', 'utf8'))

    const memory = await this._options.collectMemory?.().catch(() => undefined)
    const heap = this._formatRendererHeap()
    zip.addFile(
      'memory.txt',
      Buffer.from(`${memory ?? '(memory snapshot unavailable)\n'}${heap}`, 'utf8'),
    )

    const frames = this._options.readIpcFrames?.()
    zip.addFile('ipc-frames.txt', Buffer.from(frames ?? '(ipc frame record unavailable)\n', 'utf8'))

    // 快照是几百 MB 的原始堆，里面装着当时堆上的各种字符串。zip 要发去问题跟踪系统，
    // 所以只列清单，永不打包内容。
    const manifest = await this._heapSnapshots?.formatManifest().catch(() => undefined)
    zip.addFile('heap-snapshots.txt', Buffer.from(manifest ?? '(no heap snapshots)\n', 'utf8'))

    await fs.mkdir(this._options.diagnosticsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const zipPath = join(this._options.diagnosticsDir, `universe-diagnostics-${stamp}.zip`)
    await zip.writeZipPromise(zipPath)
    this._logger.info(`diagnostics zip written: ${zipPath}`)
    return zipPath
  }

  private _collectSystemInfo(): DiagnosticsSystemInfo {
    const cpuList = cpus()
    const firstCpu = cpuList[0]
    const cpuDesc = firstCpu
      ? `${firstCpu.model.trim()} (${cpuList.length} × ${(firstCpu.speed / 1000).toFixed(1)}GHz)`
      : 'unknown'
    const osName =
      process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
    return {
      appVersion: getAppVersion(),
      electron: process.versions.electron ?? 'unknown',
      chromium: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      os: `${osName} ${osRelease()} (${process.arch})`,
      cpus: cpuDesc,
      memory: `${formatGB(totalmem())} (free ${formatGB(freemem())})`,
      mode: this._options.mode,
      locale: app.getLocale(),
    }
  }

  /** errors.jsonl content of the most recent sessions, concatenated. */
  private async _readRecentErrorsJsonl(): Promise<string> {
    const sessions = await this._recentSessionDirs()
    const chunks: string[] = []
    for (const session of sessions) {
      const buf = await this._readFileIfExists(join(this._options.logRoot, session, 'errors.jsonl'))
      if (buf !== null) chunks.push(buf.toString('utf8'))
    }
    return chunks.join('\n')
  }

  /** Session directory names, newest first (name is a sortable timestamp). */
  private async _recentSessionDirs(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this._options.logRoot)
    } catch {
      return []
    }
    return entries
      .filter((name) => SESSION_DIR_RE.test(name))
      .sort()
      .reverse()
      .slice(0, REPORT_SESSION_COUNT)
  }

  /**
   * Packs the newest dump files (up to the configured cap) into `crashes/`;
   * returns per-path status suffixes for the crash-dumps.txt listing.
   * Oversized dumps are listed but skipped; unreadable ones are skipped silently.
   */
  private async _packCrashDumps(
    zip: AdmZip,
    dumps: { path: string; mtime: number }[],
  ): Promise<Map<string, string>> {
    const status = new Map<string, string>()
    const maxFiles = this._options.crashDumpMaxFiles ?? CRASH_DUMP_MAX_FILES
    const maxBytes = this._options.crashDumpMaxBytes ?? CRASH_DUMP_MAX_BYTES
    let packed = 0
    for (const dump of dumps) {
      if (packed >= maxFiles) break
      const stat = await fs.stat(dump.path).catch(() => null)
      if (!stat) {
        this._logger.warn(`crash dump vanished, skipped: ${dump.path}`)
        continue
      }
      if (stat.size > maxBytes) {
        status.set(dump.path, ' (skipped: too large)')
        continue
      }
      const buf = await this._readFileIfExists(dump.path)
      if (buf === null) {
        this._logger.warn(`crash dump unreadable, skipped: ${dump.path}`)
        continue
      }
      zip.addFile(`crashes/${basename(dump.path)}`, buf)
      status.set(dump.path, ' (included)')
      packed++
    }
    return status
  }

  private async _listCrashDumps(): Promise<{ path: string; mtime: number }[]> {
    const found: { path: string; mtime: number }[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth < 0) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth - 1)
        } else if (entry.name.toLowerCase().endsWith('.dmp')) {
          const stat = await fs.stat(full).catch(() => null)
          if (stat) found.push({ path: full, mtime: stat.mtimeMs })
        }
      }
    }
    await walk(this._options.crashDumpsDir, 3)
    found.sort((a, b) => b.mtime - a.mtime)
    return found
  }

  private _readFileIfExists(path: string): Promise<Buffer | null> {
    return fs.readFile(path).catch(() => null)
  }

  /**
   * Newest-first tail for `memory.txt`. Carried in the zip rather than left to be grepped
   * out of the log file, whose per-file tail is capped at 512KiB and would drop exactly
   * the oldest samples of a slow ramp.
   *
   * `dropped` is the other half of the answer: without it "no renderer ever reported" and
   * "every report was rejected" produce the same file, and they are opposite conclusions.
   */
  private _formatRendererHeap(): string {
    const dropped = this._heapDropped > 0 ? ` dropped=${this._heapDropped}` : ''
    if (this._heapFilled === 0) return `renderer-heap no samples recorded${dropped}\n`
    const start = this._heapFilled < RENDERER_HEAP_RING ? 0 : this._heapCursor
    const lines = [`renderer-heap samples=${this._heapFilled}${dropped} (newest first)`]
    for (let i = this._heapFilled - 1; i >= 0; i--) {
      const slot = this._heapRing[(start + i) % RENDERER_HEAP_RING]
      if (slot) lines.push(`  ${new Date(slot.at).toISOString()} ${slot.line}`)
    }
    return `${lines.join('\n')}\n`
  }
}
