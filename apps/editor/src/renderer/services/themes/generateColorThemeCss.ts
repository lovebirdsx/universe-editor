/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/browser/colorThemeCss.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * 把主题解析后的颜色物化为 `--vscode-*` CSS 变量块（纯函数）。
 */

import { asCssVariableName, getColorRegistry, type IColorTheme } from '@universe-editor/platform'

export function generateColorThemeCSS(theme: IColorTheme, scopeSelector = ':root'): string {
  const parts: string[] = []
  parts.push(`${scopeSelector} {`)
  for (const item of getColorRegistry().getColors()) {
    const color = theme.getColor(item.id, true)
    if (color) {
      parts.push(`  ${asCssVariableName(item.id)}: ${color.toString()};`)
    }
  }
  parts.push('}')
  return parts.join('\n')
}
