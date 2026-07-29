/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/theme.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * Color scheme used by the OS and by color themes.
 */
export enum ColorScheme {
  DARK = 'dark',
  LIGHT = 'light',
  HIGH_CONTRAST_DARK = 'hcDark',
  HIGH_CONTRAST_LIGHT = 'hcLight',
}

export enum ThemeTypeSelector {
  VS = 'vs',
  VS_DARK = 'vs-dark',
  HC_BLACK = 'hc-black',
  HC_LIGHT = 'hc-light',
}

export function isHighContrast(scheme: ColorScheme): boolean {
  return scheme === ColorScheme.HIGH_CONTRAST_DARK || scheme === ColorScheme.HIGH_CONTRAST_LIGHT
}

export function isDark(scheme: ColorScheme): boolean {
  return scheme === ColorScheme.DARK || scheme === ColorScheme.HIGH_CONTRAST_DARK
}

export function isLight(scheme: ColorScheme): boolean {
  return scheme === ColorScheme.LIGHT
}

export function getThemeTypeSelector(type: ColorScheme): ThemeTypeSelector {
  switch (type) {
    case ColorScheme.DARK:
      return ThemeTypeSelector.VS_DARK
    case ColorScheme.HIGH_CONTRAST_DARK:
      return ThemeTypeSelector.HC_BLACK
    case ColorScheme.HIGH_CONTRAST_LIGHT:
      return ThemeTypeSelector.HC_LIGHT
    default:
      return ThemeTypeSelector.VS
  }
}

export function colorSchemeFromTypeSelector(selector: ThemeTypeSelector): ColorScheme {
  switch (selector) {
    case ThemeTypeSelector.VS_DARK:
      return ColorScheme.DARK
    case ThemeTypeSelector.HC_BLACK:
      return ColorScheme.HIGH_CONTRAST_DARK
    case ThemeTypeSelector.HC_LIGHT:
      return ColorScheme.HIGH_CONTRAST_LIGHT
    default:
      return ColorScheme.LIGHT
  }
}
