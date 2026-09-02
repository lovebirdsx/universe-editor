/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process IFileClipboardService. Owns the cross-window file clipboard in
 *  main memory (the natural shared state — every window talks to the same main
 *  process) and mirrors it to the OS clipboard through an IOsClipboardBackend.
 *
 *  Ownership model: the state we commit carries the signature of what the
 *  backend wrote to the OS clipboard (the normalized clipboard content itself,
 *  not a separate invented format). Reads return the in-memory snapshot while
 *  we still own the OS clipboard; once a backend read yields a different
 *  signature, another application has overwritten the clipboard, and the stale
 *  state is dropped in favor of the OS content.
 *
 *  The grace window + in-flight guard on readResources skip the backend read
 *  right after our own write — reading the OS clipboard while our (spawned)
 *  write is still landing would race it and produce a false "ownership lost".
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Emitter, URI, createNamedLogger } from '@universe-editor/platform'
import {
  IFileService,
  ILoggerService,
  localRevealFsPath,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import {
  FILE_CLIPBOARD_CONFIRM_BYTES,
  FILE_CLIPBOARD_REFUSE_BYTES,
  FILE_CLIPBOARD_REFUSE_ENTRIES,
  type IFileClipboardResource,
  type IFileClipboardService,
  type IFileClipboardSnapshot,
  type IFileClipboardWriteCost,
} from '../../../shared/ipc/fileClipboardService.js'
import type { IOsClipboardBackend, IOsClipboardReadResult } from './osClipboardBackend.js'
import { ClipboardMaterializer, type MaterializeEntry } from './clipboardMaterialize.js'

/** Reads within this window after our own write skip the OS ownership check (see header). */
const OWNERSHIP_GRACE_MS = 5_000

const EMPTY_SNAPSHOT: IFileClipboardSnapshot = {
  resources: [],
  isCut: false,
  source: 'os',
}

/**
 * Global in-flight `stat` cap for {@link _measureTree}. Sized for remote-ssh
 * trees, where each stat is a round-trip IPC: 64 concurrent requests is enough
 * to keep the walk off the critical path, but small enough that a refused tree
 * cannot burst the remote queue before the early abort kicks in.
 */
export const MEASURE_CONCURRENCY = 64

/** Hard limits of the {@link _measureTree} walk; injectable so tests can drive the same path at small scale. */
export interface FileClipboardMeasureLimits {
  readonly refuseEntries: number
  readonly refuseBytes: number
}

const DEFAULT_MEASURE_LIMITS: FileClipboardMeasureLimits = {
  refuseEntries: FILE_CLIPBOARD_REFUSE_ENTRIES,
  refuseBytes: FILE_CLIPBOARD_REFUSE_BYTES,
}

/**
 * Counting semaphore bounding the in-flight `stat` calls across the whole
 * {@link _measureTree} walk (not per directory level), so a deep/bushy tree
 * cannot multiply the concurrency of a single batch by its nesting depth.
 */
class MeasureSemaphore {
  private _inFlight = 0
  private readonly _waiters: (() => void)[] = []

  constructor(private readonly _capacity: number) {}

  async acquire(): Promise<void> {
    if (this._inFlight < this._capacity) {
      this._inFlight++
      return
    }
    await new Promise<void>((resolve) => this._waiters.push(resolve))
  }

  release(): void {
    const next = this._waiters.shift()
    if (next) {
      // Hand the slot directly to the next waiter without dropping _inFlight.
      next()
    } else {
      this._inFlight--
    }
  }
}

interface ClipboardEntry {
  readonly uri: URI
  readonly isDirectory: boolean
}

interface ClipboardState {
  readonly entries: readonly ClipboardEntry[]
  readonly isCut: boolean
  /** Signature of the OS clipboard content we wrote; null when the write never reached the OS. */
  readonly osSignature: string | null
  readonly generation: number
  /** Last commit time — feeds the ownership grace window. */
  wroteAtMs: number
}

export class FileClipboardMainService extends Disposable implements IFileClipboardService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeClipboard = this._register(new Emitter<IFileClipboardSnapshot>())
  readonly onDidChangeClipboard: Event<IFileClipboardSnapshot> = this._onDidChangeClipboard.event

  private readonly _logger: ILogger
  private readonly _materializer: ClipboardMaterializer
  private readonly _limits: FileClipboardMeasureLimits
  private _state: ClipboardState | null = null
  private _generation = 0
  private readonly _inFlightWrites: Promise<unknown>[] = []

  constructor(
    @IFileService private readonly _fileService: IFileService,
    @ILoggerService loggerService: ILoggerService | undefined,
    private readonly _backend: IOsClipboardBackend,
    materializeRoot: string,
    limits?: Partial<FileClipboardMeasureLimits>,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'fileClipboard', name: 'File Clipboard' })
    this._materializer = new ClipboardMaterializer(_fileService, materializeRoot, this._logger)
    this._limits = { ...DEFAULT_MEASURE_LIMITS, ...limits }
    // Async janitor for session dirs abandoned by a previous run (>24h old).
    void this._materializer.cleanupStale().catch(() => undefined)
  }

  async writeResources(
    resources: readonly IFileClipboardResource[],
    isCut: boolean,
    opts?: { materialize?: boolean },
  ): Promise<void> {
    const entries = this._normalize(resources)
    if (entries.length === 0) {
      await this.clear()
      return
    }
    const generation = ++this._generation
    const task = this._writeTask(entries, isCut, generation, opts?.materialize ?? true)
    this._inFlightWrites.push(task)
    try {
      await task
    } finally {
      const index = this._inFlightWrites.indexOf(task)
      if (index >= 0) this._inFlightWrites.splice(index, 1)
    }
  }

  private async _writeTask(
    entries: readonly ClipboardEntry[],
    isCut: boolean,
    generation: number,
    materialize: boolean,
  ): Promise<void> {
    const isWindows = process.platform === 'win32'
    const osPaths = new Map<string, string>()
    const needMaterialize: MaterializeEntry[] = []
    for (const entry of entries) {
      const local = localRevealFsPath(entry.uri, { isWindows })
      if (local !== undefined) {
        osPaths.set(entry.uri.toString(), local)
      } else {
        needMaterialize.push(entry)
      }
    }
    this._logger.debug(
      `[fileClipboard] writing ${entries.length} resources (${needMaterialize.length} need materialization)`,
    )
    let materialized: Map<string, string> | undefined
    if (needMaterialize.length > 0 && materialize) {
      materialized = await this._materializer.materialize(needMaterialize)
      for (const [key, path] of materialized) {
        osPaths.set(key, path)
      }
      this._logger.debug(
        `[fileClipboard] materialized ${materialized.size}/${needMaterialize.length} resources`,
      )
    }
    if (generation !== this._generation) {
      this._logger.debug('[fileClipboard] write superseded before os write — dropping')
      return
    }
    const paths = entries
      .map((entry) => osPaths.get(entry.uri.toString()))
      .filter((p): p is string => p !== undefined)
    const { ok, signature } = await this._backend.writeFiles(paths, isCut)
    if (generation !== this._generation) {
      this._logger.debug('[fileClipboard] write superseded during os write — dropping result')
      return
    }
    this._state = { entries, isCut, osSignature: signature, generation, wroteAtMs: Date.now() }
    this._logger.debug(
      `[fileClipboard] write committed: ${entries.length} resources isCut=${isCut} osWrite=${ok ? 'ok' : 'degraded'}`,
    )
    this._fire(this._toSnapshot(this._state))
  }

  async readResources(): Promise<IFileClipboardSnapshot> {
    let state = this._state
    if (!state && this._inFlightWrites.length > 0) {
      // First write is still landing: wait for it so a paste right after the
      // copy sees the new content instead of the previous OS clipboard state.
      await Promise.allSettled([...this._inFlightWrites])
      state = this._state
    }
    if (state) {
      if (this._inFlightWrites.length > 0 || Date.now() - state.wroteAtMs < OWNERSHIP_GRACE_MS) {
        return this._toSnapshot(state)
      }
      const os = await this._backend.readFiles()
      if (os === undefined) {
        // No file content on the OS clipboard — no evidence another application
        // overwrote us (our own write may have degraded to text-only). Keep the
        // internal state and refresh the grace window.
        state.wroteAtMs = Date.now()
        return this._toSnapshot(state)
      }
      if (os.signature === state.osSignature) {
        // Still ours — refresh the grace window so paste bursts stay spawn-free.
        state.wroteAtMs = Date.now()
        return this._toSnapshot(state)
      }
      this._logger.warn(
        `[fileClipboard] os clipboard overwritten by another application — falling back to os content (${os.paths.length} paths)`,
      )
      this._state = null
      const snapshot = await this._toOsSnapshot(os)
      this._fire(snapshot)
      return snapshot
    }
    const os = await this._backend.readFiles()
    if (os) {
      this._logger.debug(`[fileClipboard] reading os clipboard: ${os.paths.length} paths`)
      return this._toOsSnapshot(os)
    }
    return EMPTY_SNAPSHOT
  }

  async checkWriteCost(
    resources: readonly IFileClipboardResource[],
  ): Promise<IFileClipboardWriteCost> {
    const isWindows = process.platform === 'win32'
    const budget = { bytes: 0, count: 0, refused: false }
    const semaphore = new MeasureSemaphore(MEASURE_CONCURRENCY)
    let materializeCount = 0
    for (const entry of this._normalize(resources)) {
      if (localRevealFsPath(entry.uri, { isWindows }) !== undefined) continue
      materializeCount++
      await this._measureTree(entry.uri, budget, semaphore)
      if (budget.refused) break
    }
    return {
      materializeCount,
      totalBytes: budget.bytes,
      needsConfirmation: !budget.refused && budget.bytes > FILE_CLIPBOARD_CONFIRM_BYTES,
      refused: budget.refused,
    }
  }

  /**
   * Recursive byte/entry accounting with early abort once a hard limit is
   * exceeded. All `stat` calls in the walk share a single semaphore (see
   * {@link MEASURE_CONCURRENCY}), so a deep or bushy tree cannot multiply
   * per-directory concurrency into a burst; the limit is re-checked after
   * every stat, so once `budget.refused` flips no new `stat` is issued and
   * the walk finishes after the in-flight ones settle (overshoot ≤
   * MEASURE_CONCURRENCY regardless of tree shape).
   */
  private async _measureTree(
    uri: URI,
    budget: { bytes: number; count: number; refused: boolean },
    semaphore: MeasureSemaphore,
  ): Promise<void> {
    if (budget.refused) return
    await semaphore.acquire()
    if (budget.refused) {
      // The limit was crossed while we waited for a slot — release without
      // issuing a stat so no further I/O happens after refusal.
      semaphore.release()
      return
    }
    let stat: Awaited<ReturnType<IFileService['stat']>>
    try {
      stat = await this._fileService.stat(uri)
    } finally {
      semaphore.release()
    }
    budget.count++
    if (stat.isFile) {
      budget.bytes += stat.size
    }
    if (budget.bytes > this._limits.refuseBytes || budget.count > this._limits.refuseEntries) {
      budget.refused = true
      return
    }
    if (stat.isDirectory) {
      const children = await this._fileService.list(uri)
      await Promise.all(
        children.map((child) =>
          this._measureTree(URI.joinPath(uri, child.name), budget, semaphore),
        ),
      )
    }
  }

  async clear(): Promise<void> {
    const state = this._state
    this._state = null
    this._generation++
    // Wait out in-flight writes: their OS clipboard write may still land, and
    // must not repopulate the clipboard after our clear.
    while (this._inFlightWrites.length > 0) {
      await Promise.allSettled(this._inFlightWrites.splice(0))
    }
    await this._materializer.clear()
    this._fire(EMPTY_SNAPSHOT)
    if (state?.osSignature != null) {
      // Only clear the OS clipboard while the signature proves we still own it —
      // otherwise we would wipe whatever the user copied in another application.
      const os = await this._backend.readFiles()
      if (os && os.signature === state.osSignature) {
        await this._backend.clear()
        this._logger.debug('[fileClipboard] cleared os clipboard (still owned)')
      } else {
        this._logger.debug('[fileClipboard] os clipboard left untouched — ownership lost')
      }
    }
  }

  private _normalize(resources: readonly IFileClipboardResource[]): ClipboardEntry[] {
    const seen = new Set<string>()
    const entries: ClipboardEntry[] = []
    for (const resource of resources) {
      const uri = URI.revive(resource.resource)
      if (!uri) continue
      const key = uri.toString()
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({ uri, isDirectory: resource.isDirectory })
    }
    return entries
  }

  private _toSnapshot(state: ClipboardState): IFileClipboardSnapshot {
    return {
      resources: state.entries.map((entry) => ({
        resource: entry.uri.toJSON(),
        isDirectory: entry.isDirectory,
      })),
      isCut: state.isCut,
      source: 'internal',
    }
  }

  private async _toOsSnapshot(os: IOsClipboardReadResult): Promise<IFileClipboardSnapshot> {
    const resources = await Promise.all(
      os.paths.map(async (path) => {
        let isDirectory = false
        try {
          isDirectory = (await this._fileService.stat(URI.file(path))).isDirectory
        } catch {
          // Entry vanished since the clipboard was read — treat as a file.
        }
        return { resource: URI.file(path).toJSON(), isDirectory }
      }),
    )
    return { resources, isCut: os.isCut, source: 'os' }
  }

  private _fire(snapshot: IFileClipboardSnapshot): void {
    this._onDidChangeClipboard.fire(snapshot)
  }
}
