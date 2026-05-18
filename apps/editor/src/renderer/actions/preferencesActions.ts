/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Preferences-related Action2 commands.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IInstantiationService,
  IUserDataFilesService,
  MenuId,
  URI,
  UserDataFile,
  type ServicesAccessor,
} from '@universe-editor/platform'
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

export class OpenSettingsAction extends Action2 {
  static readonly ID = 'workbench.action.openSettings'
  constructor() {
    super({
      id: OpenSettingsAction.ID,
      title: 'Open Settings',
      category: 'Preferences',
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
      title: 'Open Keyboard Shortcuts',
      category: 'Preferences',
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
      title: 'Open Settings (JSON)',
      category: 'Preferences',
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
      title: 'Open Keyboard Shortcuts (JSON)',
      category: 'Preferences',
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void openUserDataFile(accessor, UserDataFile.Keybindings, KEYBINDINGS_JSON_TEMPLATE)
  }
}
