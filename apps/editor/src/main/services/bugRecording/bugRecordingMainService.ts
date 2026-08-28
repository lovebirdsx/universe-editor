/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for bug recording. Renderer windows push structured
 *  events here; this service appends them as JSONL under the current log session
 *  dir (so the 20-session cleanup reclaims them for free), captures screenshots
 *  of the focused window at key steps, and on stop hands everything to the
 *  archive builder. A recording left behind by a crash is detected on the next
 *  launch and offered for export.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createNamedLogger,
  Disposable,
  Emitter,
  type ILogger,
  ILoggerService,
} from '@universe-editor/platform'
import type {
  BugRecordEvent,
  BugRecordingOrphanInfo,
  BugRecordingResult,
  BugRecordingStartMeta,
  BugRecordingStatus,
  BugRecordingStopOptions,
  BugScreenshotReason,
  IBugRecorderService,
  PersistedBugRecordEvent,
} from '../../../shared/ipc/bugRecorderService.js'
import { ILogMainService, type LogMainService } from '../log/logMainService.js'
import {
  buildBugRecordingArchive,
  EVENTS_FILE,
  META_FILE,
  SCREENSHOTS_DIR,
  type BugRecordingMeta,
} from './bugRecordingArchive.js'

/** Minimal shape of what we need from a BrowserWindow, so tests stay electron-free. */
export interface BugRecordingCaptureTarget {
  readonly webContents: {
    capturePage(): Promise<{
      getSize(): { width: number; height: number }
      resize(options: { width: number }): { toJPEG(quality: number): Buffer }
      toJPEG(quality: number): Buffer
    }>
  }
}

export interface BugRecordingMainServiceOptions {
  /** Output dir for evidence zips (<userData>/bug-recordings). */
  readonly recordingsDir: string
  /** Absolute paths masked when the user opts into redaction. */
  readonly piiPaths: readonly string[]
  /** Whether exports reveal themselves in the file manager. Disabled in E2E. */
  readonly revealInShell?: boolean
  readonly revealItem?: (path: string) => void
  /** Environment markdown for the bundle; injected so tests stay electron-light. */
  readonly collectEnvironment?: () => Promise<string>
  readonly crashDumpsDir?: string
  readonly maxScreenshots?: number
  readonly minScreenshotIntervalMs?: number
  readonly screenshotWidth?: number
  readonly screenshotQuality?: number
  /** How long stop waits for in-flight captures before abandoning them. */
  readonly settleCapturesTimeoutMs?: number
}

const RECORDING_DIR_PREFIX = 'bug-recording-'
const DEFAULT_MAX_SCREENSHOTS = 25
const DEFAULT_MIN_SCREENSHOT_INTERVAL_MS = 1500
const DEFAULT_SCREENSHOT_WIDTH = 1600
const DEFAULT_SCREENSHOT_QUALITY = 80
const DEFAULT_SETTLE_CAPTURES_TIMEOUT_MS = 5000

const SCREENSHOT_TRIGGERS: Readonly<Record<string, BugScreenshotReason>> = {
  'acp.prompt_sent': 'agentPrompt',
}

/** A recording directory left behind by a crash, plus its summary. */
interface OrphanRecording {
  readonly info: BugRecordingOrphanInfo
  readonly dir: string
  readonly sessionDir: string
}

interface ActiveRecording {
  readonly dir: string
  readonly sessionDir: string
  readonly meta: BugRecordingMeta
  screenshotSeq: number
  screenshotCount: number
  lastScreenshotAt: number
  eventCount: number
  /**
   * Set once the raw directory is about to be packed (or its captures abandoned).
   * A capture that wakes up afterwards must not write into a bundle already being
   * zipped — but it must still run while the recording is merely being stopped,
   * which is why this is a separate flag rather than an `_active` identity check.
   */
  closed: boolean
}

