import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ConfigurationService,
  ConfigurationTarget,
  GroupDirection,
  IDialogService,
  IEditorGroupsService,
  IConfigurationService,
  InstantiationService,
  IQuickInputService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  registerAction2,
  type IQuickPickItem,
  type IDisposable,
  type QuickPickInput,
} from '@universe-editor/platform'
import {
  ConfigureDisplayLanguageAction,
  OpenKeybindingsEditorAction,
  OpenSettingsAction,
} from '../preferencesActions.js'
import { KeybindingsEditorInput } from '../../services/editor/KeybindingsEditorInput.js'
import { SettingsEditorInput } from '../../services/editor/SettingsEditorInput.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { DISPLAY_LANGUAGE_SETTING_KEY } from '../../../shared/i18n/availableLocales.js'

function runAction(groups: EditorGroupsService, id: string = OpenSettingsAction.ID): void {
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  const inst = new InstantiationService(services)
  inst.invokeFunction((accessor) => {
    const cmd = CommandsRegistry.getCommand(id)!
    cmd.handler(accessor)
  })
}

async function runActionWithServices(services: ServiceCollection, id: string): Promise<void> {
  const inst = new InstantiationService(services)
  await inst.invokeFunction(async (accessor) => {
    const cmd = CommandsRegistry.getCommand(id)!
    await cmd.handler(accessor)
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

describe('OpenKeybindingsEditorAction', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers command + chord keybinding + command palette entry', () => {
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    expect(CommandsRegistry.getCommand(OpenKeybindingsEditorAction.ID)).toBeDefined()
    const firstStroke = KeybindingsRegistry.resolveKeystroke('ctrl+k')
    expect(firstStroke.kind).toBe('enter-chord')
    const secondStroke = KeybindingsRegistry.resolveKeystroke(
      'ctrl+s',
      undefined,
      firstStroke.kind === 'enter-chord' ? firstStroke.pending : undefined,
    )
    expect(secondStroke).toMatchObject({ kind: 'execute', command: OpenKeybindingsEditorAction.ID })
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === OpenKeybindingsEditorAction.ID,
      ),
    ).toBe(true)
  })

  it('opens a Keybindings tab in the active group when none exists', () => {
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    const groups = new EditorGroupsService()
    runAction(groups, OpenKeybindingsEditorAction.ID)
    const editors = groups.activeGroup.editors
    expect(editors).toHaveLength(1)
    expect(editors[0]).toBeInstanceOf(KeybindingsEditorInput)
  })

  it('reuses an existing Keybindings tab instead of opening a duplicate', () => {
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    const groups = new EditorGroupsService()
    runAction(groups, OpenKeybindingsEditorAction.ID)
    runAction(groups, OpenKeybindingsEditorAction.ID)
    const editors = groups.activeGroup.editors
    expect(editors).toHaveLength(1)
    expect(editors[0]).toBeInstanceOf(KeybindingsEditorInput)
  })

  it('reuses Keybindings tab across groups, activating the owning group', () => {
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    const groups = new EditorGroupsService()
    const g1 = groups.activeGroup
    runAction(groups, OpenKeybindingsEditorAction.ID)
    const g2 = groups.addGroup(g1, GroupDirection.Right)
    groups.activateGroup(g2)
    expect(groups.activeGroup).toBe(g2)

    runAction(groups, OpenKeybindingsEditorAction.ID)
    expect(groups.activeGroup).toBe(g1)
    expect(g2.editors).toHaveLength(0)
    expect(g1.editors).toHaveLength(1)
    expect(g1.editors[0]).toBeInstanceOf(KeybindingsEditorInput)
  })

  it('contributes to MenubarFileMenu under group 5_preferences', () => {
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    const items = MenuRegistry.getMenuItems(MenuId.MenubarFileMenu)
    const entry = items.find((i) => 'command' in i && i.command === OpenKeybindingsEditorAction.ID)
    expect(entry).toBeDefined()
    expect(entry?.group).toBe('5_preferences')
  })
})

describe('ConfigureDisplayLanguageAction', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('writes workbench.language to the user layer and shows a restart notice', async () => {
    disposables.push(registerAction2(ConfigureDisplayLanguageAction))

    const config = new ConfigurationService()
    const quickInput = {
      _serviceBrand: undefined,
      createQuickPick: () => {
        throw new Error('not used')
      },
      async pick<T extends IQuickPickItem>(
        _items: readonly QuickPickInput<T>[],
      ): Promise<T | undefined> {
        return {
          id: 'zh-CN',
          label: 'Simplified Chinese',
          description: 'Display the editor UI in Simplified Chinese.',
          value: 'zh-CN',
        } as unknown as T
      },
      async input() {
        return undefined
      },
      hide() {},
    } satisfies IQuickInputService
    const dialogCalls: Array<{ message: string; detail?: string }> = []
    const dialog: IDialogService = {
      _serviceBrand: undefined,
      async confirm(opts) {
        dialogCalls.push({ message: opts.message, ...(opts.detail ? { detail: opts.detail } : {}) })
        return { confirmed: true, choice: 'primary' }
      },
      async prompt() {
        return undefined
      },
    }

    const services = new ServiceCollection()
    services.set(IConfigurationService, config)
    services.set(IQuickInputService, quickInput)
    services.set(IDialogService, dialog)

    await runActionWithServices(services, ConfigureDisplayLanguageAction.ID)

    expect(config.get(DISPLAY_LANGUAGE_SETTING_KEY)).toBe('zh-CN')
    expect(config.getLayerSnapshot(ConfigurationTarget.User)[DISPLAY_LANGUAGE_SETTING_KEY]).toBe(
      'zh-CN',
    )
    expect(dialogCalls).toHaveLength(1)
    expect(dialogCalls[0]?.message).toBe('Display language updated.')
  })
})
