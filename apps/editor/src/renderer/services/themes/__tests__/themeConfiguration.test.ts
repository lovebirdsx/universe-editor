/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService, ColorScheme, Event } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DARK_COLOR_THEME_ID,
  DEFAULT_FILE_ICON_THEME_ID,
  DEFAULT_LIGHT_COLOR_THEME_ID,
  migrateColorThemeSettingId,
  ThemeConfiguration,
  ThemeSettings,
  type IHostColorScheme,
} from '../themeConfiguration.js'

function stubConfiguration(values: Record<string, unknown>): IConfigurationService {
  return {
    get: <T>(key: string) => values[key] as T | undefined,
  } as unknown as IConfigurationService
}

describe('migrateColorThemeSettingId', () => {
  it('maps legacy dark/light values to built-in theme ids', () => {
    expect(migrateColorThemeSettingId('dark')).toBe(DEFAULT_DARK_COLOR_THEME_ID)
    expect(migrateColorThemeSettingId('light')).toBe(DEFAULT_LIGHT_COLOR_THEME_ID)
    expect(migrateColorThemeSettingId(undefined)).toBe(DEFAULT_DARK_COLOR_THEME_ID)
    expect(migrateColorThemeSettingId('Monokai')).toBe('Monokai')
  })
})

describe('ThemeConfiguration', () => {
  it('colorTheme applies the legacy migration', () => {
    const config = new ThemeConfiguration(
      stubConfiguration({ [ThemeSettings.COLOR_THEME]: 'light' }),
    )
    expect(config.colorTheme).toBe(DEFAULT_LIGHT_COLOR_THEME_ID)
  })

  it('effectiveColorCustomizations merges the global and per-theme blocks', () => {
    const config = new ThemeConfiguration(
      stubConfiguration({
        [ThemeSettings.COLOR_CUSTOMIZATIONS]: {
          'editor.background': '#111111',
          'sideBar.background': '#222222',
          '[Universe Dark]': { 'sideBar.background': '#333333' },
        },
      }),
    )
    expect(config.effectiveColorCustomizations('Universe Dark')).toEqual({
      'editor.background': '#111111',
      'sideBar.background': '#333333',
    })
    expect(config.effectiveColorCustomizations('Other Theme')).toEqual({
      'editor.background': '#111111',
      'sideBar.background': '#222222',
    })
  })

  it('fileIconTheme defaults to universe-material, null means None, productIconTheme to Default', () => {
    const config = new ThemeConfiguration(stubConfiguration({}))
    expect(config.fileIconTheme).toBe(DEFAULT_FILE_ICON_THEME_ID)
    expect(config.productIconTheme).toBe('Default')
    // Explicit null = None (must pass through, not fall back to the default).
    const none = new ThemeConfiguration(
      stubConfiguration({ [ThemeSettings.FILE_ICON_THEME]: null }),
    )
    expect(none.fileIconTheme).toBeNull()
    const custom = new ThemeConfiguration(
      stubConfiguration({
        [ThemeSettings.FILE_ICON_THEME]: 'vs-minimal',
        [ThemeSettings.PRODUCT_ICON_THEME]: 'fluent',
      }),
    )
    expect(custom.fileIconTheme).toBe('vs-minimal')
    expect(custom.productIconTheme).toBe('fluent')
  })

  it('detect off reads workbench.colorTheme directly and reports no preferred scheme', () => {
    const config = new ThemeConfiguration(
      stubConfiguration({
        [ThemeSettings.COLOR_THEME]: 'Monokai',
        [ThemeSettings.DETECT_COLOR_SCHEME]: false,
        [ThemeSettings.PREFERRED_DARK_THEME]: 'Ignored Dark',
      }),
      { dark: true, onDidChange: Event.None },
    )
    expect(config.colorTheme).toBe('Monokai')
    expect(config.getColorThemeSettingId()).toBe(ThemeSettings.COLOR_THEME)
    expect(config.getPreferredColorScheme()).toBeUndefined()
    expect(config.isDetectingColorScheme()).toBe(false)
  })

  it('detect on reads the preferred key for the current scheme', () => {
    const darkHost: IHostColorScheme = { dark: true, onDidChange: Event.None }
    const config = new ThemeConfiguration(
      stubConfiguration({
        [ThemeSettings.DETECT_COLOR_SCHEME]: true,
        [ThemeSettings.PREFERRED_DARK_THEME]: 'Solarized Dark',
        [ThemeSettings.PREFERRED_LIGHT_THEME]: 'Solarized Light',
      }),
      darkHost,
      // Registry lookup so the preferred-value sanitize can resolve each scheme.
      (settingsId) => {
        if (settingsId === 'Solarized Dark') {
          return { type: ColorScheme.DARK }
        }
        if (settingsId === 'Solarized Light') {
          return { type: ColorScheme.LIGHT }
        }
        return undefined
      },
    )
    expect(config.colorTheme).toBe('Solarized Dark')
    expect(config.getColorThemeSettingId()).toBe(ThemeSettings.PREFERRED_DARK_THEME)
    expect(config.getPreferredColorScheme()).toBe(ColorScheme.DARK)

    darkHost.dark = false
    expect(config.colorTheme).toBe('Solarized Light')
    expect(config.getColorThemeSettingId()).toBe(ThemeSettings.PREFERRED_LIGHT_THEME)
    expect(config.getPreferredColorScheme()).toBe(ColorScheme.LIGHT)
  })

  it('preferred key polluted by a theme of the other scheme falls back to the built-in default', () => {
    const findThemeBySettingsId = (
      settingsId: string,
    ): { readonly type: ColorScheme } | undefined => {
      if (settingsId === 'Actually Light') {
        return { type: ColorScheme.LIGHT }
      }
      if (settingsId === 'Actually Dark') {
        return { type: ColorScheme.DARK }
      }
      return undefined
    }
    // preferredDark holds a light theme -> sanitize back to the built-in dark.
    const darkConfig = new ThemeConfiguration(
      stubConfiguration({
        [ThemeSettings.DETECT_COLOR_SCHEME]: true,
        [ThemeSettings.PREFERRED_DARK_THEME]: 'Actually Light',
      }),
      { dark: true, onDidChange: Event.None },
      findThemeBySettingsId,
    )
    expect(darkConfig.colorTheme).toBe(DEFAULT_DARK_COLOR_THEME_ID)

    // preferredLight holds a dark theme -> sanitize back to the built-in light.
    const lightConfig = new ThemeConfiguration(
      stubConfiguration({
        [ThemeSettings.DETECT_COLOR_SCHEME]: true,
        [ThemeSettings.PREFERRED_LIGHT_THEME]: 'Actually Dark',
      }),
      { dark: false, onDidChange: Event.None },
      findThemeBySettingsId,
    )
    expect(lightConfig.colorTheme).toBe(DEFAULT_LIGHT_COLOR_THEME_ID)
  })

  it('unknown preferred value falls back by built-in id heuristic without a registry lookup', () => {
    const config = new ThemeConfiguration(
      stubConfiguration({
        [ThemeSettings.DETECT_COLOR_SCHEME]: true,
        [ThemeSettings.PREFERRED_LIGHT_THEME]: DEFAULT_LIGHT_COLOR_THEME_ID,
      }),
      { dark: false, onDidChange: Event.None },
    )
    expect(config.colorTheme).toBe(DEFAULT_LIGHT_COLOR_THEME_ID)
  })
})
