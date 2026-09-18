/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tells the user when this window's memory has been high long enough that the releasers
 *  are demonstrably not fixing it, and offers the one action that can still produce a
 *  diagnosis: reload, then take a baseline while the heap is small.
 *
 *  Why reload rather than start in place: a baseline has to be captured on a small heap
 *  (`min(512MiB, cap/2)` in the main-side policy). By the time the heap is worth a
 *  reminder it is far past that, so starting where we stand would either be refused or
 *  force the protection to be loosened — and the growth snapshot would have no clean
 *  reference to measure against. Reloading returns the heap to its clean value, and the
 *  round then runs exactly as designed.
 *
 *  Same window only, same as the command it drives: main filters round reports per window.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ICommandService,
  ILoggerService,
  INotificationService,
  Severity,
  createNamedLogger,
  localize,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'
import { IDiagnosticsService, type HeapSnapshotStatus } from '../../shared/ipc/services.js'
import { ReloadWindowForMemoryDiagnosisAction } from '../actions/helpActions.js'
import {
  consumeReloadArmIntent,
  readReminderCooldownAt,
  rendererSessionStorage,
  writeReminderCooldownAt,
  type SessionStorageLike,
} from '../services/diagnostics/diagnosisReloadSession.js'
import {
  IMemoryPressureService,
  type MemoryPressureSample,
} from '../services/memory/memoryPressureService.js'
import { memoryReminderE2E } from '../services/memory/memoryReminderE2E.js'
import {
  INITIAL_MEMORY_REMINDER_STATE,
  estimateSnapshotPauseSeconds,
  markReminded,
  reduceMemoryReminder,
  type MemoryReminderDecision,
  type MemoryReminderInput,
  type MemoryReminderState,
} from '../services/memory/memoryReminderPolicy.js'

/**
 * How long a reminder is held back once we know the user is already running a diagnosis.
 * The condition that produced the reminder (a high heap that will not come down) is exactly
 * the condition the running round is investigating, so the answer is to wait it out rather
 * than to interrupt a diagnosis with an offer to start one.
 */
const REMINDER_DEFER_MS = 5 * 60_000

/**
 * How long the "a reminder is being put on screen" latch may hold. It only has to cover one
 * trivial IPC call, so this is generous — but it has to be *something*: without a deadline a
 * status read that never settles would mute this window's reminders for the rest of its life,
 * silently, which is the failure the whole contribution exists to prevent.
 */
const REMINDER_LATCH_MS = 5_000

export class MemoryReminderContribution extends Disposable implements IWorkbenchContribution {
  private _state: MemoryReminderState
  private readonly _storage: SessionStorageLike | undefined
  private readonly _logger: ILogger
  private readonly _e2e: boolean
  /** This renderer's reminder, while one is on screen. */
  private _reminderId: string | undefined
  /**
   * Guards the async gap between deciding to remind and the notification existing. A
   * deadline rather than a flag, so a status read that never comes back cannot latch it.
   */
  private _latchUntil = 0
  /** No reminders before this instant; set when a diagnosis round is already running. */
  private _deferUntil = 0
  /** Set by an E2E replay: live readings stop feeding the policy. */
  private _e2eDriven = false
  /** `Disposable` exposes no readable state, and the async paths below outlive disposal. */
  private _disposed = false

