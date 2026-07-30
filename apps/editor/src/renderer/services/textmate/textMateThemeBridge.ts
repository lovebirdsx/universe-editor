/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Color theme → vscode-textmate IRawTheme conversion (VSCode
 *  `TextMateTokenizationFeature._updateTheme` equivalent).
 *--------------------------------------------------------------------------------------------*/

import type { IRawTheme } from 'vscode-textmate'
import type { ColorThemeData } from '../themes/colorThemeData.js'

type IRawThemeSetting = IRawTheme['settings'][number]

/**
 * Convert the color theme's TextMate rules into vscode-textmate's IRawTheme.
 * The font channel (fontFamily/fontSize/lineHeight) is dropped on purpose:
 * monaco 0.55 has no token-font rendering, so only color + fontStyle survive.
 */
export function toTextMateRawTheme(themeData: ColorThemeData): IRawTheme {
  const settings: IRawThemeSetting[] = themeData.tokenColors.map((rule) => ({
    ...(rule.name !== undefined ? { name: rule.name } : {}),
    ...(rule.scope !== undefined ? { scope: rule.scope } : {}),
    settings: {
      ...(rule.settings.fontStyle !== undefined ? { fontStyle: rule.settings.fontStyle } : {}),
      ...(rule.settings.foreground !== undefined ? { foreground: rule.settings.foreground } : {}),
      ...(rule.settings.background !== undefined ? { background: rule.settings.background } : {}),
    },
  }))
  return { name: themeData.label, settings }
}
