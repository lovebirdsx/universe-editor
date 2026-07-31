/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Color theme → vscode-textmate IRawTheme conversion (VSCode
 *  `TextMateTokenizationFeature._updateTheme` equivalent).
 *--------------------------------------------------------------------------------------------*/

import type { IRawTheme } from 'vscode-textmate'
import { normalizeTokenColor, type ColorThemeData } from '../themes/colorThemeData.js'

type IRawThemeSetting = IRawTheme['settings'][number]

/**
 * Convert the color theme's TextMate rules into vscode-textmate's IRawTheme.
 * The font channel (fontFamily/fontSize/lineHeight) is dropped on purpose:
 * monaco 0.55 has no token-font rendering, so only color + fontStyle survive.
 *
 * Rule colors go through the same normalization as the tokenColorMap entries
 * (6-digit upper-case hex): vscode-textmate's frozen ColorMap looks colors up
 * literally and throws "Missing color" on any mismatch.
 */
export function toTextMateRawTheme(themeData: ColorThemeData): IRawTheme {
  const settings: IRawThemeSetting[] = themeData.tokenColors.map((rule) => {
    const foreground = normalizeTokenColor(rule.settings.foreground)
    const background = normalizeTokenColor(rule.settings.background)
    return {
      ...(rule.name !== undefined ? { name: rule.name } : {}),
      ...(rule.scope !== undefined ? { scope: rule.scope } : {}),
      settings: {
        ...(rule.settings.fontStyle !== undefined ? { fontStyle: rule.settings.fontStyle } : {}),
        ...(foreground !== undefined ? { foreground } : {}),
        ...(background !== undefined ? { background } : {}),
      },
    }
  })
  return { name: themeData.label, settings }
}
