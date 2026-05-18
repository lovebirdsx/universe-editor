/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Preferences-related Action2 commands.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  IConfigurationService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  IQuickInputService,
  IUserDataFilesService,
  MenuId,
  URI,
  UserDataFile,
  localize,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  DISPLAY_LANGUAGE_SETTING_KEY,
  type DisplayLanguageSetting,
  type ILocaleOption,
} from '../../shared/i18n/availableLocales.js'
import { SettingsEditorInput } from '../workbench/preferences/SettingsEditorInput.js'
import { KeybindingsEditorInput } from '../workbench/keybindings/KeybindingsEditorInput.js'
import { FileEditorInput } from '../workbench/editor/FileEditorInput.js'
import {
  dispatchKeybindingsEditorFocusSearch,
  dispatchSettingsEditorFocusSearch,
} from '../workbench/preferences/preferencesFocus.js'

const SETTINGS_JSON_TEMPLATE = `// User settings — edit and save to apply immediately.
// Available keys are declared by ConfigurationRegistry.
{}
`

const KEYBINDINGS_JSON_TEMPLATE = `// User keybinding overrides — edit and save to apply immediately.
// Format: [{ "key": "ctrl+shift+b", "command": "workbench.action.foo", "when": "..." }]
// Prefix command with "-" to disable a default binding, e.g. "-workbench.action.foo".
[]
`

async function openUserDataFile(
  accessor: ServicesAccessor,
  file: UserDataFile,
  template: string,
): Promise<void> {
  const files = accessor.get(IUserDataFilesService)
  const groups = accessor.get(IEditorGroupsService)
  const instantiation = accessor.get(IInstantiationService)

  const uriComponents = await files.getFileUri(file)
  if (!uriComponents) return
  const uri = URI.revive(uriComponents) as URI

  // Seed the file with a template if it doesn't exist yet, so users see useful
  // scaffolding instead of an empty buffer.
  const text = await files.read(file)
  if (text === '') {
    await files.write(file, template)
  }

  // De-dupe: if already open, reactivate.
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor instanceof FileEditorInput && editor.resource.toString() === uri.toString()) {
        groups.activateGroup(group)
        group.setActive(editor)
        return
      }
    }
  }

  const input = instantiation.createInstance(FileEditorInput, uri)
  groups.activeGroup.openEditor(input)
}

interface DisplayLanguagePickItem extends IQuickPickItem {
  readonly value: DisplayLanguageSetting
}

function getDisplayLanguageOptions(): ILocaleOption[] {
  return [
    {
      value: 'auto',
      label: localize('settings.enum.auto', 'Use System Language'),
      description: localize(
        'quickInput.displayLanguage.auto.description',
        'Use the operating system display language.',
      ),
    },
    {
      value: 'en-US',
      label: localize('settings.enum.en-US', 'English'),
      description: localize(
        'quickInput.displayLanguage.en-US.description',
        'Display the editor UI in English.',
      ),
    },
    {
      value: 'zh-CN',
      label: localize('settings.enum.zh-CN', 'Simplified Chinese'),
      description: localize(
        'quickInput.displayLanguage.zh-CN.description',
        'Display the editor UI in Simplified Chinese.',
      ),
    },
  ]
}

export class OpenSettingsAction extends Action2 {
  static readonly ID = 'workbench.action.openSettings'
  constructor() {
    super({
      id: OpenSettingsAction.ID,
      title: localize('action.openSettings.title', 'Open Settings'),
      category: localize('command.category.preferences', 'Preferences'),
      keybinding: [{ primary: 'ctrl+,' }],
      menu: { id: MenuId.MenubarFileMenu, group: '5_preferences', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)

    // De-dupe: if Settings is already open in any group, reactivate it instead
    // of opening a second copy.
    for (const group of groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof SettingsEditorInput) {
          groups.activateGroup(group)
          group.setActive(editor)
          dispatchSettingsEditorFocusSearch()
          return
        }
      }
    }

    groups.activeGroup.openEditor(new SettingsEditorInput())
    dispatchSettingsEditorFocusSearch()
  }
}

export class OpenKeybindingsEditorAction extends Action2 {
  static readonly ID = 'workbench.action.openGlobalKeybindings'
  constructor() {
    super({
      id: OpenKeybindingsEditorAction.ID,
      title: localize('action.openKeybindings.title', 'Open Keyboard Shortcuts'),
      category: localize('command.category.preferences', 'Preferences'),
      keybinding: { primary: ['ctrl+k', 'ctrl+s'] },
      menu: { id: MenuId.MenubarFileMenu, group: '5_preferences', order: 2 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)

    for (const group of groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof KeybindingsEditorInput) {
          groups.activateGroup(group)
          group.setActive(editor)
          dispatchKeybindingsEditorFocusSearch()
          return
        }
      }
    }

    groups.activeGroup.openEditor(new KeybindingsEditorInput())
    dispatchKeybindingsEditorFocusSearch()
  }
}

export class OpenSettingsJsonAction extends Action2 {
  static readonly ID = 'workbench.action.openSettingsJson'
  constructor() {
    super({
      id: OpenSettingsJsonAction.ID,
      title: localize('action.openSettingsJson.title', 'Open Settings (JSON)'),
      category: localize('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void openUserDataFile(accessor, UserDataFile.Settings, SETTINGS_JSON_TEMPLATE)
  }
}

export class OpenKeybindingsJsonAction extends Action2 {
  static readonly ID = 'workbench.action.openKeybindingsJson'
  constructor() {
    super({
      id: OpenKeybindingsJsonAction.ID,
      title: localize('action.openKeybindingsJson.title', 'Open Keyboard Shortcuts (JSON)'),
      category: localize('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void openUserDataFile(accessor, UserDataFile.Keybindings, KEYBINDINGS_JSON_TEMPLATE)
  }
}

export class ConfigureDisplayLanguageAction extends Action2 {
  static readonly ID = 'workbench.action.configureDisplayLanguage'
  constructor() {
    super({
      id: ConfigureDisplayLanguageAction.ID,
      title: localize('action.configureDisplayLanguage.title', 'Configure Display Language'),
      category: localize('command.category.preferences', 'Preferences'),
      menu: { id: MenuId.MenubarFileMenu, group: '5_preferences', order: 3 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const dialog = accessor.get(IDialogService)
    const configuration = accessor.get(IConfigurationService)

    const items: DisplayLanguagePickItem[] = getDisplayLanguageOptions().map((option) => ({
      id: option.value,
      label: option.label,
      description: option.description,
      value: option.value,
    }))

    const selected = await quickInput.pick(items, {
      id: 'workbench.displayLanguage',
      placeholder: localize('quickInput.displayLanguage.placeholder', 'Select Display Language'),
    })
    if (!selected) return

    configuration.update(DISPLAY_LANGUAGE_SETTING_KEY, selected.value, ConfigurationTarget.User)

    await dialog.confirm({
      message: localize('dialog.displayLanguage.message', 'Display language updated.'),
      detail: localize(
        'dialog.displayLanguage.detail',
        'Restart the application to apply the selected display language.',
      ),
      primaryButton: localize('common.ok', 'OK'),
      cancelButton: localize('common.close', 'Close'),
    })
  }
}
