/*---------------------------------------------------------------------------------------------
 *  QuickInputProgress — the indeterminate bar a busy panel paints above its list.
 *
 *  The bar's PAINT is delayed, not the busy state: `busy` still drives the
 *  "Loading…" row on the very first frame, while the bar only appears once the
 *  load has outlasted {@link BUSY_BAR_DELAY_MS}. That is VSCode's calibration
 *  (`quickInput.ts` arms a `TimeoutTimer` for 800ms before calling
 *  `progressBar.infinite()` and cancels it if busy clears first), and it is what
 *  keeps a load served from cache — a p4 changelist, a directory listing, a
 *  debounced quick-open refilter — from flashing an animation for one frame.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, type ReactNode } from 'react'
import styles from './QuickInput.module.css'

/** How long `busy` must hold before the bar is painted (VSCode: 800ms). */
export const BUSY_BAR_DELAY_MS = 800

/**
 * Latch `busy` through a delay: false until `busy` has been true continuously
 * for `delayMs`, and false again on the commit that clears `busy`.
 *
 * The `busy &&` term is load-bearing — the effect resets the latch one commit
 * after the falling edge, so returning the bare latch would leave a stale bar on
 * screen for that frame. The timer is armed in an effect (never during render)
 * because the panel renders throwaway passes through `useDeferredValue`; an
 * effect is also its own unmount cleanup, so no timer can outlive the panel.
 */
export function useDelayedBusy(busy: boolean, delayMs: number = BUSY_BAR_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false)

  useEffect(() => {
    if (!busy) {
      // Without this the latch stays hot and the NEXT busy edge paints instantly.
      setElapsed(false)
      return
    }
    const timer = setTimeout(() => setElapsed(true), delayMs)
    return () => clearTimeout(timer)
  }, [busy, delayMs])

  return busy && elapsed
}

/**
 * The bar itself, or nothing while the load is still young. Mounting (rather
 * than hiding) keeps `data-testid="quick-input-busy"` meaning exactly "a bar is
 * on screen"; the busy state is announced by the list's `aria-busy` instead.
 */
export function QuickInputProgress({ busy }: { busy: boolean }): ReactNode {
  const visible = useDelayedBusy(busy)
  if (!visible) return null
  return (
    <div className={styles['progress']} data-testid="quick-input-busy" aria-hidden="true">
      <div className={styles['progressBar']} />
    </div>
  )
}
