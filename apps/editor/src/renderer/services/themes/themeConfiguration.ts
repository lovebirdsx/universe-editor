/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 主题相关配置键的读取封装 —— VSCode `ThemeConfiguration` 的对等物。
 */

import { IConfigurationService } from '@universe-editor/platform'
import {
  mergeColorCustomizations,
  splitColorCustomizations,
  type ColorCustomizationMap,
} from './colorResolver.js'

export const ThemeSettings = {
  COLOR_THEME: 'workbench.colorTheme',
  FILE_ICON_THEME: 'workbench.iconTheme',
  PRODUCT_ICON_THEME: 'workbench.productIconTheme',
  COLOR_CUSTOMIZATIONS: 'workbench.colorCustomizations',
  PREFERRED_DARK_THEME: 'workbench.preferredDarkColorTheme',
  PREFERRED_LIGHT_THEME: 'workbench.preferredLightColorTheme',
  DETECT_COLOR_SCHEME: 'window.autoDetectColorScheme',
} as const

/** 内置默认主题（`extensions/theme-defaults` 的 settingsId）。 */
export const DEFAULT_DARK_COLOR_THEME_ID = 'Universe Dark'
export const DEFAULT_LIGHT_COLOR_THEME_ID = 'Universe Light'
export const DEFAULT_PRODUCT_ICON_THEME_ID = 'Default'

/** 旧版二选一配置值 → 内置主题 settingsId 的迁移映射。 */
const LEGACY_THEME_IDS: Record<string, string> = {
  dark: DEFAULT_DARK_COLOR_THEME_ID,
  light: DEFAULT_LIGHT_COLOR_THEME_ID,
}

export function migrateColorThemeSettingId(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_DARK_COLOR_THEME_ID
  }
  return LEGACY_THEME_IDS[value] ?? value
}

export class ThemeConfiguration {
  constructor(private readonly configurationService: IConfigurationService) {}

  /** 用户配置的 `workbench.colorTheme`（settingsId 形态，含 legacy 迁移）。 */
  get colorTheme(): string {
    return migrateColorThemeSettingId(
      this.configurationService.get<string>(ThemeSettings.COLOR_THEME),
    )
  }

  /** 当前生效的颜色定制：全局块 + 目标主题的 `"[settingsId]"` 块合并。 */
  effectiveColorCustomizations(themeSettingsId: string): ColorCustomizationMap {
    const raw = this.configurationService.get<unknown>(ThemeSettings.COLOR_CUSTOMIZATIONS)
    const { global, perTheme } = splitColorCustomizations(raw)
    return mergeColorCustomizations(global, perTheme[themeSettingsId])
  }

  get fileIconTheme(): string | null {
    const value = this.configurationService.get<string | null>(ThemeSettings.FILE_ICON_THEME)
    return value === undefined ? null : value
  }

  get productIconTheme(): string {
    return (
      this.configurationService.get<string>(ThemeSettings.PRODUCT_ICON_THEME) ??
      DEFAULT_PRODUCT_ICON_THEME_ID
    )
  }
}
