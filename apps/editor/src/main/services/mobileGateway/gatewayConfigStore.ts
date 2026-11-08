/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Owner of the machine-local `<userData>/mobile/gateway.json`. Writes are
 *  serialized and atomic (0600), and the parent directory is watched so editing
 *  the JSON applies without restarting. Watching the directory rather than the
 *  file survives the tmp-file + rename used by writeJsonAtomic.
 *--------------------------------------------------------------------------------------------*/

import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Disposable, Emitter, type Event, type ILogger } from '@universe-editor/platform'
import type {
  MobileGatewayConfig,
  MobileGatewayConfigPatch,
  MobileGatewayConfigState,
  MobileGatewayConfigUpdateResult,
} from '../../../shared/ipc/mobileGatewayService.js'
import { DEFAULT_MOBILE_GATEWAY_CONFIG } from '../../../shared/ipc/mobileGatewayService.js'
import { writeJsonAtomic } from './atomicFile.js'
import {
  mergeMobileGatewayConfig,
  parseMobileGatewayConfigFile,
  readMobileGatewayConfigFile,
  serializeMobileGatewayConfig,
  validateMobileGatewayConfigPatch,
} from './gatewayConfigFile.js'

export interface MobileGatewayConfigStoreOptions {
  readonly file: string
  readonly logger: ILogger
  readonly debounceMs?: number
  readonly selfWriteSuppressMs?: number
  readonly onChmodError?: (error: Error) => void
}

const DEFAULT_DEBOUNCE_MS = 200
const DEFAULT_SELF_WRITE_SUPPRESS_MS = 500

export class MobileGatewayConfigStore extends Disposable {
  private readonly _file: string
  private readonly _fileName: string
  private readonly _dir: string
  private readonly _logger: ILogger
  private readonly _debounceMs: number
  private readonly _selfWriteSuppressMs: number
  private readonly _onChmodError: ((error: Error) => void) | undefined
  private readonly _onDidChangeExternal = this._register(new Emitter<MobileGatewayConfigState>())
  readonly onDidChangeExternal: Event<MobileGatewayConfigState> = this._onDidChangeExternal.event

