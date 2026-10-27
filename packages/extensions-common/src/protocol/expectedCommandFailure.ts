/**
 * Wire-level marker for failures the caller already handles itself (background
 * polls, auto-refresh, restored views). The renderer classifies these as benign:
 * it logs them at warn and never treats them as unexpected errors, so a routine
 * network timeout cannot trip the global error toast or auto-reveal the Output
 * panel.
 *
 * Only `name` / `message` / `code` survive the extension-host RPC boundary
 * (`packages/platform/src/ipc/ipc.ts`), so the marker must stay a stable `name`
 * rather than an error subclass identity.
 */
export const EXPECTED_COMMAND_FAILURE_NAME = 'ExpectedCommandFailure'

/** Rebuild `err` under {@link EXPECTED_COMMAND_FAILURE_NAME}, preserving its
 *  machine-readable `code` for diagnostics. */
export function markExpectedCommandFailure(err: unknown): Error {
  const marked = new Error(err instanceof Error ? err.message : String(err)) as Error & {
    code?: string | number
  }
  marked.name = EXPECTED_COMMAND_FAILURE_NAME
  const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined
  if (typeof code === 'string' || typeof code === 'number') marked.code = code
  return marked
}
