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
  IFileService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IUserDataFilesService,
  MenuId,
  Severity,
  URI,
  UserDataFile,
  isEqualResource,
  localize,
  localize2,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  DISPLAY_LANGUAGE_SETTING_KEY,
  type DisplayLanguageSetting,
  type ILocaleOption,
} from '../../shared/i18n/availableLocales.js'
import { SettingsEditorInput } from '../services/editor/SettingsEditorInput.js'
import { KeybindingsEditorInput } from '../services/editor/KeybindingsEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import {
  dispatchKeybindingsEditorFocusSearch,
  dispatchSettingsEditorFocusSearch,
  dispatchSettingsEditorSwitchTarget,
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
  services: {
    files: IUserDataFilesService
    groups: IEditorGroupsService
    instantiation: IInstantiationService
  },
  file: UserDataFile,
  template: string,
  options?: { readOnly?: boolean; seedTemplate?: boolean },
): Promise<void> {
  const { files, groups, instantiation } = services

  const uriComponents = await files.getFileUri(file)
  if (!uriComponents) return
  const uri = URI.revive(uriComponents) as URI

  // Seed the file with a template if it doesn't exist yet, so users see useful
  // scaffolding instead of an empty buffer. Skipped for files we don't own
  // (e.g. the VS Code keybindings) — we never overwrite those with our template.
  if (options?.seedTemplate ?? true) {
    const text = await files.read(file)
    if (text === '') {
      await files.write(file, template)
    }
  }

  // De-dupe: if already open, reactivate.
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor instanceof FileEditorInput && isEqualResource(editor.resource, uri)) {
        groups.activateGroup(group)
        group.setActive(editor)
        return
      }
    }
  }

  const input = instantiation.createInstance(FileEditorInput, uri)
  if (options?.readOnly) input.markReadonly()
  groups.activeGroup.openEditor(input)
}

function userDataFileServices(accessor: ServicesAccessor): {
  files: IUserDataFilesService
  groups: IEditorGroupsService
  instantiation: IInstantiationService
} {
  return {
    files: accessor.get(IUserDataFilesService),
    groups: accessor.get(IEditorGroupsService),
    instantiation: accessor.get(IInstantiationService),
  }
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
      title: localize2('action.openSettings.title', 'Open Settings'),
      category: localize2('command.category.preferences', 'Preferences'),
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
      title: localize2('action.openKeybindings.title', 'Open Keyboard Shortcuts'),
      category: localize2('command.category.preferences', 'Preferences'),
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
      title: localize2('action.openSettingsJson.title', 'Open Settings (JSON)'),
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void openUserDataFile(
      userDataFileServices(accessor),
      UserDataFile.Settings,
      SETTINGS_JSON_TEMPLATE,
    )
  }
}

