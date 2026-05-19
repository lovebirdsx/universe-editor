import { ConfigurationTarget } from '@universe-editor/platform'

export const SETTINGS_EDITOR_FOCUS_SEARCH_EVENT = 'workbench.preferences.focusSettingsSearch'
export const KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT = 'workbench.preferences.focusKeybindingsSearch'
export const SETTINGS_EDITOR_SWITCH_TARGET_EVENT = 'workbench.preferences.switchSettingsTarget'

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

export function dispatchSettingsEditorSwitchTarget(
  target: ConfigurationTarget.User | ConfigurationTarget.Project,
): void {
  queueMicrotask(() => {
    document.dispatchEvent(
      new CustomEvent<ConfigurationTarget>(SETTINGS_EDITOR_SWITCH_TARGET_EVENT, {
        detail: target,
      }),
    )
  })
}
