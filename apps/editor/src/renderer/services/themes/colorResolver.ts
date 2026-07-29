/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 用户颜色定制（`workbench.colorCustomizations`）的解析与注入 —— VSCode
 * `ColorThemeData.setCustomColors` 链路的纯函数部分。
 */

import { Color, DEFAULT_COLOR_CONFIG_VALUE, type ColorIdentifier } from '@universe-editor/platform'

export type ColorCustomizationMap = Record<string, string>

export interface IResolvedCustomizations {
  /** 解析成功的覆盖值；`'default'` 保留字面量（语义 = 还原注册表默认）。 */
  readonly colors: Record<string, Color | typeof DEFAULT_COLOR_CONFIG_VALUE>
  /** 非法颜色值（已跳过），用于诊断输出。 */
  readonly invalid: readonly string[]
}

/**
 * 解析用户定制表：hex 字符串转 Color，`'default'` 保留字面量，非法值跳过并记录。
 */
export function resolveColorCustomizations(
  customizations: ColorCustomizationMap,
): IResolvedCustomizations {
  const colors: Record<string, Color | typeof DEFAULT_COLOR_CONFIG_VALUE> = {}
  const invalid: string[] = []
  for (const [colorId, value] of Object.entries(customizations)) {
    if (value === DEFAULT_COLOR_CONFIG_VALUE) {
      colors[colorId] = DEFAULT_COLOR_CONFIG_VALUE
    } else if (typeof value === 'string') {
      const parsed = Color.Format.CSS.parseHex(value)
      if (parsed) {
        colors[colorId] = parsed
      } else {
        invalid.push(colorId)
      }
    } else {
      invalid.push(colorId)
    }
  }
  return { colors, invalid }
}

/**
 * 合并全局定制与主题作用域定制（`"[theme settingsId]": {...}` 块），
 * 主题作用域优先 —— 对齐 VSCode `ThemeConfiguration.colorCustomizations` 语义。
 */
export function mergeColorCustomizations(
  global: ColorCustomizationMap,
  perTheme: ColorCustomizationMap | undefined,
): ColorCustomizationMap {
  if (!perTheme) {
    return { ...global }
  }
  return { ...global, ...perTheme }
}

/** 从原始配置对象（可能混有 `"[theme]"` 块）拆出全局颜色键。 */
export function splitColorCustomizations(raw: unknown): {
  global: ColorCustomizationMap
  perTheme: Record<string, ColorCustomizationMap>
} {
  const global: ColorCustomizationMap = {}
  const perTheme: Record<string, ColorCustomizationMap> = {}
  if (typeof raw !== 'object' || raw === null) {
    return { global, perTheme }
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const scoped = /^\[(.+)\]$/.exec(key)
    if (scoped) {
      if (typeof value === 'object' && value !== null) {
        perTheme[scoped[1]!] = filterStringValues(value as Record<string, unknown>)
      }
    } else if (typeof value === 'string') {
      global[key as ColorIdentifier] = value
    }
  }
  return { global, perTheme }
}

function filterStringValues(raw: Record<string, unknown>): ColorCustomizationMap {
  const result: ColorCustomizationMap = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      result[key] = value
    }
  }
  return result
}
