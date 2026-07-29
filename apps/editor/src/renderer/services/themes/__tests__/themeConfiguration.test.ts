/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DARK_COLOR_THEME_ID,
  DEFAULT_LIGHT_COLOR_THEME_ID,
  migrateColorThemeSettingId,
  ThemeConfiguration,
  ThemeSettings,
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

  it('fileIconTheme defaults to null and productIconTheme to Default', () => {
    const config = new ThemeConfiguration(stubConfiguration({}))
    expect(config.fileIconTheme).toBeNull()
    expect(config.productIconTheme).toBe('Default')
    const custom = new ThemeConfiguration(
      stubConfiguration({
        [ThemeSettings.FILE_ICON_THEME]: 'vs-minimal',
        [ThemeSettings.PRODUCT_ICON_THEME]: 'fluent',
      }),
    )
    expect(custom.fileIconTheme).toBe('vs-minimal')
    expect(custom.productIconTheme).toBe('fluent')
  })
})
