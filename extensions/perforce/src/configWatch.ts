/**
 * A configuration-driven apply, registered with the ONE ordering that closes
 * the startup window: it SUBSCRIBES first and READS second.
 *
 * The workspace layer (`<workspace>/.universe-editor/settings.json`) is loaded
 * asynchronously during startup — `UserSettingsSync.initialize()` is
 * fire-and-forget, and its own interface tells consumers to await
 * `whenInitialized` before reading. A consumer that reads first and subscribes
 * afterwards therefore has a window between the two, and a layer landing inside
 * it fires its change event with nobody listening. The consumer keeps the
 * DEFAULT value for the whole session: nothing corrects it, because the layer is
 * loaded once. The failure is silent — the setting simply has no effect — and
 * the twelve-line shape "await read; push subscription" invites it, so every
 * config-driven apply in `activate()` goes through here instead.
 *
 * Subscribing first closes the window arithmetically: a layer loaded before the
 * read is seen BY the read, one loaded after it is seen by the subscription.
 * There is no third instant.
 *
 * `seq` keeps the newest read when two are in flight: reads do their own async
 * work (config lookups, `workspace.fs.stat` round-trips) and could resolve out
 * of order, leaving the consumer on the older value.
 *
 * A watch is created AFTER the first client exists — `apply` walks the live
 * clients, so one created earlier would apply to nobody. A switched workspace
 * re-applies through {@link ConfigWatch.refresh}, which runs the same guard.
 */
import type { Disposable } from '@universe-editor/extension-api'

export interface ConfigWatchSteps<T> {
  /** Read the current value: once at registration, then once per change. */
  read(): Promise<T>
  /** Apply the newest read value to the live consumers. An overtaken read is
   *  dropped unapplied rather than applied late. */
  apply(value: T): void
  /** Observe changes — called BEFORE the first `read` (see the module header). */
  subscribe(onChange: () => void): Disposable
  /** A change-driven read that failed. The initial read's failure rejects
   *  {@link ConfigWatch.ready} instead, so activation still surfaces it. */
  onError?(error: unknown): void
}

export interface ConfigWatch extends Disposable {
  /** The initial read + apply. Rejects when that read fails. */
  readonly ready: Promise<void>
  /** Re-read and re-apply — the switched-workspace path. */
  refresh(): Promise<void>
}

export function watchConfig<T>(steps: ConfigWatchSteps<T>): ConfigWatch {
  let seq = 0
  let disposed = false
  const run = async (): Promise<void> => {
    const mine = ++seq
    const value = await steps.read()
    // A newer read — or a dispose — superseded this one while it was awaited.
    if (disposed || mine !== seq) return
    steps.apply(value)
  }
  const subscription = steps.subscribe(() => {
    // The change path has no caller to await it, so a failed read must not
    // become an unhandled rejection.
    void run().catch((error: unknown) => {
      if (steps.onError) steps.onError(error)
      else console.error('[perforce] config watch: change-driven apply failed', error)
    })
  })
  return {
    ready: run(),
    refresh: run,
    dispose(): void {
      disposed = true
      subscription.dispose()
    },
  }
}
