/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionRegistry — the single owner of "which sessions exist and which is
 *  active". It holds the `AcpSession[]` store plus the three derived observables
 *  (`sessions` / `activeSessionId` / `activeSession`) and exposes ATOMIC CRUD so
 *  every mutation flips the array and the active pointers inside one
 *  transaction. Previously this bookkeeping was duplicated in six call sites of
 *  AcpSessionService (create / resume-success / resume-rollback / close /
 *  workspace-swap / setActive), each hand-rolling its own `transaction(...)` and
 *  active-reselection — a recurring source of split-brain bugs (the
 *  workspace-swap ordering hazard is documented at its call site).
 *
 *  This class is intentionally behaviour-free: no IPC, no telemetry, no
 *  disposal of sessions. Callers stay responsible for spawning / closing /
 *  disposing the AcpSession instances; the registry only tracks membership and
 *  selection so it can be unit-tested in isolation.
 *--------------------------------------------------------------------------------------------*/

import {
  observableValue,
  transaction,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import type { AcpSession, IAcpSession } from './acpSession.js'

export class AcpSessionRegistry {
  private _sessions: AcpSession[] = []

  private readonly _sessionsObs: ISettableObservable<readonly IAcpSession[]> = observableValue<
    readonly IAcpSession[]
  >('acp.sessions', [])
  private readonly _activeSessionId: ISettableObservable<string | undefined> = observableValue<
    string | undefined
  >('acp.activeSessionId', undefined)
  private readonly _activeSession: ISettableObservable<IAcpSession | undefined> = observableValue<
    IAcpSession | undefined
  >('acp.activeSession', undefined)

  get sessions(): IObservable<readonly IAcpSession[]> {
    return this._sessionsObs
  }
  get activeSessionId(): IObservable<string | undefined> {
    return this._activeSessionId
  }
  get activeSession(): IObservable<IAcpSession | undefined> {
    return this._activeSession
  }

  /** Snapshot of the live sessions for iteration (do not mutate). */
  all(): readonly AcpSession[] {
    return this._sessions
  }

  /**
   * Ids of all live sessions — BOTH the stable local id AND the agent-issued
   * `sessionIdOnAgent` (when attached). The refresh-mode hydrate prune protects
   * entries via `preserveIds`, which it matches against the history row's `id`
   * (equal to `sessionIdOnAgent`). A freshly-created session's local uuid never
   * equals its agent id, so collecting only local ids would leave a just-created
   * session unprotected — the replace sweep would prune it the instant the agent
   * (e.g. codex) hasn't yet surfaced it in `session/list`. Carrying both domains
   * keeps the protection robust regardless of which id the consumer compares.
   */
  liveIds(): Set<string> {
    const ids = new Set<string>()
    for (const s of this._sessions) {
      ids.add(s.id)
      const agentId = s.sessionIdOnAgent.get()
      if (agentId !== undefined) ids.add(agentId)
    }
    return ids
  }

  /**
   * Find a live session by either its stable local id or its agent-issued
   * sessionId. Callers may hold either: the local id is used by freshly-created
   * sessions / editor inputs opened in this run, while the agent id is what
   * history rows, persisted editor inputs, and protocol notifications carry.
   */
  find(sessionId: string): AcpSession | undefined {
    return this._sessions.find((x) => x.id === sessionId || x.sessionIdOnAgent.get() === sessionId)
  }

  /** Append a session, optionally making it the active one, atomically. */
  add(session: AcpSession, options: { activate: boolean }): void {
    transaction((tx) => {
      this._sessions = [...this._sessions, session]
      this._sessionsObs.set(this._sessions, tx)
      if (options.activate) {
        this._activeSessionId.set(session.id, tx)
        this._activeSession.set(session, tx)
      }
    })
  }

  /**
   * Insert `session`, replacing any existing one with the same local id (resume
   * re-registration), optionally activating it. Returns the prior same-id
   * session so the caller can dispose it — the registry never disposes.
   */
  replace(session: AcpSession, options: { activate: boolean }): AcpSession | undefined {
    const prior = this._sessions.find((s) => s.id === session.id)
    transaction((tx) => {
      this._sessions = [...this._sessions.filter((s) => s.id !== session.id), session]
      this._sessionsObs.set(this._sessions, tx)
      if (options.activate) {
        this._activeSessionId.set(session.id, tx)
        this._activeSession.set(session, tx)
      }
    })
    return prior
  }

  /**
   * Remove the session with local id `localId`. If it was the active session,
   * reselect the first remaining session (or clear when none remain). All in
   * one transaction.
   */
  remove(localId: string): void {
    transaction((tx) => {
      this._sessions = this._sessions.filter((x) => x.id !== localId)
      this._sessionsObs.set(this._sessions, tx)
      if (this._activeSessionId.get() === localId) {
        const next = this._sessions[0]
        this._activeSessionId.set(next?.id, tx)
        this._activeSession.set(next, tx)
      }
    })
  }

  /** Make `sessionId` (local or agent-issued) the active session; no-op if unknown. */
  setActive(sessionId: string): void {
    const s = this.find(sessionId)
    if (!s) return
    transaction((tx) => {
      this._activeSessionId.set(s.id, tx)
      this._activeSession.set(s, tx)
    })
  }

  /** Drop every session and clear the active pointers. Returns the prior list. */
  clear(): readonly AcpSession[] {
    const prior = this._sessions
    transaction((tx) => {
      this._sessions = []
      this._sessionsObs.set(this._sessions, tx)
      this._activeSessionId.set(undefined, tx)
      this._activeSession.set(undefined, tx)
    })
    return prior
  }
}
