/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generic owner of a machine-local JSON config file. Writes are serialized and
 *  atomic (0600), and the parent directory is watched so external edits apply
 *  without a restart. Watching the directory rather than the file survives the
 *  tmp-file + rename used by writeJsonAtomic. Parsing, the on-disk shape and
 *  patch merging stay with the consumer.
 *--------------------------------------------------------------------------------------------*/

import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Disposable, Emitter, type Event, type ILogger } from '@universe-editor/platform'
import { writeJsonAtomic } from './atomicFile.js'

export type JsonConfigReadResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly error: string }

export interface JsonConfigFileState<T> {
  readonly value: T
  readonly error?: string
}

export interface JsonConfigFileStoreOptions<T> {
  readonly file: string
  readonly logger: ILogger
  readonly debounceMs?: number
  readonly selfWriteSuppressMs?: number
  readonly onChmodError?: (error: Error) => void
  /** Only used in the "cannot create the <label> directory" warning. */
  readonly directoryLabel?: string
  /** Fresh value on every call so the store never shares a default with callers. */
  readonly createDefault: () => T
  /** Parse and validate the file; report missing / invalid instead of throwing. */
  readonly read: (file: string) => Promise<JsonConfigReadResult<T>>
  /** On-disk shape, also used for change detection; must be deterministic. */
  readonly serialize: (value: T) => unknown
}

export type JsonConfigPatchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] }

export type JsonConfigUpdateResult<T> =
  | { readonly ok: true; readonly state: JsonConfigFileState<T> }
  | {
      readonly ok: false
      readonly state: JsonConfigFileState<T>
      readonly errors: readonly string[]
    }

const DEFAULT_DEBOUNCE_MS = 200
const DEFAULT_SELF_WRITE_SUPPRESS_MS = 500

export class JsonConfigFileStore<T> extends Disposable {
  private readonly _file: string
  private readonly _fileName: string
  private readonly _dir: string
  private readonly _logger: ILogger
  private readonly _debounceMs: number
  private readonly _selfWriteSuppressMs: number
  private readonly _onChmodError: ((error: Error) => void) | undefined
  private readonly _directoryLabel: string
  private readonly _createDefault: () => T
  private readonly _readConfig: (file: string) => Promise<JsonConfigReadResult<T>>
  private readonly _serialize: (value: T) => unknown
  private readonly _onDidChangeExternal = this._register(new Emitter<JsonConfigFileState<T>>())
  readonly onDidChangeExternal: Event<JsonConfigFileState<T>> = this._onDidChangeExternal.event

  private _state: JsonConfigFileState<T>
  private _serial: Promise<void> = Promise.resolve()
  private _watcher: FSWatcher | undefined
  private _reloadTimer: NodeJS.Timeout | undefined
  private _suppressUntil = 0
  private _disposed = false

  constructor(options: JsonConfigFileStoreOptions<T>) {
    super()
    this._file = options.file
    this._fileName = basename(options.file)
    this._dir = dirname(options.file)
    this._logger = options.logger
    this._debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this._selfWriteSuppressMs = options.selfWriteSuppressMs ?? DEFAULT_SELF_WRITE_SUPPRESS_MS
    this._onChmodError = options.onChmodError
    this._directoryLabel = options.directoryLabel ?? 'config'
    this._createDefault = options.createDefault
    this._readConfig = options.read
    this._serialize = options.serialize
    this._state = { value: options.createDefault() }
    void this._ensureWatcher()
  }

  get state(): JsonConfigFileState<T> {
    return this._state
  }

  /** Startup read: a missing or invalid file yields defaults. */
  load(): Promise<JsonConfigFileState<T>> {
    return this._enqueue(async () => {
      const next = await this._read('startup')
      this._state = next
      return next
    })
  }

  /** External-edit read: an invalid file keeps the last valid value. */
  reload(): Promise<JsonConfigFileState<T>> {
    return this._enqueue(async () => {
      const next = await this._read('runtime')
      if (!sameState(next, this._state, this._serialize)) {
        this._state = next
        this._onDidChangeExternal.fire(next)
      }
      return next
    })
  }

