/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 主题相关配置键的读取封装 —— VSCode `ThemeConfiguration` 的对等物。
 */

import { ColorScheme, Event, IConfigurationService, isDark } from '@universe-editor/platform'
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

const colorSchemeToPreferred = {
  [ColorScheme.DARK]: ThemeSettings.PREFERRED_DARK_THEME,
  [ColorScheme.LIGHT]: ThemeSettings.PREFERRED_LIGHT_THEME,
} as const

/**
 * 系统配色来源的最小契约（VSCode `IHostColorSchemeService` 的对等物）：
 * 生产实现由 WorkbenchThemeService 桥接 IHostService 的 IPC 事件提供，`dark`
 * 是 service 持有的可变缓存（初始拉取与后续事件都会推进它）。
 */
export interface IHostColorScheme {
  dark: boolean
  readonly onDidChange: Event<boolean>
}

/** 不跟随系统时的常量实现（测试与默认构造用）。 */
export const STATIC_DARK_COLOR_SCHEME: IHostColorScheme = {
  dark: true,
  onDidChange: Event.None,
}

export class ThemeConfiguration {
  constructor(
    private readonly configurationService: IConfigurationService,
    private readonly hostColorScheme: IHostColorScheme = STATIC_DARK_COLOR_SCHEME,
    /** 注册表查询（preferred 值 sanitize 用；缺省时按内置 id 兜底判断 scheme）。 */
    private readonly findThemeBySettingsId?: (
      settingsId: string,
    ) => { readonly type: ColorScheme } | undefined,
  ) {}

  /**
   * 当前生效的颜色主题 settingsId（含 legacy 迁移）。
   * 系统跟随开启时读当前 scheme 对应的 preferred 设置（VSCode 同款：
   * preferred 键被污染时按 scheme 默认值回退，不会穿到异 scheme 主题）。
   */
  get colorTheme(): string {
    const key = this.getColorThemeSettingId()
    const value = migrateColorThemeSettingId(this.configurationService.get<string>(key))
    if (key === ThemeSettings.COLOR_THEME) {
      return value
    }
    return this._sanitizePreferred(key, value)
  }

  /** 颜色主题配置的读写键：跟随系统时为当前 scheme 的 preferred 键。 */
  getColorThemeSettingId(): string {
    const preferred = this.getPreferredColorScheme()
    return preferred !== undefined
      ? colorSchemeToPreferred[preferred as keyof typeof colorSchemeToPreferred]
      : ThemeSettings.COLOR_THEME
  }

  /**
   * 系统跟随开启时返回当前 scheme；关闭返回 undefined
   * （VSCode `settings.getPreferredColorScheme()`，无高对比度维度）。
   */
  getPreferredColorScheme(): ColorScheme | undefined {
    if (!this.isDetectingColorScheme()) {
      return undefined
    }
    return this.hostColorScheme.dark ? ColorScheme.DARK : ColorScheme.LIGHT
  }

  isDetectingColorScheme(): boolean {
    return this.configurationService.get<boolean>(ThemeSettings.DETECT_COLOR_SCHEME) === true
  }

  private _sanitizePreferred(key: string, value: string): string {
    if (key === ThemeSettings.PREFERRED_DARK_THEME) {
      return isDark(this._typeOf(value)) ? value : DEFAULT_DARK_COLOR_THEME_ID
    }
    return this._typeOf(value) === ColorScheme.LIGHT ? value : DEFAULT_LIGHT_COLOR_THEME_ID
  }

  private _typeOf(settingsId: string): ColorScheme {
    const theme = this.findThemeBySettingsId?.(settingsId)
    return (
      theme?.type ??
      (settingsId === DEFAULT_LIGHT_COLOR_THEME_ID ? ColorScheme.LIGHT : ColorScheme.DARK)
    )
  }

  /** 当前生效的颜色定制：全局块 + 目标主题的 `"[settingsId]"` 块合并。 */
  effectiveColorCustomizations(themeSettingsId: string): ColorCustomizationMap {
    const raw = this.configurationService.get<unknown>(ThemeSettings.COLOR_CUSTOMIZATIONS)
    const { global, perTheme } = splitColorCustomizations(raw)
    return mergeColorCustomizations(global, perTheme[themeSettingsId])
  }

  /**
   * 用户配置的 `workbench.iconTheme`：settingsId 字符串；`null` = 默认的
   * Universe Material（内置内联 Material SVG 渲染，无 contributed 样式表）。
   */
  get fileIconTheme(): string | null {
    return this.configurationService.get<string | null>(ThemeSettings.FILE_ICON_THEME) ?? null
  }

  get productIconTheme(): string {
    return (
      this.configurationService.get<string>(ThemeSettings.PRODUCT_ICON_THEME) ??
      DEFAULT_PRODUCT_ICON_THEME_ID
    )
  }
}
