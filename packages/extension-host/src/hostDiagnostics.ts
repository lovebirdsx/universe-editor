/**
 * Host-side backing for `languages.getDiagnostics` / `languages.onDidChangeDiagnostics`.
 * getDiagnostics forwards to the renderer uncached — the renderer reads the live
 * Monaco marker registry, which holds every owner's markers (all extensions'
 * collections plus the built-in language services), so a host-side cache would
 * only ever be a stale copy. The change event is ref-counted: the first listener
 * subscribes renderer-side marker pushes and the last dispose unsubscribes, so a
 * host with no listeners costs zero RPC traffic (the same interest pattern as
 * HostFileWatcherRegistry).
 */
import { Emitter, type Event, type IDisposable } from '@universe-editor/platform'
import type { UriComponents } from '@universe-editor/extension-api'
import type { Diagnostic } from 'vscode-languageserver-types'
import type { IMainThreadLanguages } from '@universe-editor/extensions-common'
import type { DiagnosticChangeEventBridge } from './apiFactory.js'

export class HostDiagnostics {
  private readonly _onDidChangeDiagnostics = new Emitter<DiagnosticChangeEventBridge>()
  private _listenerCount = 0

  constructor(private readonly _mainThread: IMainThreadLanguages) {}

  getDiagnostics(uri?: UriComponents): Promise<Array<[UriComponents, Diagnostic[]]>> {
    return this._mainThread.$getDiagnostics(uri)
  }

  readonly onDidChangeDiagnostics: Event<DiagnosticChangeEventBridge> = (listener) => {
    const inner = this._onDidChangeDiagnostics.event(listener)
    this._listenerCount++
    if (this._listenerCount === 1) this._flipInterest(true)
    let disposed = false
    const result: IDisposable = {
      dispose: () => {
        if (disposed) return
        disposed = true
        inner.dispose()
        this._listenerCount--
        if (this._listenerCount === 0) this._flipInterest(false)
      },
    }
    return result
  }

  /** IExtHostLanguages.$acceptDiagnosticsChange — renderer push (fire-and-forget). */
  acceptDiagnosticsChange(uris: readonly UriComponents[]): void {
    if (this._listenerCount === 0) return
    this._onDidChangeDiagnostics.fire({ uris })
  }

  dispose(): void {
    if (this._listenerCount > 0) {
      this._listenerCount = 0
      this._flipInterest(false)
    }
    this._onDidChangeDiagnostics.dispose()
  }

  private _flipInterest(subscribe: boolean): void {
    const pending = subscribe
      ? this._mainThread.$subscribeDiagnostics()
      : this._mainThread.$unsubscribeDiagnostics()
    void pending.catch((err: unknown) => {
      console.warn(`[ext-host] diagnostics subscription flip failed: ${(err as Error).message}`)
    })
  }
}
