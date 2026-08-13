/**
 * Host-side backing for `languages.getDiagnostics` / `languages.onDidChangeDiagnostics`.
 * getDiagnostics forwards to the renderer uncached — the renderer reads the live
 * Monaco marker registry, which holds every owner's markers (all extensions'
 * collections plus the built-in language services), so a host-side cache would
 * only ever be a stale copy. The change event is ref-counted (via the same
 * InterestGate as HostFileWatcherRegistry): the first listener subscribes
 * renderer-side marker pushes and the last dispose unsubscribes, so a host with
 * no listeners costs zero RPC traffic.
 */
import { Emitter, type Event, type IDisposable } from '@universe-editor/platform'
import type { UriComponents } from '@universe-editor/extension-api'
import type { Diagnostic } from 'vscode-languageserver-types'
import type { IMainThreadLanguages } from '@universe-editor/extensions-common'
import type { DiagnosticChangeEventBridge } from './apiFactory.js'
import { InterestGate } from './interestGate.js'

/** The diagnostics interest carries no payload — a single fixed key suffices. */
const DIAGNOSTICS_INTEREST = 'diagnostics'

export class HostDiagnostics {
  private readonly _onDidChangeDiagnostics = new Emitter<DiagnosticChangeEventBridge>()
  private readonly _interestGate: InterestGate<null>

  constructor(private readonly _mainThread: IMainThreadLanguages) {
    this._interestGate = new InterestGate<null>(
      () => this._mainThread.$subscribeDiagnostics(),
      () => this._mainThread.$unsubscribeDiagnostics(),
      'diagnostics',
    )
  }

  getDiagnostics(uri?: UriComponents): Promise<Array<[UriComponents, Diagnostic[]]>> {
    return this._mainThread.$getDiagnostics(uri)
  }

  readonly onDidChangeDiagnostics: Event<DiagnosticChangeEventBridge> = (listener) => {
    const inner = this._onDidChangeDiagnostics.event(listener)
    const lease = this._interestGate.acquire(DIAGNOSTICS_INTEREST, null)
    const result: IDisposable = {
      dispose: () => {
        inner.dispose()
        lease.dispose()
      },
    }
    return result
  }

  /** IExtHostLanguages.$acceptDiagnosticsChange — renderer push (fire-and-forget). */
  acceptDiagnosticsChange(uris: readonly UriComponents[]): void {
    if (this._interestGate.size === 0) return
    this._onDidChangeDiagnostics.fire({ uris })
  }

  dispose(): void {
    this._interestGate.dispose()
    this._onDidChangeDiagnostics.dispose()
  }
}
