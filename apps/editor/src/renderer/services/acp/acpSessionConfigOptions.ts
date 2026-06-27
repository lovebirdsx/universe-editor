/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigOptionStateMachine — owns the per-session `configOptions` observable,
 *  the echo-suppression set, and the `setConfigOption` push. Lives inside an
 *  AcpSession; created once per session and disposed with it.
 *
 *  Flicker-free reconciliation: the agent advertises options at *server*
 *  defaults (it has no knowledge of the value the user saved on our side).
 *  Applying that raw bag would briefly show the server default before an async
 *  push-back corrected it. Instead, every bag that reaches the observable (from
 *  `session/new`/`session/load` via {@link applyInitState}, or a later
 *  `config_option_update` via {@link ingestUpdate}) is first reconciled against
 *  the user's saved values ({@link setDesired}): the displayed `currentValue`
 *  jumps straight to the saved value, and the id is recorded as needing a real
 *  RPC so the agent actually adopts it. Those RPCs are flushed once the
 *  connection is attached ({@link flushPendingPushes}) — the visual override
 *  alone changes nothing agent-side.
 *--------------------------------------------------------------------------------------------*/

import {
  observableValue,
  type ITelemetryService,
  type ISettableObservable,
} from '@universe-editor/platform'
import type {
  SessionConfigOption,
  SessionUpdate,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk'
import type { IAcpClientConnection } from './acpClientService.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'
import type { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'

export interface ConfigOptionSessionInfo {
  /** Stable local id — used only to name the observable (survives the whole session). */
  readonly localId: string
  readonly agentId: string
  /**
   * Agent-issued session id, available only once the connection is attached.
   * Returns undefined while the session is still connecting.
   */
  getSessionId(): string | undefined
}

export interface ConfigOptionStateMachineDeps {
  /** Live connection once attached, else undefined (session still connecting). */
  getConn(): IAcpClientConnection | undefined
  readonly telemetry: ITelemetryService
  readonly sessionInfo: ConfigOptionSessionInfo
  readonly history?: IAcpSessionHistoryService
  readonly defaults?: IAcpAgentDefaultsService
  /** Logs a non-fatal push-back failure. Optional so unit tests can omit it. */
  warn?(message: string): void
}

export class ConfigOptionStateMachine {
  readonly configOptions: ISettableObservable<readonly SessionConfigOption[]>

  /**
   * Guard against ping-pong between user-driven `setConfigOption` and the
   * agent's echoed `config_option_update`. We add the configId before issuing
   * the RPC and remove it after the response. Updates that arrive while a
   * configId is in this set are skipped — the user's local change wins.
   */
  private readonly _pendingPushes = new Set<string>()

  /**
   * The user's saved values to reconcile incoming bags against: per-agent
   * defaults (new session) plus per-session history (resume). Seeded by the
   * service before the first bag is applied.
   */
  private _desired: Readonly<Record<string, string>> = {}

  /**
   * Ids whose displayed value we overrode to the saved value but whose *agent*
   * value still differs — they need a real `setConfigOption` RPC. Drained by
   * {@link flushPendingPushes} once the connection is attached.
   */
  private readonly _needsPush = new Set<string>()

  /** True while a `flushPendingPushes` sequence is running, to avoid re-entry. */
  private _flushing = false

  /**
   * Ids shown from the optimistic seed but not yet authoritatively advertised by
   * the agent. They are carried across {@link applyInitState} (so a
   * model-dependent option like `effort` — seeded high, but absent from the
   * `session/new` bag because it surfaces only after the model push — does not
   * disappear then reappear) and are reconciled to the saved value (rather than
   * applied verbatim) when the agent finally advertises them.
   */
  private readonly _provisional = new Set<string>()

  constructor(private readonly _deps: ConfigOptionStateMachineDeps) {
    this.configOptions = observableValue<readonly SessionConfigOption[]>(
      `acp.session.configOptions.${_deps.sessionInfo.localId}`,
      [],
    )
  }

  /** Seed the saved values used to reconcile every incoming bag. Idempotent. */
  setDesired(desired: Readonly<Record<string, string>>): void {
    this._desired = { ...desired }
  }

  /**
   * Apply the optimistic seed bag (last-known cached options with the user's
   * saved values overlaid). Every option is recorded as *provisional*: the
   * authoritative `session/new` bag carries it over instead of dropping it, and
   * the agent's later advertisement of it is reconciled to the saved value
   * rather than applied verbatim. This is what stops a model-dependent option
   * like `effort` (seeded high, absent from `session/new`, surfaced only after
   * the model push) from disappearing and reappearing.
   */
  seedConfigOptions(opts: readonly SessionConfigOption[]): void {
    const next = this._reconcile(opts, () => true)
    for (const o of next) this._provisional.add(o.id)
    this.configOptions.set(next, undefined)
    this.flushPendingPushes()
  }

  /** Replay the configOptions bag returned by `session/new` or `session/load`. */
  applyInitState(opts: readonly SessionConfigOption[]): void {
    const reconciled = this._reconcile(opts, () => true)
    const present = new Set(reconciled.map((o) => o.id))
    // Carry over provisional options the agent did not advertise in this
    // authoritative bag — they stay visible (at the saved value) until the agent
    // surfaces them, avoiding a disappear/reappear flicker.
    const carried = this.configOptions
      .get()
      .filter((o) => !present.has(o.id) && this._provisional.has(o.id))
    // Ids now authoritatively present are no longer provisional.
    for (const id of present) this._provisional.delete(id)
    this.configOptions.set([...reconciled, ...carried], undefined)
    this.flushPendingPushes()
  }

  /** Handle a `config_option_update` notification — filters out echoes for in-flight user pushes. */
  ingestUpdate(update: Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>): void {
    const filtered =
      this._pendingPushes.size === 0
        ? update.configOptions
        : update.configOptions.filter((o) => !this._pendingPushes.has(o.id))
    if (filtered.length === 0) return
    // Only reconcile options NOT already present (or still provisional): an
    // agent-driven change to an established option must win (e.g. switching model
    // resets effort), whereas a freshly-surfaced option — or one we are still
    // showing provisionally from the seed (effort/thought_level appears only
    // after init) — should route straight to the user's saved value instead of
    // flashing the server default.
    const known = new Set(this.configOptions.get().map((o) => o.id))
    const reconciled = this._reconcile(
      filtered,
      (id) => !known.has(id) || this._provisional.has(id),
    )
    for (const f of filtered) this._provisional.delete(f.id)
    if (reconciled.length === update.configOptions.length) {
      this.configOptions.set(reconciled, undefined)
    } else {
      const cur = this.configOptions.get()
      const byId = new Map(cur.map((o) => [o.id, o] as const))
      for (const f of reconciled) byId.set(f.id, f)
      this.configOptions.set(Array.from(byId.values()), undefined)
    }
    this.flushPendingPushes()
  }

  /**
   * Issue the real `setConfigOption` RPC for every id whose value we overrode
   * but the agent hasn't adopted yet. No-op until the connection is attached;
   * the session calls this again from `attachConnection`.
   *
   * Order matters: `model` must be pushed and fully settled BEFORE the others.
   * Switching the model server-side rebuilds the option list and resets
   * dependent options (notably `effort`) to their default for the new model — so
   * a concurrent or earlier `effort` push would be undone by the model switch,
   * and the model response bag itself carries the reset `effort`. Pushing model
   * first, awaiting it, then pushing the rest makes the dependent pushes the
   * final writers. The whole sequence is fenced in a microtask so it never runs
   * inside an observable reaction.
   */
  flushPendingPushes(): void {
    if (this._flushing || this._needsPush.size === 0) return
    const conn = this._deps.getConn()
    const sessionId = this._deps.sessionInfo.getSessionId()
    if (conn === undefined || sessionId === undefined) return
    this._flushing = true
    queueMicrotask(async () => {
      try {
        // Drain until empty rather than over a snapshot: pushing `model` makes
        // the agent rebuild and advertise `effort` via a later
        // `config_option_update`, which lands in `_needsPush` *after* this flush
        // started. A snapshot loop would miss it and the dependent option would
        // never be pushed. Re-selecting `model` first each round keeps it the
        // option that runs before its dependents.
        while (this._needsPush.size > 0) {
          const remaining = [...this._needsPush]
          const id = remaining.find((x) => x === 'model') ?? (remaining[0] as string | undefined)
          if (id === undefined) break
          const want = this._desired[id]
          if (want === undefined) {
            this._needsPush.delete(id)
            continue
          }
          try {
            // `_needsPush` membership means the agent value still differs even
            // though we already overrode the *display* — push unconditionally.
            await this.setConfigOption(id, want)
          } catch (err) {
            this._deps.warn?.(
              `failed to restore configOption ${id}=${want}: ${(err as Error).message}`,
            )
          } finally {
            this._needsPush.delete(id)
          }
        }
      } finally {
        this._flushing = false
      }
    })
  }

  /**
   * Reconcile a bag against the saved values: for each select option that
   * `consider`s, when the saved value differs from the server value (and the
   * option offers it), display the saved value and record the id as needing a
   * real RPC. Returns the (possibly rewritten) bag.
   */
  private _reconcile(
    opts: readonly SessionConfigOption[],
    consider: (id: string) => boolean,
  ): readonly SessionConfigOption[] {
    if (Object.keys(this._desired).length === 0) return opts
    return opts.map((opt) => {
      if (opt.type !== 'select' || !consider(opt.id)) return opt
      const want = this._desired[opt.id]
      if (want === undefined || want === opt.currentValue || !selectHasValue(opt, want)) return opt
      this._needsPush.add(opt.id)
      return { ...opt, currentValue: want }
    })
  }

  /**
   * Overlay the user's desired value onto any option that is still awaiting a
   * push ({@link _needsPush}) — used when applying a response/update bag that
   * may have reset a dependent option (e.g. a model switch resets effort). Keeps
   * the displayed value at the user's choice until that option's own push lands.
   */
  private _overlayPending(bag: readonly SessionConfigOption[]): readonly SessionConfigOption[] {
    if (this._needsPush.size === 0) return bag
    return bag.map((opt) => {
      if (opt.type !== 'select' || !this._needsPush.has(opt.id)) return opt
      const want = this._desired[opt.id]
      if (want === undefined || want === opt.currentValue || !selectHasValue(opt, want)) return opt
      return { ...opt, currentValue: want }
    })
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const conn = this._deps.getConn()
    const sessionId = this._deps.sessionInfo.getSessionId()
    // Connection not yet attached (session still connecting). The config bar now
    // renders optimistically from the cached bag before the handshake lands, so a
    // user can pick a value during this window. Apply it locally + persist it as
    // the per-agent default; once the connection attaches, `flushPendingPushes`
    // pushes the diff to the agent, so the choice is not lost.
    if (conn === undefined || sessionId === undefined) {
      this._applyLocalValue(configId, value)
      const { agentId } = this._deps.sessionInfo
      this._deps.defaults?.setDefault(agentId, configId, value)
      return
    }
    const params: SetSessionConfigOptionRequest = {
      sessionId,
      configId,
      value,
    }
    // Apply the value locally *before* the RPC round-trip, mirroring the
    // disconnected path, so the bar reflects the pick immediately. Echoes for
    // this id are suppressed via `_pendingPushes` while the RPC is in flight; on
    // failure we roll back.
    const prevValue = this._currentValueOf(configId)
    this._applyLocalValue(configId, value)
    this._pendingPushes.add(configId)
    try {
      const resp = await conn.conn.setSessionConfigOption(params)
      if (resp.configOptions) {
        // The response bag may (a) reset a dependent option we still owe a push
        // for — keep it pinned to the user's value via `_overlayPending` — and
        // (b) newly surface an option (a model switch rebuilds and reveals
        // `effort`); reconcile those so they jump to the saved value and get
        // queued for their own push. Then drain.
        const known = new Set(this.configOptions.get().map((o) => o.id))
        const reconciled = this._reconcile(
          resp.configOptions,
          (id) => !known.has(id) || this._provisional.has(id),
        )
        for (const o of resp.configOptions) this._provisional.delete(o.id)
        this.configOptions.set(this._overlayPending(reconciled), undefined)
        this.flushPendingPushes()
      }
      const { agentId } = this._deps.sessionInfo
      this._deps.history?.setHistoryConfigOption(sessionId, configId, value)
      this._deps.defaults?.setDefault(agentId, configId, value)
      this._deps.telemetry.publicLog('acp.config_option_set', { sessionId, configId })
    } catch (err) {
      // Restore the pre-push value so a rejected change isn't left showing.
      if (prevValue !== undefined) this._applyLocalValue(configId, prevValue)
      throw err
    } finally {
      this._pendingPushes.delete(configId)
    }
  }

  private _currentValueOf(configId: string): string | undefined {
    const opt = this.configOptions.get().find((o) => o.id === configId)
    return opt && opt.type === 'select' ? opt.currentValue : undefined
  }

  /** Optimistically flip a select option's `currentValue` in the local observable. */
  private _applyLocalValue(configId: string, value: string): void {
    const cur = this.configOptions.get()
    let changed = false
    const next = cur.map((o) => {
      if (o.id !== configId || o.type !== 'select' || o.currentValue === value) return o
      changed = true
      return { ...o, currentValue: value }
    })
    if (changed) this.configOptions.set(next, undefined)
  }
}

function selectHasValue(opt: SessionConfigOption & { type: 'select' }, value: string): boolean {
  for (const o of opt.options) {
    if ('group' in o) {
      for (const v of o.options) if (v.value === value) return true
    } else if (o.value === value) {
      return true
    }
  }
  return false
}
