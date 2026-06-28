/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionConnection — the connection lifecycle state machine for one
 *  AcpSession. Replaces the scattered `_conn` / `_connectionSettled` /
 *  `_resolveConnected` / `_whenConnected` / `_queuedPrompts` fields that
 *  previously encoded this implicitly, where correctness depended on every flag
 *  being kept in sync by hand.
 *
 *  Phases (one-way, terminal-absorbing):
 *
 *      connecting ──open()──► connected
 *          │
 *          ├──fail()────────► failed
 *          │
 *          └──close()───────► closed   (also reachable from connected)
 *
 *  Invariants the previous flag soup did NOT guarantee, now enforced here:
 *  - `connecting → failed` REJECTS every queued prompt with a clear error
 *    (the old `failConnection` silently dropped them — the caller's message was
 *    shown on screen but never sent and never surfaced as an error).
 *  - The "connecting settled" gate (`whenSettled`) resolves on EVERY exit from
 *    `connecting` (connected / failed / closed), so awaiters never hang.
 *  - A prompt enqueued while connecting is dispatched exactly once on connect,
 *    or rejected on fail/close — never lost.
 *--------------------------------------------------------------------------------------------*/

import type { IAcpClientConnection } from './acpClientService.js'
import type { PromptMention } from './promptMentions.js'
import { AcpConnectionError } from './acpErrors.js'

export type AcpConnectionPhase = 'connecting' | 'connected' | 'failed' | 'closed'

/**
 * A prompt buffered while the connection was still `connecting`. `resolve` /
 * `reject` settle the promise returned to the original `sendPrompt` caller, so a
 * queued prompt's eventual dispatch (or the connection's failure) is observable.
 */
export interface QueuedPrompt {
  readonly text: string
  readonly mentions: readonly PromptMention[]
  readonly resolve: () => void
  readonly reject: (err: Error) => void
}

/**
 * Re-exported from ./acpErrors.js (the consolidated ACP error family) so the
 * historical `acpSessionConnection` import path keeps working.
 */
export { AcpConnectionError }

export class AcpSessionConnection {
  private _phase: AcpConnectionPhase = 'connecting'
  private _conn: IAcpClientConnection | undefined
  private readonly _queued: QueuedPrompt[] = []

  private _resolveSettled!: () => void
  private readonly _whenSettled = new Promise<void>((resolve) => {
    this._resolveSettled = resolve
  })

  get phase(): AcpConnectionPhase {
    return this._phase
  }

  /** The live connection once `open` has run; undefined while connecting / after fail. */
  get conn(): IAcpClientConnection | undefined {
    return this._conn
  }

  /** True once the connecting phase has settled (connected / failed / closed). */
  get isSettled(): boolean {
    return this._phase !== 'connecting'
  }

  /** Resolves when the connecting phase settles; resolves immediately if already settled. */
  whenSettled(): Promise<void> {
    return this._whenSettled
  }

  /**
   * Buffer a prompt submitted before the connection was ready. The returned
   * promise resolves when the prompt is eventually dispatched (on `open`) and
   * rejects if the connection fails / closes first.
   */
  enqueue(text: string, mentions: readonly PromptMention[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._queued.push({ text, mentions, resolve, reject })
    })
  }

  /**
   * `connecting → connected`. Binds the live connection and drains the queued
   * prompts for the caller to dispatch (linking each prompt's deferred to its
   * dispatch result). No-op returning `[]` if the phase already settled (e.g. the
   * session was closed while connecting) — the connection is NOT bound in that
   * case, so the caller should check `phase` after calling.
   */
  open(conn: IAcpClientConnection): readonly QueuedPrompt[] {
    if (this._phase !== 'connecting') return []
    this._phase = 'connected'
    this._conn = conn
    this._resolveSettled()
    return this._queued.splice(0, this._queued.length)
  }

  /**
   * `connecting → failed`. Rejects every queued prompt with an
   * {@link AcpConnectionError} and settles the gate. Returns true iff it
   * transitioned (false when already settled).
   */
  fail(message: string): boolean {
    if (this._phase !== 'connecting') return false
    this._phase = 'failed'
    this._resolveSettled()
    this._rejectQueue(new AcpConnectionError(message))
    return true
  }

  /**
   * `→ closed` from any phase. Settles the gate if still connecting and rejects
   * any residual queue (a session closed before it ever connected). Terminal.
   */
  close(): void {
    const wasConnecting = this._phase === 'connecting'
    this._phase = 'closed'
    if (wasConnecting) this._resolveSettled()
    this._rejectQueue(new AcpConnectionError('Session closed before it connected'))
  }

  private _rejectQueue(err: Error): void {
    for (const q of this._queued.splice(0, this._queued.length)) q.reject(err)
  }
}
