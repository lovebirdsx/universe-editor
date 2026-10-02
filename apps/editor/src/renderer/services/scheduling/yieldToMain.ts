/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Hand the main thread back between slices of long synchronous work (large
 *  mappings, scans): the caller splits its loop and awaits this between
 *  slices, so a pending input event / paint runs before the next slice.
 *
 *  `scheduler.yield()` where available (Chromium: the continuation rejoins the
 *  task queue ahead of normal timers); otherwise a zero-delay timeout, which is
 *  a real macrotask boundary everywhere. A microtask (resolved promise) would
 *  NOT do — it yields to other continuations, not to rendering or input.
 *--------------------------------------------------------------------------------------------*/

export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return scheduler?.yield?.() ?? new Promise((resolve) => setTimeout(resolve, 0))
}