  constructor(
    @IMemoryPressureService private readonly _pressure: IMemoryPressureService,
    @INotificationService private readonly _notifications: INotificationService,
    @ICommandService private readonly _commands: ICommandService,
    @IDiagnosticsService private readonly _diagnostics: IDiagnosticsService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'memory', name: 'Memory' })
    this._e2e = typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true
    this._storage = rendererSessionStorage()
    this._state = {
      ...INITIAL_MEMORY_REMINDER_STATE,
      // The half of the anti-harassment rule that has to survive a reload: `reminded`
      // below dies with this renderer, so without this a reload would be a way to be
      // asked again.
      lastRemindedAt: readReminderCooldownAt(this._storage, Date.now()),
    }

    this._register(this._pressure.onDidSample((sample) => this._onSample(sample)))
    if (this._e2e) this._installE2E()
    // Fire-and-forget: the reload already happened by the time this runs, and a failure
    // here is reported through the notification itself rather than by throwing into
    // whichever contribution registry instantiated this.
    void this._armFromReloadIntent()
  }

  private _onSample(sample: MemoryPressureSample): void {
    if (this._e2eDriven) return
    this._observe({ at: Date.now(), level: sample.level, used: sample.used })
  }

  private _observe(input: MemoryReminderInput): void {
    const decision = reduceMemoryReminder(this._state, input)
    this._state = decision.state
    if (this._e2e) memoryReminderE2E.decisions.push(decision)
    if (!decision.remind) return
    // A round is already running: keep folding readings into the state (so the stretch
    // stays measured) but do not spend the window's one reminder on an offer the user has
    // already acted on.
    if (input.at < this._deferUntil) return
    void this._remind(input, decision)
  }

  private async _remind(
    input: MemoryReminderInput,
    decision: MemoryReminderDecision,
  ): Promise<void> {
    const now = Date.now()
    if (now < this._latchUntil || this._reminderId !== undefined) return
    this._latchUntil = now + REMINDER_LATCH_MS
    try {
      let running = false
      try {
        running = (await this._diagnostics.getHeapSnapshotStatus()).active
      } catch (err) {
        // A failed reading is not evidence of a round: failing towards "ask" costs one
        // reminder the user can dismiss, failing towards "stay silent" costs the whole
        // feature on a build whose diagnostics channel is broken.
        this._logger.debug(
          `[memory] reminder status check failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (this._disposed) return
      if (running) {
        this._deferUntil = input.at + REMINDER_DEFER_MS
        this._logger.info('[memory] reminder deferred: a diagnosis round is already running')
        return
      }
      if (this._reminderId !== undefined) return

      const seconds = String(estimateSnapshotPauseSeconds(decision.used ?? input.used))
      const minutes = String(Math.max(1, Math.round((decision.sustainedMs ?? 0) / 60_000)))
      const handle = this._notifications.notify({
        severity: Severity.Warning,
        // Sticky: the offer to restart is worthless if it slides away while the user
        // reads what it costs.
        sticky: true,
        // One paragraph, on purpose. The toast renders this into a `<p>` with a ~5-line cap
        // (`NotificationsToast.module.css`), so a `\n\n` would collapse into a space *and*
        // bury the warning — and this text is the only consent this path gets, since the
        // button behind it opens no dialog. The cost therefore comes first, before anything
        // the user might scroll past.
        message: localize(
          'memoryReminder.message',
          'This window has been near its memory limit for {minutes} minutes and releasing caches has not brought it down. Reload now and the memory diagnosis starts over from a clean baseline — but the reload discards unsaved changes, and taking the first snapshot about a minute later pauses this window for up to about {seconds} seconds. That pause is expected, not a crash. Only this window is diagnosed; the snapshot holds whatever its heap held, which may include file contents or session text; it is written to this machine only and never uploaded automatically.',
          { minutes, seconds },
        ),
        actions: [
          {
            label: localize('memoryReminder.action.reload', 'Reload and Start Diagnosis'),
            run: () => this._reloadAndDiagnose(),
          },
          {
            label: localize('memoryReminder.action.notNow', 'Not Now'),
            run: () => this._dismissReminder(),
          },
        ],
      })
      this._reminderId = handle.id
      // Committed only now that the notification really exists — a reminder that was
      // decided but never shown must not consume the window's one chance.
      this._state = markReminded(this._state, input.at)
      writeReminderCooldownAt(this._storage, input.at)
      this._logger.info(
        `[memory] reminder shown: ${describeInput(input)}${decision.sustainedMs === undefined ? '' : ` sustained=${Math.round(decision.sustainedMs / 60_000)}min`}`,
      )
    } finally {
      this._latchUntil = 0
    }
  }

  private _reloadAndDiagnose(): void {
    this._dismissReminder()
    // Through the command, not around it: that command runs the shutdown veto chain and
    // writes the one-shot intent the next renderer reads. Reimplementing it here would
    // give the toast a second, subtly different path to the same destructive action.
    void this._commands.executeCommand(ReloadWindowForMemoryDiagnosisAction.ID).catch(() => {
      // CommandService already logged and recorded the failure; swallowing it here only
      // keeps the rejection from being reported a second time by the global handler.
    })
  }

  private _dismissReminder(): void {
    const id = this._reminderId
    this._reminderId = undefined
    if (id !== undefined) this._notifications.dismiss(id)
  }

  /**
   * The other half of "reload and start the diagnosis": the reload has happened, this is
   * the renderer that came back, and sessionStorage says the user asked for a round.
   *
   * No consent dialog here on purpose — the reminder's own text was the consent, and it
   * said what the dialog says: what is captured, that the window pauses, that the artifact
   * may contain anything the heap held, and that it stays on this machine. Asking twice
   * would train the user to click through the one that matters.
   */
  private async _armFromReloadIntent(): Promise<void> {
    const intent = consumeReloadArmIntent(this._storage, Date.now())
    if (!intent.armed) {
      // Only worth a line when the user did ask: the round silently not starting is the one
      // outcome nobody can see from the outside. Nothing asked for a round here, so nothing
      // is missing.
      if (intent.reason === 'expired') {
        this._logger.warn(
          '[memory] the reload intent expired before this renderer was ready; no diagnosis was started',
        )
      }
      return
    }
    this._logger.info('[memory] reload intent consumed: arming the memory diagnosis')
    let status: HeapSnapshotStatus
    try {
      status = await this._diagnostics.startHeapSnapshotRound()
    } catch (err) {
      this._reportArmFailure(err instanceof Error ? err.message : String(err))
      return
    }
    if (this._disposed) return
    if (status.phase === 'off') {
      this._notifications.notify({
        severity: Severity.Error,
        message: localize(
          'memoryReminder.armUnavailable',
          'The window reloaded, but memory diagnosis is not available in this build, so nothing was started.',
        ),
      })
      return
    }
    if (!status.active) {
      // The window reloaded for nothing: main refused the round (the app-wide capture budget
      // is spent, or this window has no live renderer). The user is told by the round's own
      // `stopped` event, which the diagnostics contribution renders — so this is only the
      // log telling the truth, because "armed" here would be a lie the next reader believes.
      this._logger.warn(
        `[memory] memory diagnosis refused after reload phase=${status.phase} code=${status.code ?? '-'} detail=${status.detail ?? '-'}`,
      )
      return
    }
    // The round reports itself from here on: `started` reaches the user through the
    // contribution that renders round events, so this only records the handoff.
    this._logger.info(`[memory] memory diagnosis armed after reload phase=${status.phase}`)
  }

  private _reportArmFailure(message: string): void {
    if (this._disposed) return
    this._logger.warn(`[memory] could not arm the diagnosis after reload: ${message}`)
    this._notifications.notify({
      severity: Severity.Error,
      message: localize(
        'memoryReminder.armFailed',
        'The window reloaded, but the memory diagnosis could not be started: {message}',
        { message },
      ),
    })
  }

  private _installE2E(): void {
    memoryReminderE2E.drive = (samples) => {
      this._e2eDriven = true
      this._deferUntil = 0
      memoryReminderE2E.decisions.length = 0
      // A spec starts from a window that has never been reminded; the cooldown that would
      // otherwise suppress it is written by a previous run of the same spec.
      this._state = { ...INITIAL_MEMORY_REMINDER_STATE }
      const base = Date.now()
      for (const sample of samples) {
        this._observe({ at: base + sample.afterMs, level: sample.level, used: sample.usedBytes })
      }
    }
    memoryReminderE2E.readState = () => this._state
  }

  override dispose(): void {
    this._disposed = true
    this._dismissReminder()
    super.dispose()
  }
}

function describeInput(input: MemoryReminderInput): string {
  return `used=${Math.round(input.used / (1024 * 1024))}MB level=${input.level}`
}
