/**
 * Reference-counted "interest" declarations toward the renderer: only the
 * 0↔n transitions of a unique interest cross the wire, so N consumers sharing
 * one declaration cost a single subscribe/unsubscribe pair and a host with no
 * consumers costs zero RPC traffic. Declarations are fire-and-forget — the
 * renderer's subscribe is idempotent, so a failed flip is logged, never thrown.
 *
 * Consumers: HostFileWatcherRegistry (per `{base, pattern}` interest) and
 * HostDiagnostics (a single listener-count interest).
 */
import type { IDisposable } from '@universe-editor/platform'

export class InterestGate<TDto> {
  private readonly _leases = new Map<string, { readonly dto: TDto; count: number }>()

  constructor(
    private readonly _subscribe: (dto: TDto) => Promise<unknown>,
    private readonly _unsubscribe: (dto: TDto) => Promise<unknown>,
    /** Log label for failed flips (`[ext-host] <label> subscription flip failed`). */
    private readonly _label: string,
  ) {}

  /** Number of unique interests currently held. */
  get size(): number {
    return this._leases.size
  }

  /**
   * Hold one reference to `key`'s interest (the first holder's `dto` is what
   * crosses the wire) and return a one-shot lease; disposing the last lease of
   * a key sends the unsubscribe.
   */
  acquire(key: string, dto: TDto): IDisposable {
    const lease = this._leases.get(key)
    if (lease !== undefined) {
      lease.count++
    } else {
      this._leases.set(key, { dto, count: 1 })
      this._declare(dto, true)
    }
    let released = false
    return {
      dispose: () => {
        if (released) return
        released = true
        this._release(key)
      },
    }
  }

  /**
   * Unsubscribe every unique interest outright and drop the table. Counts are
   * moot once the owner itself is gone — releasing the leases one by one would
   * skip the single unsubscribe a still-shared interest owes the renderer.
   */
  dispose(): void {
    for (const lease of this._leases.values()) {
      this._declare(lease.dto, false)
    }
    this._leases.clear()
  }

  private _release(key: string): void {
    const lease = this._leases.get(key)
    if (lease === undefined) return
    lease.count--
    if (lease.count > 0) return
    this._leases.delete(key)
    this._declare(lease.dto, false)
  }

  private _declare(dto: TDto, subscribe: boolean): void {
    const pending = subscribe ? this._subscribe(dto) : this._unsubscribe(dto)
    void pending.catch((err: unknown) => {
      console.warn(`[ext-host] ${this._label} subscription flip failed: ${(err as Error).message}`)
    })
  }
}
