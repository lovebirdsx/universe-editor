/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Owns every time anchor and wake-up: the startup gate (grace after start / first
 *  host), armed schedule slots and poll due times, missed-slot accounting, and the
 *  single wake timer. The scheduler never executes runs itself: schedule occurrences
 *  become events, polls are delegated to the PollRunner, and the run ledger decides
 *  whether an event is accepted.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'
import {
  computeDue,
  DEFAULT_MISSED_GRACE_MS,
  type ScheduleSourceConfig,
} from '../../../shared/triggers/scheduler.js'
import type { TriggerEvent } from '../../../shared/triggers/types.js'
import type { PollRunner } from './pollRunner.js'
import type { TriggerClock, TriggerTimerHandle } from './triggerClock.js'
import { parseTriggerKey } from './triggerIdentity.js'
import type { RuntimeStatePatch } from './triggerStateRepository.js'
import type { TriggerRuntimeState } from './triggerStateStore.js'
import type { RoutedTrigger } from './triggerTypes.js'

export interface SchedulerHost {
  readonly logger: ILogger
  readonly clock: TriggerClock
  readonly startupGraceMs: number
  readonly pollRunner: PollRunner
  allTriggers(): RoutedTrigger[]
  findTrigger(triggerKey: string): RoutedTrigger | undefined
  isRunnable(
    trigger: RoutedTrigger,
    options?: { ignoreBackoff?: boolean; manual?: boolean },
  ): boolean
  stateFor(triggerKey: string): TriggerRuntimeState
  setTriggerState(triggerKey: string, patch: RuntimeStatePatch): void
  acceptEvent(trigger: RoutedTrigger, event: TriggerEvent): Promise<boolean>
  fireChange(): void
  replayPendingRuns(): void
}

export class TriggerScheduler {
  private readonly _host: SchedulerHost
  private readonly _startedAt: number
  private readonly _armedSchedule = new Map<string, number>()
  private readonly _nextPoll = new Map<string, number>()
  private _firstHostAt: number | undefined
  private _gateDeadline: number | undefined
  private _gateTimer: TriggerTimerHandle | undefined
  private _gateOpen = false
  private _wakeTimer: TriggerTimerHandle | undefined
  private _disposed = false

  constructor(host: SchedulerHost) {
    this._host = host
    this._startedAt = host.clock.now()
  }

  isGateOpen(): boolean {
    return this._gateOpen
  }

  /** Initial startup gate: start + startup grace, extended by the first host. */
  armStartupGate(): void {
    if (this._disposed || this._gateOpen) return
    const startedDeadline = this._startedAt + this._host.startupGraceMs
    const hostDeadline =
      this._firstHostAt === undefined ? undefined : this._firstHostAt + this._host.startupGraceMs
    const deadline =
      hostDeadline === undefined ? startedDeadline : Math.max(startedDeadline, hostDeadline)
    this._armGateTimer(deadline)
  }

  /** The first host registration extends the startup grace deadline. */
  noteHostRegistered(): void {
    if (this._gateOpen || this._firstHostAt !== undefined) return
    this._firstHostAt = this._host.clock.now()
    const deadline = this._firstHostAt + this._host.startupGraceMs
    if (this._gateDeadline === undefined || deadline > this._gateDeadline) {
      this._armGateTimer(deadline)
    }
  }

  /** A config change (or a newly runnable trigger) refreshes every cadence anchor. */
  syncTiming(now: number): void {
    this.pruneTiming()
    if (!this._gateOpen || this._disposed) return
    const host = this._host
    for (const trigger of host.allTriggers()) {
      if (trigger.source.type !== 'poll' || !host.isRunnable(trigger, { ignoreBackoff: true }))
        continue
      if (this._nextPoll.has(trigger.key)) continue
      // The first poll right after the startup grace seeds the baseline; a trigger
      // already cooling down waits for the end of its backoff.
      const backoffUntil = host.stateFor(trigger.key).backoffUntil ?? now
      this._nextPoll.set(trigger.key, Math.max(now, backoffUntil))
    }
    this._processDueSchedules(now)
    this.rescheduleWake()
  }