export class BugRecordingMainService extends Disposable implements IBugRecorderService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private _active: ActiveRecording | null = null
  private _orphan: OrphanRecording | null = null
  private _orphanOffered = false
  private _windowProvider: () => BugRecordingCaptureTarget | undefined = () => undefined
  /**
   * Screenshots are fired without awaiting so they never delay an event, but
   * stop() must await them: a capture still in flight would otherwise write its
   * file (and evict older ones) after the zip was already built.
   */
  private readonly _pendingCaptures = new Set<Promise<void>>()
  /**
   * Serializes appends so stop() can await every in-flight write. AiDebugRecorder
   * fires-and-forgets because a dropped record is harmless there; here the last
   * events before a failure are exactly what the bundle exists to capture.
   */
  private _writeChain: Promise<void> = Promise.resolve()
  /** Serializes startRecording; see the comment on that method. */
  private _startChain: Promise<void> = Promise.resolve()
  /** Serializes captures; see the comment on _scheduleScreenshot. */
  private _captureChain: Promise<void> = Promise.resolve()
  /** Cached so concurrent first callers share one scan instead of racing it. */
  private _orphanScan: Promise<OrphanRecording | null> | undefined

  private readonly _onDidChangeStatus = this._register(new Emitter<BugRecordingStatus>())
  readonly onDidChangeStatus = this._onDidChangeStatus.event

  constructor(
    private readonly _options: BugRecordingMainServiceOptions,
    @ILogMainService private readonly _logMain: LogMainService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'bugRecording', name: 'Bug Recording' })
  }

  /** Late-bound: WindowMainService is constructed after the application services. */
  setWindowProvider(provider: () => BugRecordingCaptureTarget | undefined): void {
    this._windowProvider = provider
  }

  /**
   * Serialized because the checks-then-creates body has two awaits: two windows
   * calling start in the same frame would otherwise both pass the `_active` check
   * and leave one orphaned raw directory behind, which the next launch would
   * report as an interrupted recording the user never started.
   */
  startRecording(meta: BugRecordingStartMeta): Promise<BugRecordingStatus> {
    const pending = this._startChain.then(() => this._startRecording(meta))
    this._startChain = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  private async _startRecording(meta: BugRecordingStartMeta): Promise<BugRecordingStatus> {
    if (this._active) return this._currentStatus()

    const startedAt = Date.now()
    const sessionDir = this._logMain.getSessionDir()
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = join(sessionDir, `${RECORDING_DIR_PREFIX}${stamp}`)
    const recordingMeta: BugRecordingMeta = {
      startedAt,
      sessionId: this._logMain.getSessionId(),
      ...(meta.workspaceFolders !== undefined ? { workspaceFolders: meta.workspaceFolders } : {}),
    }

    await mkdir(join(dir, SCREENSHOTS_DIR), { recursive: true })
    await writeFile(join(dir, META_FILE), JSON.stringify(recordingMeta), 'utf8')

    this._active = {
      dir,
      sessionDir,
      meta: recordingMeta,
      screenshotSeq: 0,
      screenshotCount: 0,
      lastScreenshotAt: 0,
      eventCount: 0,
      closed: false,
    }
    this._logger.info(`recording started dir=${dir}`)
    this._scheduleScreenshot(this._active, 'start')

    const status = this._currentStatus()
    this._onDidChangeStatus.fire(status)
    return status
  }

  async recordEvents(events: readonly BugRecordEvent[]): Promise<void> {
    const active = this._active
    if (!active || events.length === 0) return

    const persisted = events.map(
      (event): PersistedBugRecordEvent => ({
        ...event,
        t: Math.max(0, event.ts - active.meta.startedAt),
      }),
    )
    active.eventCount += persisted.length
    this._appendEvents(active, persisted)

    for (const event of persisted) {
      const reason = screenshotReasonFor(event)
      if (reason !== undefined) this._scheduleScreenshot(active, reason)
    }
  }

  async markStep(): Promise<void> {
    const active = this._active
    if (!active) return
    await this.recordEvents([{ kind: 'marker', ts: Date.now() }])
  }

  async stopRecording(options: BugRecordingStopOptions): Promise<BugRecordingResult> {
    const active = this._active
    if (!active) throw new Error('no recording in progress')
    this._active = null

    let result: BugRecordingResult
    try {
      await this._settlePendingWork(active)
      result = await this._buildArchive(active.dir, active.sessionDir, active.meta, {
        endedAt: Date.now(),
        redact: options.redact,
        ...(options.transcripts !== undefined ? { transcripts: options.transcripts } : {}),
      })
    } catch (err) {
      // Packing failed (disk full, permissions) but the raw events are intact.
      // Resuming the recording keeps them reachable: the user can retry the stop
      // instead of having to relaunch and go through the crash-fallback prompt.
      active.closed = false
      this._active = active
      this._onDidChangeStatus.fire(this._currentStatus())
      throw err
    }
    await rm(active.dir, { recursive: true, force: true }).catch(() => undefined)

    this._onDidChangeStatus.fire(this._currentStatus())
    return result
  }

  getRecordingStatus(): Promise<BugRecordingStatus> {
    return Promise.resolve(this._currentStatus())
  }

  async consumeOrphanRecording(): Promise<BugRecordingOrphanInfo | null> {
    this._orphanScan ??= this._findOrphan().then((found) => {
      this._orphan = found
      return found
    })
    await this._orphanScan
    const orphan = this._orphan
    if (orphan === null || this._orphanOffered) return null
    // Consume-once: only the first window that asks gets the prompt, so two
    // windows can't both offer to export the same recording (the second export
    // would fail — the first one already deleted the raw directory).
    this._orphanOffered = true
    return orphan.info
  }

  async exportOrphanRecording(options: BugRecordingStopOptions): Promise<BugRecordingResult> {
    const orphan = this._orphan
    if (orphan === null) throw new Error('no interrupted recording available')
    this._orphan = null

    const meta = await this._readMeta(orphan.dir)
    const result = await this._buildArchive(orphan.dir, orphan.sessionDir, meta, {
      endedAt: await this._lastWriteTime(orphan.dir, meta.startedAt),
      redact: options.redact,
      interrupted: true,
      ...(options.transcripts !== undefined ? { transcripts: options.transcripts } : {}),
    })
    await rm(orphan.dir, { recursive: true, force: true }).catch(() => undefined)
    return result
  }

  private _currentStatus(): BugRecordingStatus {
    const active = this._active
    if (!active) return { state: 'idle' }
    return { state: 'recording', startedAt: active.meta.startedAt }
  }

  private _appendEvents(active: ActiveRecording, events: readonly PersistedBugRecordEvent[]): void {
    const payload = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    this._writeChain = this._writeChain.then(async () => {
      try {
        await appendFile(join(active.dir, EVENTS_FILE), payload, 'utf8')
      } catch (err) {
        this._logger.warn(`append events failed: ${String(err)}`)
      }
    })
  }

  /**
   * Serialized through one chain: overlapping captures would interleave their
   * seq allocation and their eviction pass, producing out-of-order filenames and
   * a screenshotCount that double-counts the same deletion.
   *
   * The recording is captured here rather than re-read inside the capture: a
   * queued capture only runs after the ones ahead of it settle, by which time
   * stopRecording may already have cleared `_active` — reading it there would
   * silently drop every shot that was still queued when the user hit stop.
   */
  private _scheduleScreenshot(active: ActiveRecording, reason: BugScreenshotReason): void {
    const pending = this._captureChain.then(() => this._captureScreenshot(active, reason))
    this._captureChain = pending.then(
      () => undefined,
      () => undefined,
    )
    this._pendingCaptures.add(pending)
    void pending.finally(() => this._pendingCaptures.delete(pending))
  }

  /**
   * Bounded on purpose: a capturePage that never settles (a wedged GPU process)
   * must not hang the stop path forever — the bundle is worth more than the last
   * screenshot. Events are unbounded because the write chain only awaits local
   * appends.
   */
  private async _settlePendingWork(active: ActiveRecording): Promise<void> {
    const timeout = this._options.settleCapturesTimeoutMs ?? DEFAULT_SETTLE_CAPTURES_TIMEOUT_MS
    const deadline = Date.now() + timeout
    while (this._pendingCaptures.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        this._logger.warn(`abandoning ${this._pendingCaptures.size} in-flight screenshot(s)`)
        break
      }
      await Promise.race([
        Promise.all([...this._pendingCaptures]),
        new Promise((resolve) => setTimeout(resolve, remaining)),
      ])
    }
    // Whatever is still queued past the deadline keeps running, so close the
    // recording before packing: an abandoned capture that finishes mid-zip must
    // not add a file the archive already listed, nor evict one it is reading.
    active.closed = true
    this._pendingCaptures.clear()
    await this._writeChain
  }

  private async _captureScreenshot(
    active: ActiveRecording,
    reason: BugScreenshotReason,
  ): Promise<void> {
    if (active.closed) return

    const minInterval = this._options.minScreenshotIntervalMs ?? DEFAULT_MIN_SCREENSHOT_INTERVAL_MS
    const now = Date.now()
    // Skip the shot but keep the event — a throttled screenshot must not drop the step.
    if (active.lastScreenshotAt !== 0 && now - active.lastScreenshotAt < minInterval) return

    const target = this._windowProvider()
    if (target === undefined) return
    active.lastScreenshotAt = now

    try {
      const image = await target.webContents.capturePage()
      // The recording may have been closed while capturePage was in flight;
      // writing now would land the file after the zip was built.
      if (active.closed) return
      const width = this._options.screenshotWidth ?? DEFAULT_SCREENSHOT_WIDTH
      const quality = this._options.screenshotQuality ?? DEFAULT_SCREENSHOT_QUALITY
      const buffer =
        image.getSize().width > width
          ? image.resize({ width }).toJPEG(quality)
          : image.toJPEG(quality)

      active.screenshotSeq += 1
      const name = `${String(active.screenshotSeq).padStart(4, '0')}.jpg`
      await writeFile(join(active.dir, SCREENSHOTS_DIR, name), buffer)
      active.screenshotCount += 1
      await this._evictOldScreenshots(active)

      this._appendEvents(active, [
        {
          kind: 'screenshot',
          ts: now,
          t: Math.max(0, now - active.meta.startedAt),
          file: `${SCREENSHOTS_DIR}/${name}`,
          reason,
        },
      ])
    } catch (err) {
      this._logger.warn(`capture screenshot failed: ${String(err)}`)
    }
  }

  private async _evictOldScreenshots(active: ActiveRecording): Promise<void> {
    const max = this._options.maxScreenshots ?? DEFAULT_MAX_SCREENSHOTS
    if (active.screenshotCount <= max) return
    const dir = join(active.dir, SCREENSHOTS_DIR)
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.jpg'))
      .sort()
    for (const name of names.slice(0, Math.max(0, names.length - max))) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
      active.screenshotCount -= 1
    }
  }

  private async _buildArchive(
    rawDir: string,
    sessionDir: string,
    meta: BugRecordingMeta,
    options: {
      endedAt: number
      redact: boolean
      interrupted?: boolean
      transcripts?: BugRecordingStopOptions['transcripts']
    },
  ): Promise<BugRecordingResult> {
    const environment = await this._options.collectEnvironment?.().catch(() => undefined)
    const result = await buildBugRecordingArchive({
      rawDir,
      sessionDir,
      meta,
      outputDir: this._options.recordingsDir,
      endedAt: options.endedAt,
      redact: options.redact,
      piiPaths: this._options.piiPaths,
      ...(options.interrupted === true ? { interrupted: true } : {}),
      ...(options.transcripts !== undefined ? { transcripts: options.transcripts } : {}),
      ...(environment !== undefined ? { environment } : {}),
      ...(this._options.crashDumpsDir !== undefined
        ? { crashDumpsDir: this._options.crashDumpsDir }
        : {}),
    })

    this._logger.info(
      `evidence bundle written: ${result.zipPath} (${result.eventCount} events, ${result.screenshotCount} screenshots, ${result.zipSizeBytes} bytes)`,
    )
    if (this._options.revealInShell !== false) this._options.revealItem?.(result.zipPath)
    return result
  }

  /** A recording dir under any session that outlived its process. */
  private async _findOrphan(): Promise<OrphanRecording | null> {
    const logRoot = this._logMain.getLogRoot()
    const sessions = (await readdir(logRoot).catch(() => [] as string[])).sort().reverse()
    for (const session of sessions) {
      const sessionDir = join(logRoot, session)
      const entries = await readdir(sessionDir).catch(() => [] as string[])
      for (const entry of entries.sort().reverse()) {
        if (!entry.startsWith(RECORDING_DIR_PREFIX)) continue
        const dir = join(sessionDir, entry)
        const meta = await this._readMeta(dir).catch(() => null)
        if (meta === null) continue
        const events = await readFile(join(dir, EVENTS_FILE), 'utf8').catch(() => '')
        const screenshots = (
          await readdir(join(dir, SCREENSHOTS_DIR)).catch(() => [] as string[])
        ).filter((name) => name.endsWith('.jpg'))
        this._logger.info(`found interrupted recording: ${dir}`)
        return {
          dir,
          sessionDir,
          info: {
            startedAt: meta.startedAt,
            eventCount: events.split('\n').filter((line) => line.trim() !== '').length,
            screenshotCount: screenshots.length,
          },
        }
      }
    }
    return null
  }

  private async _readMeta(dir: string): Promise<BugRecordingMeta> {
    const raw = await readFile(join(dir, META_FILE), 'utf8')
    return JSON.parse(raw) as BugRecordingMeta
  }

  private async _lastWriteTime(dir: string, fallback: number): Promise<number> {
    const info = await stat(join(dir, EVENTS_FILE)).catch(() => null)
    return info?.mtimeMs ?? fallback
  }
}

function screenshotReasonFor(event: PersistedBugRecordEvent): BugScreenshotReason | undefined {
  switch (event.kind) {
    case 'commandError':
      return 'commandError'
    case 'notification':
      return event.severity === 'error' ? 'errorNotification' : undefined
    case 'marker':
      return 'marker'
    case 'telemetry':
      return SCREENSHOT_TRIGGERS[event.name]
    default:
      return undefined
  }
}
