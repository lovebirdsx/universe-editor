/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Preferences-related Action2 commands.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  DisposableStore,
  IConfigurationService,
  IDialogService,
  IEditorGroupsService,
  IFileService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IThemeService,
  IUriIdentityService,
  IUserDataFilesService,
  MenuId,
  Severity,
  UserDataFile,
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
import type { ColorThemeData } from '../services/themes/colorThemeData.js'
import { FileIconThemeData } from '../services/themes/fileIconThemeData.js'
import { ProductIconThemeData } from '../services/themes/productIconThemeData.js'
import { ThemeSettings } from '../services/themes/themeConfiguration.js'
import type { WorkbenchThemeService } from '../services/themes/workbenchThemeService.js'
import { SettingsEditorInput } from '../services/editor/SettingsEditorInput.js'
import { KeybindingsEditorInput } from '../services/editor/KeybindingsEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
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

const UPDATE_CONFIG_JSON_TEMPLATE = `// Deployment config for auto-update (packaged builds only).
// "updateUrl" overrides the update server; the channel stays the packaged default.
{}
`

async function openUserDataFile(
  services: {
    files: IUserDataFilesService
    groups: IEditorGroupsService
    instantiation: IInstantiationService
    uriIdentity: IUriIdentityService
  },
  file: UserDataFile,
  template: string,
  options?: { readOnly?: boolean; seedTemplate?: boolean },
): Promise<void> {
  const { files, groups, instantiation, uriIdentity } = services

  const uri = await files.getFileUri(file)
  if (!uri) return

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
      if (editor instanceof FileEditorInput && uriIdentity.isEqual(editor.resource, uri)) {
        groups.activateGroup(group)
        group.setActive(editor)
        return
      }
    }
  }

  const input = instantiation.createInstance(FileEditorInput, uri)
  if (options?.readOnly) input.markReadonly()
  openInLockAwareGroup(groups, input)
}