  update(applyPatch: (current: T) => JsonConfigPatchResult<T>): Promise<JsonConfigUpdateResult<T>> {
    return this._enqueue(async (): Promise<JsonConfigUpdateResult<T>> => {
      const patch = applyPatch(this._state.value)
      if (!patch.ok) return { ok: false, state: this._state, errors: patch.errors }

      try {
        await this._write(patch.value)
      } catch (err) {
        return {
          ok: false,
          state: this._state,
          errors: [`cannot write ${this._fileName}: ${describeError(err)}`],
        }
      }

      const state: JsonConfigFileState<T> = { value: patch.value }
      this._state = state
      return { ok: true, state }
    })
  }

  /** Create the file with defaults only when it is absent; never overwrite a broken file. */
  ensureFile(): Promise<void> {
    return this._enqueue(async () => {
      const read = await this._readConfig(this._file)
      if (read.kind !== 'missing') return
      try {
        await this._write(this._createDefault())
      } catch (err) {
        this._logger.warn(`failed to create ${this._fileName}: ${describeError(err)}`)
      }
    })
  }

  override dispose(): void {
    this._disposed = true
    if (this._reloadTimer !== undefined) {
      clearTimeout(this._reloadTimer)
      this._reloadTimer = undefined
    }
    this._watcher?.close()
    this._watcher = undefined
    super.dispose()
  }

  private _enqueue<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const run = this._serial.then(task, task)
    this._serial = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async _read(mode: 'startup' | 'runtime'): Promise<JsonConfigFileState<T>> {
    const result = await this._readConfig(this._file)
    if (result.kind === 'ok') return { value: result.value }
    if (result.kind === 'missing') return { value: this._createDefault() }
    if (mode === 'startup') {
      this._logger.warn(`${this._fileName} is invalid; using defaults: ${result.error}`)
      return { value: this._createDefault(), error: result.error }
    }
    this._logger.warn(
      `${this._fileName} is invalid; keeping the last valid config: ${result.error}`,
    )
    return { value: this._state.value, error: result.error }
  }

  private async _write(value: T): Promise<void> {
    this._suppressUntil = Date.now() + this._selfWriteSuppressMs
    await writeJsonAtomic(this._file, this._serialize(value), this._onChmodError)
    // The rename event can arrive after the write resolves.
    this._suppressUntil = Date.now() + this._selfWriteSuppressMs
    void this._ensureWatcher()
  }

  private async _ensureWatcher(): Promise<void> {
    if (this._disposed || this._watcher !== undefined) return
    try {
      await mkdir(this._dir, { recursive: true })
    } catch (err) {
      this._logger.warn(
        `cannot create the ${this._directoryLabel} directory: ${describeError(err)}`,
      )
      return
    }
    if (this._disposed || this._watcher !== undefined) return
    try {
      const watcher = watch(this._dir, { persistent: false }, (_event, filename) => {
        if (filename !== null && filename !== this._fileName) return
        this._scheduleReload()
      })
      watcher.on('error', (err) => {
        this._logger.warn(`${this._fileName} watcher failed: ${describeError(err)}`)
        watcher.close()
        if (this._watcher === watcher) this._watcher = undefined
      })
      this._watcher = watcher
    } catch (err) {
      this._logger.warn(`cannot watch ${this._fileName}: ${describeError(err)}`)
    }
  }

  private _scheduleReload(): void {
    if (this._disposed || Date.now() < this._suppressUntil) return
    if (this._reloadTimer !== undefined) clearTimeout(this._reloadTimer)
    const timer = setTimeout(() => {
      this._reloadTimer = undefined
      if (this._disposed || Date.now() < this._suppressUntil) return
      void this.reload().catch((err) =>
        this._logger.warn(`failed to reload ${this._fileName}: ${describeError(err)}`),
      )
    }, this._debounceMs)
    timer.unref()
    this._reloadTimer = timer
  }
}

function sameState<T>(
  a: JsonConfigFileState<T>,
  b: JsonConfigFileState<T>,
  serialize: (value: T) => unknown,
): boolean {
  // Serializing both sides keeps this comparison exhaustive: new fields are
  // picked up automatically instead of silently escaping the external-edit
  // check and being overwritten by the next update.
  return (
    a.error === b.error && JSON.stringify(serialize(a.value)) === JSON.stringify(serialize(b.value))
  )
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