export class OpenKeybindingsJsonAction extends Action2 {
  static readonly ID = 'workbench.action.openKeybindingsJson'
  constructor() {
    super({
      id: OpenKeybindingsJsonAction.ID,
      title: localize2('action.openKeybindingsJson.title', 'Open Keyboard Shortcuts (JSON)'),
      keybinding: { primary: ['ctrl+k', 'ctrl+k'] },
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void openUserDataFile(
      userDataFileServices(accessor),
      UserDataFile.Keybindings,
      KEYBINDINGS_JSON_TEMPLATE,
    )
  }
}

export class OpenVSCodeKeybindingsJsonAction extends Action2 {
  static readonly ID = 'workbench.action.openVSCodeKeybindingsJson'
  constructor() {
    super({
      id: OpenVSCodeKeybindingsJsonAction.ID,
      title: localize2(
        'action.openVSCodeKeybindingsJson.title',
        'Open VS Code Keyboard Shortcuts (JSON)',
      ),
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = userDataFileServices(accessor)
    const fileService = accessor.get(IFileService)
    const notification = accessor.get(INotificationService)

    const uriComponents = await services.files.getFileUri(UserDataFile.VSCodeKeybindings)
    if (uriComponents && (await fileService.exists(URI.revive(uriComponents) as URI))) {
      // Open editable (not read-only) so users can change VS Code's own
      // keybindings; never seed our template into VS Code's file.
      await openUserDataFile(services, UserDataFile.VSCodeKeybindings, '', { seedTemplate: false })
      return
    }

    notification.notify({
      severity: Severity.Warning,
      message: localize(
        'action.openVSCodeKeybindingsJson.notFound',
        'No VS Code keybindings file found (VS Code may not be installed).',
      ),
    })
  }
}

export class OpenVSCodeSettingsJsonAction extends Action2 {
  static readonly ID = 'workbench.action.openVSCodeSettingsJson'
  constructor() {
    super({
      id: OpenVSCodeSettingsJsonAction.ID,
      title: localize2('action.openVSCodeSettingsJson.title', 'Open VS Code Settings (JSON)'),
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const services = userDataFileServices(accessor)
    const fileService = accessor.get(IFileService)
    const notification = accessor.get(INotificationService)

    const uriComponents = await services.files.getFileUri(UserDataFile.VSCodeUserSettings)
    if (uriComponents && (await fileService.exists(URI.revive(uriComponents) as URI))) {
      // Open editable (not read-only) so users can change VS Code's own
      // settings; never seed our template into VS Code's file.
      await openUserDataFile(services, UserDataFile.VSCodeUserSettings, '', { seedTemplate: false })
      return
    }

    notification.notify({
      severity: Severity.Warning,
      message: localize(
        'action.openVSCodeSettingsJson.notFound',
        'No VS Code settings file found (VS Code may not be installed).',
      ),
    })
  }
}

export class ConfigureDisplayLanguageAction extends Action2 {
  static readonly ID = 'workbench.action.configureDisplayLanguage'
  constructor() {
    super({
      id: ConfigureDisplayLanguageAction.ID,
      title: localize2('action.configureDisplayLanguage.title', 'Configure Display Language'),
      category: localize2('command.category.preferences', 'Preferences'),
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

export class OpenWorkspaceSettingsAction extends Action2 {
  static readonly ID = 'workbench.action.openWorkspaceSettings'
  constructor() {
    super({
      id: OpenWorkspaceSettingsAction.ID,
      title: localize2('action.openWorkspaceSettings.title', 'Open Workspace Settings'),
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)

    // If Settings editor already open, activate it and switch to Workspace tab.
    for (const group of groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof SettingsEditorInput) {
          groups.activateGroup(group)
          group.setActive(editor)
          dispatchSettingsEditorSwitchTarget(ConfigurationTarget.Project)
          return
        }
      }
    }

    const input = new SettingsEditorInput()
    input.switchTarget(ConfigurationTarget.Project)
    groups.activeGroup.openEditor(input)
    dispatchSettingsEditorSwitchTarget(ConfigurationTarget.Project)
  }
}

export class OpenWorkspaceSettingsJsonAction extends Action2 {
  static readonly ID = 'workbench.action.openWorkspaceSettingsJson'
  constructor() {
    super({
      id: OpenWorkspaceSettingsJsonAction.ID,
      title: localize2('action.openWorkspaceSettingsJson.title', 'Open Workspace Settings (JSON)'),
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void openUserDataFile(
      userDataFileServices(accessor),
      UserDataFile.ProjectSettings,
      SETTINGS_JSON_TEMPLATE,
    )
  }
}

const COLOR_THEME_SETTING_KEY = 'workbench.colorTheme'
type WorkbenchColorTheme = 'dark' | 'light'

interface ColorThemePickItem extends IQuickPickItem {
  readonly value: WorkbenchColorTheme
}

export class SelectColorThemeAction extends Action2 {
  static readonly ID = 'workbench.action.selectTheme'
  constructor() {
    super({
      id: SelectColorThemeAction.ID,
      title: localize2('action.selectTheme.title', 'Color Theme'),
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const configuration = accessor.get(IConfigurationService)

    const current = configuration.get<WorkbenchColorTheme>(COLOR_THEME_SETTING_KEY) ?? 'dark'

    const currentLabel = localize('colorTheme.current', '(current)')
    const items: ColorThemePickItem[] = [
      {
        id: 'dark',
        label: localize('colorTheme.dark', 'Dark'),
        ...(current === 'dark' && { description: currentLabel }),
        value: 'dark',
      },
      {
        id: 'light',
        label: localize('colorTheme.light', 'Light'),
        ...(current === 'light' && { description: currentLabel }),
        value: 'light',
      },
    ]

    const selected = await quickInput.pick(items, {
      id: 'workbench.colorTheme',
      placeholder: localize('quickInput.colorTheme.placeholder', 'Select Color Theme'),
    })
    if (!selected) return

    configuration.update(COLOR_THEME_SETTING_KEY, selected.value, ConfigurationTarget.User)
  }
}