function userDataFileServices(accessor: ServicesAccessor): {
  files: IUserDataFilesService
  groups: IEditorGroupsService
  instantiation: IInstantiationService
  uriIdentity: IUriIdentityService
} {
  return {
    files: accessor.get(IUserDataFilesService),
    groups: accessor.get(IEditorGroupsService),
    instantiation: accessor.get(IInstantiationService),
    uriIdentity: accessor.get(IUriIdentityService),
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

    openInLockAwareGroup(groups, new SettingsEditorInput())
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

  override run(accessor: ServicesAccessor, ...args: unknown[]): void {
    const query = (args[0] as { query?: string } | undefined)?.query
    const groups = accessor.get(IEditorGroupsService)

    for (const group of groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof KeybindingsEditorInput) {
          groups.activateGroup(group)
          group.setActive(editor)
          dispatchKeybindingsEditorFocusSearch(query)
          return
        }
      }
    }

    openInLockAwareGroup(groups, new KeybindingsEditorInput())
    dispatchKeybindingsEditorFocusSearch(query)
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

export class OpenUpdateConfigJsonAction extends Action2 {
  static readonly ID = 'workbench.action.openUpdateConfigJson'
  constructor() {
    super({
      id: OpenUpdateConfigJsonAction.ID,
      title: localize2('action.openUpdateConfigJson.title', 'Open Update Config (JSON)'),
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void openUserDataFile(
      userDataFileServices(accessor),
      UserDataFile.UpdateConfig,
      UPDATE_CONFIG_JSON_TEMPLATE,
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
    if (uriComponents && (await fileService.exists(uriComponents))) {
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
    if (uriComponents && (await fileService.exists(uriComponents))) {
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
    openInLockAwareGroup(groups, input)
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

interface ColorThemePickItem extends IQuickPickItem {
  readonly theme: ColorThemeData
}

/**
 * 通用图标主题选择器：高亮即预览（不写配置），Enter 接受（持久化），Escape
 * 未接受则回滚。扩展翻译在 Eventually 相位落地，极早调用可能先于注册 ——
 * 等首批注册再打开（与 SelectColorThemeAction 同款防御）。
 */
function pickTheme<
  TTheme extends { readonly settingsId: string | null; readonly label: string },
>(options: {
  readonly quickInput: IQuickInputService
  readonly getThemes: () => readonly TTheme[]
  readonly getCurrent: () => TTheme
  readonly applyTheme: (theme: TTheme) => void
  readonly persist: () => void
  readonly placeholder: string
  readonly onDidChangeThemes: (listener: () => void) => { dispose(): void }
  readonly extraItems?: readonly TTheme[]
}): void {
  const openPicker = (): void => {
    const originalTheme = options.getCurrent()
    const currentLabel = localize('iconTheme.current', '(current)')
    const buildItems = (): (IQuickPickItem & { theme: TTheme })[] =>
      [...(options.extraItems ?? []), ...options.getThemes()].map((theme) => ({
        id: theme.settingsId ?? '',
        label: theme.label,
        ...(theme.settingsId === originalTheme.settingsId && { description: currentLabel }),
        theme,
      }))

    const pick = options.quickInput.createQuickPick<IQuickPickItem & { theme: TTheme }>()
    const disposables = new DisposableStore()
    disposables.add(pick)

    const items = buildItems()
    pick.items = items
    pick.placeholder = options.placeholder
    pick.activeItems = items.filter((i) => i.theme.settingsId === originalTheme.settingsId)

    // 主题按扩展分批注册（逐扩展 translate）：picker 打开期间到达的后续批次
    // 要实时并入，否则启动早期打开时列表只含首批注册的主题。
    disposables.add(
      options.onDidChangeThemes(() => {
        pick.items = buildItems()
      }),
    )

    let accepted = false
    disposables.add(
      pick.onDidChangeActive((item) => {
        if (item && item.theme.settingsId !== options.getCurrent().settingsId) {
          options.applyTheme(item.theme)
        }
      }),
    )
    disposables.add(
      pick.onDidAccept((selected) => {
        accepted = true
        const item = selected[0] ?? pick.activeItems[0]
        if (item) {
          options.applyTheme(item.theme)
          options.persist()
        }
      }),
    )
    disposables.add(
      pick.onDidHide(() => {
        // Defer the rollback decision so an accept that fired in the same turn
        // wins. A microtask (not a timer) keeps the store's release tied to the
        // current turn — a setTimeout leaves it alive for an unbounded stretch,
        // which the e2e leak gate snapshots as a leak.
        queueMicrotask(() => {
          if (!accepted) {
            options.applyTheme(originalTheme)
          }
          disposables.dispose()
        })
      }),
    )
    pick.show()
  }

  // extraItems (Universe Material / Default) are always available even with zero registered
  // themes, so a non-empty extraItems list is enough to open the picker.
  const canOpen = (): boolean =>
    options.getThemes().length > 0 || (options.extraItems?.length ?? 0) > 0

  if (canOpen()) {
    openPicker()
    return
  }
  const registrationWait = options.onDidChangeThemes(() => {
    if (canOpen()) {
      registrationWait.dispose()
      openPicker()
    }
  })
}

/**
 * VSCode 同款主题选择器：高亮即预览（不写配置），Enter 接受（持久化
 * settingsId），Escape 关闭未接受则回滚到进入时的主题。
 */
export class SelectColorThemeAction extends Action2 {
  static readonly ID = 'workbench.action.selectTheme'
  constructor() {
    super({
      id: SelectColorThemeAction.ID,
      title: localize2('action.selectTheme.title', 'Color Theme'),
      category: localize2('command.category.preferences', 'Preferences'),
      keybinding: { primary: 'ctrl+k ctrl+t' },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const quickInput = accessor.get(IQuickInputService)
    const themeService = accessor.get(IThemeService) as WorkbenchThemeService

    const openPicker = (): void => {
      const originalTheme = themeService.getColorThemeData()
      const currentLabel = localize('colorTheme.current', '(current)')
      const buildItems = (): ColorThemePickItem[] =>
        themeService.getColorThemes().map((theme) => ({
          id: theme.settingsId,
          label: theme.label,
          ...(theme.settingsId === originalTheme.settingsId && { description: currentLabel }),
          theme,
        }))

      const pick = quickInput.createQuickPick<ColorThemePickItem>()
      const disposables = new DisposableStore()
      disposables.add(pick)

      const items = buildItems()
      pick.items = items
      pick.placeholder = localize('quickInput.colorTheme.placeholder', 'Select Color Theme')
      pick.activeItems = items.filter((i) => i.theme.settingsId === originalTheme.settingsId)

      // 主题按扩展分批注册（逐扩展 translate）：picker 打开期间到达的后续批次
      // 要实时并入，否则启动早期打开时列表只含首批注册的主题。
      disposables.add(
        themeService.onDidChangeColorThemes(() => {
          pick.items = buildItems()
        }),
      )

      let accepted = false
      disposables.add(
        pick.onDidChangeActive((item) => {
          if (item && item.theme.settingsId !== themeService.getColorThemeData().settingsId) {
            // Preview only — never persisted (VSCode: settingsTarget undefined).
            void themeService.setColorTheme(item.theme.settingsId)
          }
        }),
      )
      disposables.add(
        pick.onDidAccept((selected) => {
          accepted = true
          const item = selected[0] ?? pick.activeItems[0]
          if (item) {
            void themeService.setColorTheme(item.theme.settingsId, { writeConfiguration: true })
          }
        }),
      )
      disposables.add(
        pick.onDidHide(() => {
          // onDidAccept and onDidHide can race; defer the rollback decision so
          // an accept that fired in the same turn wins. A microtask (not a
          // timer) keeps the store's release tied to the current turn — a
          // setTimeout leaves it alive for an unbounded stretch, which the e2e
          // leak gate snapshots as a leak.
          queueMicrotask(() => {
            if (!accepted) {
              void themeService.setColorTheme(originalTheme.settingsId)
            }
            disposables.dispose()
          })
        }),
      )
      pick.show()
    }

    // Extension translation lands in the Eventually phase, so a very early
    // Ctrl+K Ctrl+T can arrive before any theme has registered — wait for the
    // first batch instead of opening an empty picker.
    if (themeService.getColorThemes().length > 0) {
      openPicker()
      return
    }
    const registrationWait = themeService.onDidChangeColorThemes(() => {
      if (themeService.getColorThemes().length > 0) {
        registrationWait.dispose()
        openPicker()
      }
    })
  }
}

/** VSCode `workbench.action.selectIconTheme`（无默认快捷键，对齐 VSCode）。 */
export class SelectFileIconThemeAction extends Action2 {
  static readonly ID = 'workbench.action.selectIconTheme'
  constructor() {
    super({
      id: SelectFileIconThemeAction.ID,
      title: localize2('action.selectIconTheme.title', 'File Icon Theme'),
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const quickInput = accessor.get(IQuickInputService)
    const configuration = accessor.get(IConfigurationService)
    const themeService = accessor.get(IThemeService) as WorkbenchThemeService

    pickTheme({
      quickInput,
      getThemes: () => themeService.getFileIconThemes(),
      getCurrent: () => themeService.getFileIconThemeData(),
      applyTheme: (theme) => {
        // settingsId null = the built-in Universe Material entry (noIconTheme) —
        // pass it through so preview/rollback re-apply the built-in inline icons.
        void themeService.setFileIconTheme(theme.settingsId)
      },
      persist: () => {
        configuration.update(
          ThemeSettings.FILE_ICON_THEME,
          themeService.getFileIconThemeData().settingsId,
          ConfigurationTarget.User,
        )
      },
      placeholder: localize('quickInput.iconTheme.placeholder', 'Select File Icon Theme'),
      onDidChangeThemes: (listener) => themeService.onDidChangeFileIconThemes(listener),
      extraItems: [FileIconThemeData.noIconTheme],
    })
  }
}

/** VSCode `workbench.action.selectProductIconTheme`（无默认快捷键，对齐 VSCode）。 */
export class SelectProductIconThemeAction extends Action2 {
  static readonly ID = 'workbench.action.selectProductIconTheme'
  constructor() {
    super({
      id: SelectProductIconThemeAction.ID,
      title: localize2('action.selectProductIconTheme.title', 'Product Icon Theme'),
      category: localize2('command.category.preferences', 'Preferences'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const quickInput = accessor.get(IQuickInputService)
    const configuration = accessor.get(IConfigurationService)
    const themeService = accessor.get(IThemeService) as WorkbenchThemeService

    pickTheme({
      quickInput,
      getThemes: () => themeService.getProductIconThemes(),
      getCurrent: () => themeService.getProductIconThemeData(),
      applyTheme: (theme) => {
        void themeService.setProductIconTheme(theme.settingsId)
      },
      persist: () => {
        configuration.update(
          ThemeSettings.PRODUCT_ICON_THEME,
          themeService.getProductIconThemeData().settingsId,
          ConfigurationTarget.User,
        )
      },
      placeholder: localize('quickInput.productIconTheme.placeholder', 'Select Product Icon Theme'),
      onDidChangeThemes: (listener) => themeService.onDidChangeProductIconThemes(listener),
      extraItems: [ProductIconThemeData.defaultTheme],
    })
  }
}
