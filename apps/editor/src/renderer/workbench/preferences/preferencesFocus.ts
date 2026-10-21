import { ConfigurationTarget } from '@universe-editor/platform'
import { getWorkbenchDocuments } from '../../services/windows/workbenchDocuments.js'

export const SETTINGS_EDITOR_FOCUS_SEARCH_EVENT = 'workbench.preferences.focusSettingsSearch'
export const KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT = 'workbench.preferences.focusKeybindingsSearch'
export const SETTINGS_EDITOR_SWITCH_TARGET_EVENT = 'workbench.preferences.switchSettingsTarget'

/**
 * The settings/keybindings editor can live in any workbench window, and the
 * opener action does not know which one hosts it. Broadcast to every registered
 * document; each mounted editor listens on its own document only. Events are
 * constructed from the target document's realm — a main-realm Event is not an
 * `Event` in an auxiliary window's WebIDL.
 */
function dispatchPreferencesEvent(name: string, detail?: ConfigurationTarget): void {
  queueMicrotask(() => {
    const docs = getWorkbenchDocuments()
    const targets = docs.length > 0 ? docs : typeof document === 'undefined' ? [] : [document]
    for (const doc of targets) {
      const view = doc.defaultView
      const event =
        detail === undefined
          ? new (view?.Event ?? Event)(name)
          : new (view?.CustomEvent ?? CustomEvent)(name, { detail })
      doc.dispatchEvent(event)
    }
  })
}

export function dispatchSettingsEditorFocusSearch(): void {
  dispatchPreferencesEvent(SETTINGS_EDITOR_FOCUS_SEARCH_EVENT)
}

// The microtask event only reaches an already-mounted keybindings editor (the
// "reuse open tab" path). A freshly opened editor mounts after the event fired,
// so the query also travels through this slot, consumed once on mount.
let pendingKeybindingsQuery: string | undefined

export function dispatchKeybindingsEditorFocusSearch(query?: string): void {
  pendingKeybindingsQuery = query
  dispatchPreferencesEvent(KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT)
}

export function consumePendingKeybindingsSearchQuery(): string | undefined {
  const query = pendingKeybindingsQuery
  pendingKeybindingsQuery = undefined
  return query
}

export function dispatchSettingsEditorSwitchTarget(
  target: ConfigurationTarget.User | ConfigurationTarget.Project,
): void {
  dispatchPreferencesEvent(SETTINGS_EDITOR_SWITCH_TARGET_EVENT, target)
}
