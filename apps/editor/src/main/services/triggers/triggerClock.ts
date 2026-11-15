/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Injectable clock for the trigger scheduler. Every timer and every "now" in main
 *  goes through this so tests can run on the same fake clock as the service.
 *--------------------------------------------------------------------------------------------*/

export type TriggerTimerHandle = unknown

export interface TriggerClock {
  now(): number
  setTimeout(callback: () => void, ms: number): TriggerTimerHandle
  clearTimeout(handle: TriggerTimerHandle): void
}

export const systemTriggerClock: TriggerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Detach a timer from the event loop where the host supports it (Node timers). */
export function unrefTimer(handle: TriggerTimerHandle): void {
  ;(handle as { unref?: () => void } | undefined)?.unref?.()
}
