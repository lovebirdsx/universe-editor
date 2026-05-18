export const SETTINGS_EDITOR_FOCUS_SEARCH_EVENT = 'workbench.preferences.focusSettingsSearch'
export const KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT =
  'workbench.preferences.focusKeybindingsSearch'

function dispatchPreferencesFocusEvent(eventName: string): void {
  queueMicrotask(() => {
    document.dispatchEvent(new Event(eventName))
  })
}

export function dispatchSettingsEditorFocusSearch(): void {
  dispatchPreferencesFocusEvent(SETTINGS_EDITOR_FOCUS_SEARCH_EVENT)
}

export function dispatchKeybindingsEditorFocusSearch(): void {
  dispatchPreferencesFocusEvent(KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT)
}
