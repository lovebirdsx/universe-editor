import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  GroupDirection,
  IEditorGroupsService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { OpenSettingsAction } from '../preferencesActions.js'
import { SettingsEditorInput } from '../../workbench/preferences/SettingsEditorInput.js'
import { EditorGroupsService } from '../../workbench/editor/EditorGroupsService.js'

function runAction(groups: EditorGroupsService): void {
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  const inst = new InstantiationService(services)
  inst.invokeFunction((accessor) => {
    const cmd = CommandsRegistry.getCommand(OpenSettingsAction.ID)!
    cmd.handler(accessor)
  })
}

describe('OpenSettingsAction', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers command + keybinding + command palette entry', () => {
    disposables.push(registerAction2(OpenSettingsAction))
    expect(CommandsRegistry.getCommand(OpenSettingsAction.ID)).toBeDefined()
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+,')).toBe(OpenSettingsAction.ID)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === OpenSettingsAction.ID,
      ),
    ).toBe(true)
  })

  it('opens a Settings tab in the active group when none exists', () => {
    disposables.push(registerAction2(OpenSettingsAction))
    const groups = new EditorGroupsService()
    runAction(groups)
    const editors = groups.activeGroup.editors
    expect(editors).toHaveLength(1)
    expect(editors[0]).toBeInstanceOf(SettingsEditorInput)
  })

  it('reuses an existing Settings tab instead of opening a duplicate', () => {
    disposables.push(registerAction2(OpenSettingsAction))
    const groups = new EditorGroupsService()
    runAction(groups)
    runAction(groups)
    const editors = groups.activeGroup.editors
    expect(editors).toHaveLength(1)
    expect(editors[0]).toBeInstanceOf(SettingsEditorInput)
  })

  it('reuses Settings tab across groups, activating the owning group', () => {
    disposables.push(registerAction2(OpenSettingsAction))
    const groups = new EditorGroupsService()
    const g1 = groups.activeGroup
    runAction(groups) // settings in g1
    const g2 = groups.addGroup(g1, GroupDirection.Right)
    groups.activateGroup(g2)
    expect(groups.activeGroup).toBe(g2)

    runAction(groups)
    expect(groups.activeGroup).toBe(g1)
    expect(g2.editors).toHaveLength(0)
    expect(g1.editors).toHaveLength(1)
    expect(g1.editors[0]).toBeInstanceOf(SettingsEditorInput)
  })

  it('registers with Ctrl+, keybinding', () => {
    disposables.push(registerAction2(OpenSettingsAction))
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+,')).toBe(OpenSettingsAction.ID)
  })

  it('contributes to MenubarFileMenu under group 5_preferences', () => {
    disposables.push(registerAction2(OpenSettingsAction))
    const items = MenuRegistry.getMenuItems(MenuId.MenubarFileMenu)
    const entry = items.find((i) => 'command' in i && i.command === OpenSettingsAction.ID)
    expect(entry).toBeDefined()
    expect(entry?.group).toBe('5_preferences')
  })
})
