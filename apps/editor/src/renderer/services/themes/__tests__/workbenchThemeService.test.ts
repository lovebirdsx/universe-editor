/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  Event,
  URI,
  type IFileService,
  type IHostService,
} from '@universe-editor/platform'
import { registerUniverseColorIds } from '../universeColorIds.js'
import { WorkbenchThemeService } from '../workbenchThemeService.js'

const DARK_THEME_JSON = `{
  "include": "./base.json",
  "colors": { "editor.background": "#101010" }
}`
const BASE_THEME_JSON = `{
  "colors": { "editor.foreground": "#d0d0d0" },
  "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#608060" } }]
}`
const LIGHT_THEME_JSON = `{
  "colors": { "editor.background": "#fafafa", "editor.foreground": "#202020" }
}`
const ICON_THEME_JSON = `{
  "iconDefinitions": { "_ts": { "iconPath": "./ts.svg" } },
  "fileExtensions": { "ts": "_ts" }
}`

function makeFiles(): Record<string, string> {
  return {
    '/ext/themes/dark.json': DARK_THEME_JSON,
    '/ext/themes/base.json': BASE_THEME_JSON,
    '/ext/themes/light.json': LIGHT_THEME_JSON,
  }
}

function makeFileService(files: Record<string, string>): IFileService {
  return {
    _serviceBrand: undefined,
    async readFileText(uri: URI) {
      const text = files[uri.path]
      if (text === undefined) throw new Error(`ENOENT: ${uri.path}`)
      return text
    },
  } as unknown as IFileService
}

function makeHostService(): IHostService {
  return {
    _serviceBrand: undefined,
    onDidChangeColorScheme: Event.None,
    async isDarkColorScheme() {
      return true
    },
  } as unknown as IHostService
}

function registerBuiltInThemes(service: WorkbenchThemeService): void {
  service.registerColorThemes(
    [
      {
        id: 'Universe Dark',
        label: 'Universe Dark',
        uiTheme: 'vs-dark',
        path: './themes/dark.json',
      },
      {
        id: 'Universe Light',
        label: 'Universe Light',
        uiTheme: 'vs',
        path: './themes/light.json',
      },
    ],
    { extensionId: 'test.themes', extensionLocation: '/ext', extensionIsBuiltin: true },
  )
}

function styleElement(): HTMLStyleElement | null {
  return document.head.querySelector('style.contributedColorTheme')
}

function fileIconStyleElement(): HTMLStyleElement | null {
  return document.head.querySelector('style.contributedFileIconTheme')
}

function registerTestIconThemes(service: WorkbenchThemeService): void {
  service.registerFileIconThemes(
    [
      {
        id: 'test-icons',
        label: 'Test Icons',
        path: './icons/test-icon-theme.json',
      },
    ],
    { extensionId: 'test.themes', extensionLocation: '/ext', extensionIsBuiltin: true },
  )
}