  pruneTiming(): void {
    const host = this._host
    for (const triggerKey of [...this._armedSchedule.keys()]) {
      const trigger = host.findTrigger(triggerKey)
      if (
        trigger === undefined ||
        trigger.source.type !== 'schedule' ||
        // Backoff must not delete the anchor: the wake-up still has to happen so
        // the slot can be counted as skipped and the next one armed.
        !host.isRunnable(trigger, { ignoreBackoff: true })
      ) {
        this._armedSchedule.delete(triggerKey)
      }
    }
    for (const triggerKey of [...this._nextPoll.keys()]) {
      const trigger = host.findTrigger(triggerKey)
      if (
        trigger === undefined ||
        trigger.source.type !== 'poll' ||
        !host.isRunnable(trigger, { ignoreBackoff: true })
      ) {
        this._nextPoll.delete(triggerKey)
      }
    }
  }

  /** Drop one trigger's anchors (pause / config removal). */
  forgetTrigger(triggerKey: string): void {
    this._armedSchedule.delete(triggerKey)
    this._nextPoll.delete(triggerKey)
  }

  /** Drop every trigger anchor of a workspace (config apply / offline). */
  forgetWorkspace(workspaceKey: string): void {
    for (const triggerKey of [...this._armedSchedule.keys()]) {
      if (parseTriggerKey(triggerKey)?.workspaceKey === workspaceKey) {
        this._armedSchedule.delete(triggerKey)
      }
    }
    for (const triggerKey of [...this._nextPoll.keys()]) {
      if (parseTriggerKey(triggerKey)?.workspaceKey === workspaceKey) {
        this._nextPoll.delete(triggerKey)
      }
    }
  }

  forgetTriggers(triggerKeys: Iterable<string>): void {
    for (const triggerKey of triggerKeys) this.forgetTrigger(triggerKey)
  }

  /** Global pause: no anchor may fire until the user resumes. */
  forgetAll(): void {
    this._armedSchedule.clear()
    this._nextPoll.clear()
    this.rescheduleWake()
  }

  /** The next scheduled / poll time shown in the manager summary. */
  nextRunAt(trigger: RoutedTrigger, paused: boolean): number | undefined {
    if (!trigger.enabled || paused) return undefined
    if (trigger.source.type === 'schedule') return this._armedSchedule.get(trigger.key)
    if (trigger.source.type === 'poll') return this._nextPoll.get(trigger.key)
    return undefined
  }

  /** Next poll is one interval after completion (plus any failure backoff). */
  finishPoll(triggerKey: string): void {
    if (this._disposed) return
    const host = this._host
    const current = host.findTrigger(triggerKey)
    if (
      current === undefined ||
      current.source.type !== 'poll' ||
      !host.isRunnable(current, { ignoreBackoff: true })
    ) {
      this._nextPoll.delete(triggerKey)
      this.rescheduleWake()
      return
    }
    const now = host.clock.now()
    const intervalMs = current.source.intervalSec * 1000
    const backoffUntil = host.stateFor(triggerKey).backoffUntil
    const next =
      backoffUntil !== undefined && backoffUntil > now
        ? Math.max(now + intervalMs, backoffUntil)
        : now + intervalMs
    this._nextPoll.set(triggerKey, next)
    this.rescheduleWake()
  }

  rescheduleWake(): void {
    const clock = this._host.clock
    if (this._wakeTimer !== undefined) {
      clock.clearTimeout(this._wakeTimer)
      this._wakeTimer = undefined
    }
    if (this._disposed || !this._gateOpen) return
    let next: number | undefined
    for (const at of this._armedSchedule.values())
      next = next === undefined ? at : Math.min(next, at)
    for (const [triggerKey, at] of this._nextPoll) {
      // An in-flight poll has no trustworthy completion time yet; `finishPoll`
      // re-arms it. Its stale due anchor would otherwise spin the wake timer.
      if (this._host.pollRunner.isPolling(triggerKey)) continue
      next = next === undefined ? at : Math.min(next, at)
    }
    if (next === undefined) return
    const delay = Math.max(0, next - clock.now())
    this._wakeTimer = clock.setTimeout(() => {
      this._wakeTimer = undefined
      this._onWake()
    }, delay)
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    const clock = this._host.clock
    if (this._wakeTimer !== undefined) {
      clock.clearTimeout(this._wakeTimer)
      this._wakeTimer = undefined
    }
    if (this._gateTimer !== undefined) {
      clock.clearTimeout(this._gateTimer)
      this._gateTimer = undefined
    }
  }

