/**
 * Activation event helpers shared by host + renderer. An extension declares the
 * events that wake it (`manifest.activationEvents`); the renderer fires
 * `onCommand:<id>` when a contributed command is first invoked, and the host
 * matches an extension's declared events against the fired one.
 */

/** Always-on: activate as soon as the extension system starts. */
export const STARTUP_ACTIVATION = '*'
/** Activate after the workbench has finished its initial restore. */
export const STARTUP_FINISHED_ACTIVATION = 'onStartupFinished'

/** The activation event a contributed command triggers on first execution. */
export function commandActivationEvent(commandId: string): string {
  return `onCommand:${commandId}`
}

/**
 * True when an extension declaring `activationEvents` should wake for `event`.
 * `*` matches every event so a wildcard extension activates on any trigger.
 */
export function matchesActivationEvent(declared: readonly string[], event: string): boolean {
  return (
    declared.includes(event) ||
    (event !== STARTUP_ACTIVATION && declared.includes(STARTUP_ACTIVATION))
  )
}