  private _state: MobileGatewayConfigState = { config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG } }
  private _serial: Promise<void> = Promise.resolve()
  private _watcher: FSWatcher | undefined
  private _reloadTimer: NodeJS.Timeout | undefined
  private _suppressUntil = 0
  private _disposed = false

  constructor(options: MobileGatewayConfigStoreOptions) {
    super()
    this._file = options.file
    this._fileName = basename(options.file)
    this._dir = dirname(options.file)
    this._logger = options.logger
    this._debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this._selfWriteSuppressMs = options.selfWriteSuppressMs ?? DEFAULT_SELF_WRITE_SUPPRESS_MS
    this._onChmodError = options.onChmodError
    void this._ensureWatcher()
  }

  get state(): MobileGatewayConfigState {
    return this._state
  }

  /** Startup read: a missing or invalid file yields defaults (gateway off). */
  load(): Promise<MobileGatewayConfigState> {
    return this._enqueue(async () => {
      const next = await this._read('startup')
      this._state = next
      return next
    })
  }

  /** External-edit read: an invalid file keeps the last valid config. */
  reload(): Promise<MobileGatewayConfigState> {
    return this._enqueue(async () => {
      const next = await this._read('runtime')
      if (!sameState(next, this._state)) {
        this._state = next
        this._onDidChangeExternal.fire(next)
      }
      return next
    })
  }

  update(patch: MobileGatewayConfigPatch): Promise<MobileGatewayConfigUpdateResult> {
    return this._enqueue(async () => {
      const validated = validateMobileGatewayConfigPatch(patch)
      if (!validated.ok) return { ok: false, state: this._state, errors: validated.errors }

      const merged = mergeMobileGatewayConfig(this._state.config, validated.patch)
      const parsed = parseMobileGatewayConfigFile(merged)
      if (!parsed.ok) return { ok: false, state: this._state, errors: parsed.errors }

      try {
        await this._write(parsed.config)
      } catch (err) {
        return {
          ok: false,
          state: this._state,
          errors: [`cannot write gateway.json: ${describeError(err)}`],
        }
      }

      const state: MobileGatewayConfigState = { config: parsed.config }
      this._state = state
      return { ok: true, state }
    })
  }

  /** Create the file with defaults only when it is absent; never overwrite a broken file. */
  ensureFile(): Promise<void> {
    return this._enqueue(async () => {
      const read = await readMobileGatewayConfigFile(this._file)
      if (read.kind !== 'missing') return
      try {
        await this._write({ ...DEFAULT_MOBILE_GATEWAY_CONFIG })
      } catch (err) {
        this._logger.warn(`failed to create gateway.json: ${describeError(err)}`)
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

  private _enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this._serial.then(task, task)
    this._serial = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async _read(mode: 'startup' | 'runtime'): Promise<MobileGatewayConfigState> {
    const result = await readMobileGatewayConfigFile(this._file)
    if (result.kind === 'ok') return { config: result.config }
    if (result.kind === 'missing') return { config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG } }
    if (mode === 'startup') {
      this._logger.warn(`gateway.json is invalid; using defaults: ${result.error}`)
      return { config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG }, error: result.error }
    }
    this._logger.warn(`gateway.json is invalid; keeping the last valid config: ${result.error}`)
    return { config: this._state.config, error: result.error }
  }

  private async _write(config: MobileGatewayConfig): Promise<void> {
    this._suppressUntil = Date.now() + this._selfWriteSuppressMs
    await writeJsonAtomic(this._file, serializeMobileGatewayConfig(config), this._onChmodError)
    // The rename event can arrive after the write resolves.
    this._suppressUntil = Date.now() + this._selfWriteSuppressMs
    void this._ensureWatcher()
  }

  private async _ensureWatcher(): Promise<void> {
    if (this._disposed || this._watcher !== undefined) return
    try {
      await mkdir(this._dir, { recursive: true })
    } catch (err) {
      this._logger.warn(`cannot create the mobile config directory: ${describeError(err)}`)
      return
    }
    if (this._disposed || this._watcher !== undefined) return
    try {
      const watcher = watch(this._dir, { persistent: false }, (_event, filename) => {
        if (filename !== null && filename !== this._fileName) return
        this._scheduleReload()
      })
      watcher.on('error', (err) => {
        this._logger.warn(`gateway.json watcher failed: ${describeError(err)}`)
        watcher.close()
        if (this._watcher === watcher) this._watcher = undefined
      })
      this._watcher = watcher
    } catch (err) {
      this._logger.warn(`cannot watch gateway.json: ${describeError(err)}`)
    }
  }

  private _scheduleReload(): void {
    if (this._disposed || Date.now() < this._suppressUntil) return
    if (this._reloadTimer !== undefined) clearTimeout(this._reloadTimer)
    const timer = setTimeout(() => {
      this._reloadTimer = undefined
      if (this._disposed || Date.now() < this._suppressUntil) return
      void this.reload().catch((err) =>
        this._logger.warn(`failed to reload gateway.json: ${describeError(err)}`),
      )
    }, this._debounceMs)
    timer.unref()
    this._reloadTimer = timer
  }
}

function sameState(a: MobileGatewayConfigState, b: MobileGatewayConfigState): boolean {
  return a.error === b.error && sameConfig(a.config, b.config)
}

function sameConfig(a: MobileGatewayConfig, b: MobileGatewayConfig): boolean {
  return (
    a.enabled === b.enabled &&
    a.bind === b.bind &&
    a.lanAddress === b.lanAddress &&
    a.port === b.port &&
    a.vapidSubject === b.vapidSubject &&
    a.allowedHosts.length === b.allowedHosts.length &&
    a.allowedHosts.every((value, index) => value === b.allowedHosts[index])
  )
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
