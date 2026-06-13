/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IApiUsageService — single owner of the account-level API usage snapshot. The
 *  data is global (not per-session), so one service holds the observable state and
 *  runs the only polling loop; every UsageIndicator just subscribes. Polling
 *  pauses while the window is hidden and refreshes immediately on return.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  IConfigurationService,
  observableValue,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { IUsageService, type UsageResult } from '../../../shared/ipc/services.js'

export type UsageState = { readonly kind: 'loading' } | UsageResult

export interface IApiUsageService {
  readonly _serviceBrand: undefined
  readonly state: IObservable<UsageState>
  /** Trigger a refresh now (debounced 500ms). */
  refresh(): void
}

export const IApiUsageService = createDecorator<IApiUsageService>('apiUsageService')

const REFRESH_INTERVAL_KEY = 'acp.usage.refreshIntervalMs'
const DEFAULT_INTERVAL_MS = 10_000
const MIN_INTERVAL_MS = 1_000
const REFRESH_DEBOUNCE_MS = 500

export class ApiUsageService extends Disposable implements IApiUsageService {
  declare readonly _serviceBrand: undefined

  private readonly _state: ISettableObservable<UsageState>
  readonly state: IObservable<UsageState>

  private _intervalTimer: ReturnType<typeof setInterval> | undefined
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined
  private _inflight = false
  /** Once credentials are missing the result is stable; stop polling for good. */
  private _disabled = false

  constructor(
    @IUsageService private readonly _usage: IUsageService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
  ) {
    super()
    this._state = observableValue<UsageState>('apiUsage', { kind: 'loading' })
    this.state = this._state

    const onVisibility = () => this._onVisibilityChange()
    document.addEventListener('visibilitychange', onVisibility)
    this._register({
      dispose: () => document.removeEventListener('visibilitychange', onVisibility),
    })

    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(REFRESH_INTERVAL_KEY)) this._restartPolling()
      }),
    )

    void this._fetch()
    this._restartPolling()
  }

  refresh(): void {
    if (this._debounceTimer !== undefined) clearTimeout(this._debounceTimer)
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined
      void this._fetch()
    }, REFRESH_DEBOUNCE_MS)
  }

  override dispose(): void {
    this._stopPolling()
    if (this._debounceTimer !== undefined) clearTimeout(this._debounceTimer)
    super.dispose()
  }

  private _intervalMs(): number {
    const v = this._configuration.get<number>(REFRESH_INTERVAL_KEY)
    return typeof v === 'number' && v >= MIN_INTERVAL_MS ? v : DEFAULT_INTERVAL_MS
  }

  private _restartPolling(): void {
    this._stopPolling()
    if (this._disabled || document.visibilityState === 'hidden') return
    this._intervalTimer = setInterval(() => void this._fetch(), this._intervalMs())
  }

  private _stopPolling(): void {
    if (this._intervalTimer !== undefined) {
      clearInterval(this._intervalTimer)
      this._intervalTimer = undefined
    }
  }

  private _onVisibilityChange(): void {
    if (this._disabled) return
    if (document.visibilityState === 'hidden') {
      this._stopPolling()
    } else {
      void this._fetch()
      this._restartPolling()
    }
  }

  private async _fetch(): Promise<void> {
    if (this._inflight || this._disabled) return
    this._inflight = true
    try {
      const result = await this._usage.getUsage()
      this._state.set(result, undefined)
      if (result.kind === 'disabled') {
        this._disabled = true
        this._stopPolling()
      }
    } finally {
      this._inflight = false
    }
  }
}