  private _armGateTimer(deadline: number): void {
    const clock = this._host.clock
    if (this._gateTimer !== undefined) clock.clearTimeout(this._gateTimer)
    this._gateDeadline = deadline
    const delay = Math.max(0, deadline - clock.now())
    this._host.logger.trace(`trigger scheduling gate in ${delay}ms`)
    this._gateTimer = clock.setTimeout(() => {
      this._gateTimer = undefined
      this._openGate()
    }, delay)
  }

  private _openGate(): void {
    if (this._disposed || this._gateOpen) return
    this._gateOpen = true
    this._host.logger.info('trigger scheduling started')
    this._host.replayPendingRuns()
    this.syncTiming(this._host.clock.now())
    this._host.fireChange()
  }

  private _processDueSchedules(now: number): void {
    const host = this._host
    for (const trigger of host.allTriggers()) {
      if (trigger.source.type !== 'schedule') continue
      // Timing is evaluated even in backoff so the slot is consumed ("skipped")
      // instead of being replayed the moment the backoff ends.
      if (!host.isRunnable(trigger, { ignoreBackoff: true })) continue
      const armed = this._armedSchedule.get(trigger.key)
      if (armed !== undefined && armed > now) continue
      const backoffUntil = host.stateFor(trigger.key).backoffUntil
      if (backoffUntil !== undefined && now < backoffUntil) {
        host.logger.info(
          `trigger ${trigger.id}: schedule slot skipped (backoff until ${new Date(backoffUntil).toISOString()})`,
        )
      }
      this._evaluateSchedule(trigger, trigger.source, now)
    }
  }

  private _evaluateSchedule(
    trigger: RoutedTrigger,
    source: ScheduleSourceConfig,
    now: number,
  ): void {
    const host = this._host
    const state = host.stateFor(trigger.key)
    const decision = computeDue(source, state.lastScheduledAt, now, DEFAULT_MISSED_GRACE_MS)
    if (decision.skipped > 0) {
      host.logger.info(
        `trigger ${trigger.id}: skipped ${decision.skipped} missed schedule occurrence(s)`,
      )
    }
    const due = [...decision.due]
    let next = decision.next
    const armed = this._armedSchedule.get(trigger.key)
    if (
      due.length === 0 &&
      armed !== undefined &&
      now >= armed &&
      now - armed <= DEFAULT_MISSED_GRACE_MS
    ) {
      // First wake after enable: `lastScheduledAt` had no previous slot, so the
      // pure decision cannot report this occurrence as due.
      due.push(armed)
      next = computeDue(source, armed, now, DEFAULT_MISSED_GRACE_MS).next
    }

    let lastFired = state.lastScheduledAt
    for (const at of due) {
      const event: TriggerEvent = {
        triggerId: trigger.id,
        key: `schedule:${new Date(at).toISOString()}`,
        payload: {},
        firedAt: at,
      }
      host.logger.info(`trigger ${trigger.id}: schedule event ${event.key}`)
      void host.acceptEvent(trigger, event)
      lastFired = at
    }
    if (lastFired !== state.lastScheduledAt) {
      host.setTriggerState(trigger.key, { lastScheduledAt: lastFired })
    }
    if (next === undefined) {
      this._armedSchedule.delete(trigger.key)
      if (due.length === 0) {
        host.logger.warn(`trigger ${trigger.id}: schedule has no next occurrence`)
      }
    } else {
      this._armedSchedule.set(trigger.key, next)
    }
  }

  private _processDuePolls(now: number): void {
    const host = this._host
    for (const trigger of host.allTriggers()) {
      if (trigger.source.type !== 'poll') continue
      if (!host.isRunnable(trigger, { ignoreBackoff: true })) continue
      // A command that outlives its interval must never overlap itself.
      if (host.pollRunner.isPolling(trigger.key)) continue
      const due = this._nextPoll.get(trigger.key)
      if (due === undefined || due > now) continue
      const backoffUntil = host.stateFor(trigger.key).backoffUntil
      if (backoffUntil !== undefined && now < backoffUntil) {
        // Do not fetch during backoff and do not leave the anchor in the past
        // (that would spin the wake timer); resume at the end of the backoff.
        this._nextPoll.set(trigger.key, backoffUntil)
        host.logger.info(`trigger ${trigger.id}: poll skipped (backoff)`)
        continue
      }
      void host.pollRunner.runPoll(trigger)
    }
  }

  private _onWake(): void {
    if (this._disposed || !this._gateOpen) return
    const now = this._host.clock.now()
    this._processDueSchedules(now)
    this._processDuePolls(now)
    this.rescheduleWake()
  }
}
