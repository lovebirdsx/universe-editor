/** Minimal async helpers backing the git auto-refresh chain. */

export type Cancellable = { cancel(): void }

/** A cancellable `setTimeout` as a Promise. */
export function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Debounce a callback: calls within `ms` collapse to one trailing call. */
export function debounce(fn: () => void, ms: number): (() => void) & Cancellable {
  let timer: ReturnType<typeof setTimeout> | undefined
  const wrapped = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      fn()
    }, ms)
  }
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  return wrapped
}

/**
 * Throttle an async task: at most one run in flight, and calls made while a run
 * is active coalesce into at most one trailing run (not dropped, not queued N
 * times). `cancel` drops a pending trailing run.
 */
export function throttle(fn: () => Promise<void>): (() => Promise<void>) & Cancellable {
  let active: Promise<void> | undefined
  let pending = false

  const run = async (): Promise<void> => {
    await fn()
    if (pending) {
      pending = false
      await run()
    }
  }

  const wrapped = (() => {
    if (active) {
      pending = true
      return active
    }
    active = run().finally(() => {
      active = undefined
    })
    return active
  }) as (() => Promise<void>) & Cancellable

  wrapped.cancel = () => {
    pending = false
  }
  return wrapped
}
