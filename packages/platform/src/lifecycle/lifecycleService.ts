/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode workbench lifecycle service.
 *  Source reference: src/vs/workbench/services/lifecycle/common/lifecycleService.ts
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../base/lifecycle.js'
import { Emitter, Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'

export const enum LifecyclePhase {
  /** DI container has just been set up. */
  Starting = 1,
  /** Window is ready to display (but data may not be restored). */
  Ready = 2,
  /** Previously opened editors/state have been restored. */
  Restored = 3,
  /** Fired during idle time after restore. */
  Eventually = 4,
}

/**
 * Why the shutdown sequence was initiated. Participants inspect this to decide
 * whether (and how) to veto — e.g. a running-session guard wants to prompt on
 * Quit / CloseWindow / SwitchWorkspace alike, but can tune the dialog copy.
 */
export const enum ShutdownReason {
  /** The whole application is quitting. */
  Quit = 1,
  /** A single window is being closed. */
  CloseWindow,
  /** The window is reloading (e.g. Restart Editor in dev). */
  Reload,
  /** The workspace folder is being switched/closed in place. */
  SwitchWorkspace,
}

export interface BeforeShutdownEvent {
  /** Why shutdown was initiated. */
  readonly reason: ShutdownReason

  /**
   * Call this to veto the shutdown.
   * @param reason A human-readable string describing why shutdown is being vetoed.
   */
  veto(value: boolean | Promise<boolean>, reason: string): void
}

export interface WillShutdownEvent {
  /**
   * Call to signal that shutdown should wait for an async operation.
   * @param promise The operation to wait for.
   * @param reason A human-readable string identifying the operation.
   */
  join(promise: Promise<void>, reason: string): void
}

export interface ILifecycleService extends IDisposable {
  readonly _serviceBrand: undefined

  /** The current lifecycle phase. Monotonically increasing. */
  readonly phase: LifecyclePhase

  /**
   * Returns a promise that resolves when the given phase (or a later one) has been reached.
   */
  when(phase: LifecyclePhase): Promise<void>

  /** Fires before shutdown begins. Listeners may call event.veto() to cancel. */
  readonly onBeforeShutdown: Event<BeforeShutdownEvent>

  /** Fires when shutdown is confirmed and about to happen. */
  readonly onWillShutdown: Event<WillShutdownEvent>

  /**
   * Runs only the veto phase: fires onBeforeShutdown and awaits all vetos.
   * Does NOT fire onWillShutdown. Used for in-place transitions (e.g. switching
   * workspace) that need confirmation but are not a real shutdown.
   * @returns whether the shutdown was vetoed.
   */
  confirmBeforeShutdown(reason: ShutdownReason): Promise<boolean>

  /**
   * Initiates the shutdown sequence (fires onBeforeShutdown, then onWillShutdown).
   * Resolves when all async join() operations have completed (or timeout).
   * @returns whether the shutdown was vetoed (true → shutdown was cancelled).
   */
  shutdown(reason: ShutdownReason): Promise<boolean>
}

export const ILifecycleService = createDecorator<ILifecycleService>('lifecycleService')

export class LifecycleService extends Disposable implements ILifecycleService {
  declare readonly _serviceBrand: undefined

  private _phase = LifecyclePhase.Starting

  private readonly _phaseResolvers = new Map<
    LifecyclePhase,
    { resolve: () => void; promise: Promise<void> }
  >()

  private readonly _onBeforeShutdown = this._register(new Emitter<BeforeShutdownEvent>())
  private readonly _onWillShutdown = this._register(new Emitter<WillShutdownEvent>())

  readonly onBeforeShutdown = this._onBeforeShutdown.event
  readonly onWillShutdown = this._onWillShutdown.event

  constructor() {
    super()
    // Pre-create phase barriers for all phases
    for (const p of [
      LifecyclePhase.Starting,
      LifecyclePhase.Ready,
      LifecyclePhase.Restored,
      LifecyclePhase.Eventually,
    ] as LifecyclePhase[]) {
      let resolve!: () => void
      const promise = new Promise<void>((r) => (resolve = r))
      this._phaseResolvers.set(p, { resolve, promise })
    }
    // Starting phase is immediately resolved
    this._advanceToPhase(LifecyclePhase.Starting)
  }

  get phase(): LifecyclePhase {
    return this._phase
  }

  private _advanceToPhase(phase: LifecyclePhase): void {
    if (phase < this._phase) {
      throw new Error(`Cannot regress lifecycle phase from ${this._phase} to ${phase}`)
    }
    // Resolve all phases up to and including the target
    for (let p = this._phase; p <= phase; p++) {
      const barrier = this._phaseResolvers.get(p as LifecyclePhase)
      barrier?.resolve()
    }
    this._phase = phase
  }

  /**
   * Advance the lifecycle to the given phase (must be > current).
   */
  setPhase(phase: LifecyclePhase): void {
    if (phase <= this._phase) {
      return
    }
    this._advanceToPhase(phase)
  }

  when(phase: LifecyclePhase): Promise<void> {
    if (phase <= this._phase) {
      return Promise.resolve()
    }
    const barrier = this._phaseResolvers.get(phase)
    if (!barrier) {
      return Promise.resolve()
    }
    return barrier.promise
  }

  async confirmBeforeShutdown(reason: ShutdownReason): Promise<boolean> {
    const vetos: { value: boolean | Promise<boolean>; reason: string }[] = []
    this._onBeforeShutdown.fire({
      reason,
      veto(value, reason) {
        vetos.push({ value, reason })
      },
    })

    for (const { value, reason: vetoReason } of vetos) {
      let result: boolean
      if (typeof value === 'boolean') {
        result = value
      } else {
        try {
          result = await value
        } catch {
          result = false
        }
      }
      if (result) {
        console.info(`[LifecycleService] Shutdown vetoed by: ${vetoReason}`)
        return true
      }
    }
    return false
  }

  async shutdown(reason: ShutdownReason): Promise<boolean> {
    // --- Before shutdown (veto phase) ---
    const vetoed = await this.confirmBeforeShutdown(reason)
    if (vetoed) {
      return true
    }

    // --- Will shutdown (join phase) ---
    const joins: { promise: Promise<void>; reason: string }[] = []
    this._onWillShutdown.fire({
      join(promise, reason) {
        joins.push({ promise, reason })
      },
    })

    if (joins.length > 0) {
      await Promise.allSettled(joins.map((j) => j.promise))
    }
    return false
  }
}

/**
 * Convenience: returns an IDisposable that runs `fn` during the specified lifecycle phase.
 * If the phase has already passed, `fn` is called synchronously.
 */
export function runWhenPhase(
  lifecycle: ILifecycleService,
  phase: LifecyclePhase,
  fn: () => void,
): IDisposable {
  let disposed = false
  lifecycle.when(phase).then(() => {
    if (!disposed) fn()
  })
  return toDisposable(() => {
    disposed = true
  })
}
