/**
 * Activation event helpers shared by host + renderer. An extension declares the
 * events that wake it (`manifest.activationEvents`); the renderer fires
 * `onCommand:<id>` when a contributed command is first invoked, and the host
 * matches an extension's declared events against the fired one.
 *
 * Prefer the {@link ActivationEvents} builders over hand-writing the strings —
 * a typo in `"onComand:..."` silently never activates, and the manifest schema
 * validates against {@link isValidActivationEvent}.
 */

/** Always-on: activate as soon as the extension system starts. */
export const STARTUP_ACTIVATION = '*'
/** Activate after the workbench has finished its initial restore. */
export const STARTUP_FINISHED_ACTIVATION = 'onStartupFinished'

/** The activation event a contributed command triggers on first execution. */
export function commandActivationEvent(commandId: string): string {
  return `onCommand:${commandId}`
}

/** The activation event fired when a document of the given language is first opened. */
export function languageActivationEvent(languageId: string): string {
  return `onLanguage:${languageId}`
}

/** The activation event fired when a contributed view is first revealed. */
export function viewActivationEvent(viewId: string): string {
  return `onView:${viewId}`
}

/** The activation event fired when a custom editor of the given viewType first opens. */
export function customEditorActivationEvent(viewType: string): string {
  return `onCustomEditor:${viewType}`
}

/**
 * Typed builders for the supported activation events. The canonical way to
 * declare activation in a manifest, so ids stay consistent and typo-free.
 *
 * Supported events:
 * - `'*'` — activate on startup (use sparingly; eager).
 * - `'onStartupFinished'` — activate after the workbench restores.
 * - `onCommand(id)` — when a contributed command is first invoked.
 * - `onLanguage(languageId)` — when a document of that language first opens.
 * - `onView(viewId)` — when a contributed view is first revealed.
 * - `onCustomEditor(viewType)` — when a custom editor of that viewType first opens.
 */
export const ActivationEvents = {
  startup: STARTUP_ACTIVATION,
  startupFinished: STARTUP_FINISHED_ACTIVATION,
  onCommand: commandActivationEvent,
  onLanguage: languageActivationEvent,
  onView: viewActivationEvent,
  onCustomEditor: customEditorActivationEvent,
} as const

/** Parameterized activation-event prefixes; each requires a non-empty argument. */
const PARAMETERIZED_PREFIXES = ['onCommand:', 'onLanguage:', 'onView:', 'onCustomEditor:'] as const

/**
 * True when `event` is a supported activation event: the two standalone events
 * (`*` / `onStartupFinished`) or a known `prefix:<arg>` with a non-empty arg.
 * Used by the manifest schema to reject typos that would otherwise silently
 * never activate.
 */
export function isValidActivationEvent(event: string): boolean {
  if (event === STARTUP_ACTIVATION || event === STARTUP_FINISHED_ACTIVATION) return true
  return PARAMETERIZED_PREFIXES.some(
    (prefix) => event.startsWith(prefix) && event.length > prefix.length,
  )
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
