/*---------------------------------------------------------------------------------------------
 *  Test helper: enable DisposableTracker for a single test (or describe block)
 *  and assert no leaks at teardown. Use within a beforeEach/afterEach pair, or
 *  call `withLeakCheck(fn)` to wrap a single test body.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, expect } from 'vitest'
import { DisposableTracker, setDisposableTracker } from '../../base/lifecycle.js'

/** Install a fresh DisposableTracker for each test; assert clean on teardown. */
export function useLeakCheck(): void {
  let tracker: DisposableTracker
  beforeEach(() => {
    tracker = new DisposableTracker()
    setDisposableTracker(tracker)
  })
  afterEach(() => {
    const report = tracker.computeLeakingDisposables()
    setDisposableTracker(null)
    if (report) {
      expect.fail(`Disposable leak detected:\n${report.details}`)
    }
  })
}

/** Wrap a single test body to assert no disposable leaks during its execution. */
export async function withLeakCheck(fn: () => void | Promise<void>): Promise<void> {
  const tracker = new DisposableTracker()
  setDisposableTracker(tracker)
  try {
    await fn()
  } finally {
    const report = tracker.computeLeakingDisposables()
    setDisposableTracker(null)
    if (report) {
      expect.fail(`Disposable leak detected:\n${report.details}`)
    }
  }
}