describe('WorkbenchThemeService', () => {
  let config: ConfigurationService
  let files: Record<string, string>
  let service: WorkbenchThemeService

  beforeEach(() => {
    localStorage.clear()
    document.head
      .querySelectorAll(
        'style.contributedColorTheme, style.contributedFileIconTheme, style.contributedProductIconTheme',
      )
      .forEach((el) => el.remove())
    delete document.documentElement.dataset.theme
    registerUniverseColorIds()
    config = new ConfigurationService()
    files = makeFiles()
    service = new WorkbenchThemeService(
      config,
      makeFileService(files),
      undefined as never,
      makeHostService(),
    )
  })

  afterEach(() => {
    service.dispose()
  })

  it('applies a registered theme: CSS variables injected, dataset updated, snapshot written', async () => {
    registerBuiltInThemes(service)
    const theme = await service.setColorTheme('Universe Dark')
    expect(theme?.settingsId).toBe('Universe Dark')

    const css = styleElement()?.textContent ?? ''
    expect(css).toContain('--vscode-editor-background: #101010')
    // editor.foreground comes from the include chain (base.json)
    expect(css).toContain('--vscode-editor-foreground: #d0d0d0')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    const snapshot = JSON.parse(localStorage.getItem('universe.theme.cssSnapshot')!)
    expect(snapshot.settingsId).toBe('Universe Dark')
    expect(snapshot.css).toBe(css)
  })

  it('restoreSnapshot injects the persisted CSS synchronously on a fresh service', async () => {
    registerBuiltInThemes(service)
    await service.setColorTheme('Universe Light')
    service.dispose()

    const fresh = new WorkbenchThemeService(
      config,
      makeFileService(files),
      undefined as never,
      makeHostService(),
    )
    fresh.restoreSnapshot()
    const css = styleElement()?.textContent ?? ''
    expect(css).toContain('--vscode-editor-background: #fafafa')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(fresh.getColorThemeData().settingsId).toBe('Universe Light')
    fresh.dispose()
  })

  it('initialize defers the initial application until the first theme registers', async () => {
    const initialized = service.initialize()
    // Registry is still empty — nothing applied yet.
    expect(styleElement()).toBeNull()
    registerBuiltInThemes(service)
    await initialized
    await vi.waitFor(() => {
      expect(styleElement()?.textContent).toContain('--vscode-editor-background: #101010')
    })
  })

  it('migrates the legacy "light" setting to Universe Light on initialize', async () => {
    config.update('workbench.colorTheme', 'light', ConfigurationTarget.User)
    registerBuiltInThemes(service)
    await service.initialize()
    expect(service.getColorThemeData().settingsId).toBe('Universe Light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('falls back to the default theme when the requested id does not exist (VSCode find semantics)', async () => {
    registerBuiltInThemes(service)
    await service.setColorTheme('Universe Light')
    const missing = await service.setColorTheme('No Such Theme')
    // findThemeBySettingsId falls back to the registry default, matching VSCode.
    expect(missing?.settingsId).toBe('Universe Dark')
    expect(service.getColorThemeData().settingsId).toBe('Universe Dark')
  })

  it('applies colorCustomizations (global + per-theme) and honors "default"', async () => {
    registerBuiltInThemes(service)
    await service.initialize()
    config.update(
      'workbench.colorCustomizations',
      {
        'editor.background': '#ff0000',
        '[Universe Light]': { 'editor.background': '#00ff00' },
      },
      ConfigurationTarget.User,
    )
    await service.setColorTheme('Universe Dark')
    expect(styleElement()?.textContent).toContain('--vscode-editor-background: #ff0000')

    await service.setColorTheme('Universe Light')
    expect(styleElement()?.textContent).toContain('--vscode-editor-background: #00ff00')

    // "default" restores the registry default (VSCode semantics), not the theme value.
    config.update(
      'workbench.colorCustomizations',
      { '[Universe Light]': { 'editor.background': 'default' } },
      ConfigurationTarget.User,
    )
    await vi.waitFor(() => {
      // registry light default for editor.background is #ffffff
      expect(styleElement()?.textContent).toContain('--vscode-editor-background: #ffffff')
    })
  })

  it('serializes concurrent setColorTheme calls through the promise chain', async () => {
    registerBuiltInThemes(service)
    const first = service.setColorTheme('Universe Light')
    const second = service.setColorTheme('Universe Dark')
    await Promise.all([first, second])
    expect(service.getColorThemeData().settingsId).toBe('Universe Dark')
    expect(styleElement()?.textContent).toContain('--vscode-editor-background: #101010')
  })

  it('writeConfiguration persists the settingsId to workbench.colorTheme', async () => {
    registerBuiltInThemes(service)
    await service.setColorTheme('Universe Light', { writeConfiguration: true })
    expect(config.get('workbench.colorTheme')).toBe('Universe Light')
  })

  it('falls back to the default theme when the active theme is deregistered', async () => {
    const handle = service.registerColorThemes(
      [{ id: 'Extra Dark', label: 'Extra Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }],
      { extensionId: 'test.extra', extensionLocation: '/ext', extensionIsBuiltin: false },
    )
    registerBuiltInThemes(service)
    await service.initialize()
    await service.setColorTheme('Extra Dark')
    expect(service.getColorThemeData().settingsId).toBe('Extra Dark')

    handle.dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(service.getColorThemeData().settingsId).toBe('Universe Dark')
  })

  it('reloadCurrentTheme re-reads the theme document (include chain) and re-applies', async () => {
    registerBuiltInThemes(service)
    await service.setColorTheme('Universe Dark')
    expect(styleElement()?.textContent).toContain('--vscode-editor-foreground: #d0d0d0')

    // Edit the included base document; reload must re-walk the include chain.
    files['/ext/themes/base.json'] = `{
      "colors": { "editor.foreground": "#bbbbbb" },
      "tokenColors": []
    }`
    await service.reloadCurrentTheme()
    expect(styleElement()?.textContent).toContain('--vscode-editor-foreground: #bbbbbb')
  })

  it('getColor resolves through the current theme (registry defaults included)', async () => {
    registerBuiltInThemes(service)
    await service.setColorTheme('Universe Dark')
    expect(service.getColor('editor.background')?.toString()).toBe('#101010')
    // Not in the theme JSON — the universe registry default slot answers.
    expect(service.getColor('sideBar.background')).toBeDefined()
  })

  it('exposes onDidChangeColorThemes when themes register/deregister', async () => {
    const fired: number[] = []
    const d = service.onDidChangeColorThemes(() => fired.push(1))
    registerBuiltInThemes(service)
    expect(fired.length).toBeGreaterThan(0)
    d.dispose()
  })

  it('setFileIconTheme(undefined) selects noIconTheme (the default Universe Material)', async () => {
    files['/ext/icons/test-icon-theme.json'] = ICON_THEME_JSON
    registerTestIconThemes(service)
    const theme = await service.setFileIconTheme(undefined)
    expect(theme?.id).toBe('')
    expect(service.getFileIconTheme().id).toBe('')
    expect(fileIconStyleElement()?.textContent ?? '').toBe('')
  })

  it('setFileIconTheme applies a registered theme by settingsId', async () => {
    files['/ext/icons/test-icon-theme.json'] = ICON_THEME_JSON
    registerTestIconThemes(service)
    const theme = await service.setFileIconTheme('test-icons')
    expect(theme?.settingsId).toBe('test-icons')
    expect(service.getFileIconTheme().id).toBe('test.themes-test-icons')
    expect(fileIconStyleElement()?.textContent).toContain('.ts-ext-file-icon')
  })

  it('setFileIconTheme(null) selects noIconTheme and clears the stylesheet', async () => {
    files['/ext/icons/test-icon-theme.json'] = ICON_THEME_JSON
    registerTestIconThemes(service)
    await service.setFileIconTheme('test-icons')
    expect(service.getFileIconTheme().id).not.toBe('')

    const theme = await service.setFileIconTheme(null)
    expect(theme?.id).toBe('')
    expect(service.getFileIconTheme().id).toBe('')
    // The built-in default has no contributed stylesheet.
    expect(fileIconStyleElement()?.textContent ?? '').not.toContain('.ts-ext-file-icon')
  })

  it('setFileIconTheme with an unknown id falls back to noIconTheme', async () => {
    files['/ext/icons/test-icon-theme.json'] = ICON_THEME_JSON
    registerTestIconThemes(service)
    const theme = await service.setFileIconTheme('no-such-icon-theme')
    expect(theme?.id).toBe('')
  })

  it('initialize applies the built-in default without waiting for icon theme registration', async () => {
    registerBuiltInThemes(service)
    await service.initialize()
    expect(service.getFileIconTheme().id).toBe('')
    expect(fileIconStyleElement()?.textContent ?? '').toBe('')
  })

  it('initialize defers a configured icon theme until it registers', async () => {
    files['/ext/icons/test-icon-theme.json'] = ICON_THEME_JSON
    config.update('workbench.iconTheme', 'test-icons', ConfigurationTarget.User)
    const initialized = service.initialize()
    registerBuiltInThemes(service)
    registerTestIconThemes(service)
    await initialized
    await vi.waitFor(() => {
      expect(service.getFileIconTheme().id).toBe('test.themes-test-icons')
    })
    expect(fileIconStyleElement()?.textContent).toContain('.ts-ext-file-icon')
  })

  it('writing workbench.iconTheme at runtime switches themes via the subscription', async () => {
    files['/ext/icons/test-icon-theme.json'] = ICON_THEME_JSON
    registerBuiltInThemes(service)
    registerTestIconThemes(service)
    await service.initialize()
    expect(service.getFileIconTheme().id).toBe('')

    config.update('workbench.iconTheme', 'test-icons', ConfigurationTarget.User)
    await vi.waitFor(() => {
      expect(service.getFileIconTheme().id).toBe('test.themes-test-icons')
    })

    config.update('workbench.iconTheme', null, ConfigurationTarget.User)
    await vi.waitFor(() => {
      expect(service.getFileIconTheme().id).toBe('')
    })
  })
})
