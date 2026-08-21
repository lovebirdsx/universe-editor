/**
 * Process-level unexpected-error hook for the extension host (VSCode's
 * ErrorHandler.installEarlyHandler). Any error reported through platform
 * `onUnexpectedError` gets a stderr line (main persists host stderr to
 * extensionHost.log) and — once the MainThreadExtensions channel is wired — a
 * serialized copy pushed up so the renderer's own `onUnexpectedError` can land
 * it in errors.jsonl (telemetry + the cancellation filter both apply there).
 *
 * Also installs a narrow in-process entry so built-in extensions (same process,
 * same trust boundary) can route process-level fatal forensics — e.g. a
 * language-server OOM — through the same path. Not part of the public extension
 * API; extensions/typescript reads it via {@link BUILTIN_UNEXPECTED_ERROR_KEY}.
 */
import {
  onUnexpectedError,
  setUnexpectedErrorHandler,
  transformErrorForSerialization,
  type SerializedError,
} from '@universe-editor/platform'

/** Global key exposing `onUnexpectedError` to in-process built-in extensions.
 *  KEEP IN SYNC with the reader in `extensions/typescript/src/lspClient.ts`. */
export const BUILTIN_UNEXPECTED_ERROR_KEY = '__universeReportUnexpectedError__'

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

export interface UnexpectedErrorReporter {
  /** Wire the RPC push once the MainThreadExtensions channel is live. */
  setReport(report: ((error: SerializedError) => void) | undefined): void
}

export function installUnexpectedErrorHandler(): UnexpectedErrorReporter {
  let report: ((error: SerializedError) => void) | undefined
  // The handler runs synchronously inside `onUnexpectedError`; if the stderr
  // line or the RPC push re-enters it (a throwing report routed back through
  // onUnexpectedError), this flag stops the recursion.
  let reporting = false

  setUnexpectedErrorHandler((err) => {
    try {
      console.error(`[ext-host] unexpected error: ${formatUnknownError(err)}`)
    } catch {
      // the stderr line must never re-enter onUnexpectedError
    }
    if (reporting || report === undefined) return
    reporting = true
    try {
      report(transformErrorForSerialization(err))
    } catch (e) {
      console.warn(`[ext-host] failed to report unexpected error: ${formatUnknownError(e)}`)
    } finally {
      reporting = false
    }
  })
  ;(globalThis as Record<string, unknown>)[BUILTIN_UNEXPECTED_ERROR_KEY] = onUnexpectedError

  return {
    setReport(next) {
      report = next
    },
  }
}
