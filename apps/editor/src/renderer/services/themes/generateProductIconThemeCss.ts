/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/browser/iconsStyleSheet.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * 产品图标样式表生成（VSCode `getIconsStyleSheet` 的对等物）。
 *
 * 遍历 IconRegistry 里登记的每个 codicon，问当前产品图标主题拿定义，输出：
 * - `.codicon-<id>:before { content: '\e001'; font-family: 'pi-<fontId>'; }`
 *   （主题覆盖的图标）或只覆写 content（默认 codicon 字体时）；
 * - 用到的自定义字体生成 `@font-face`（font-display: block）；
 * - `:root` 上同时写 `--vscode-icon-<id>-font-family` / `-content` 变量
 *   （对齐 VSCode，给不走 :before 伪元素的消费方用）。
 *
 * 默认主题（无覆盖）返回空串 —— codicon.css 自带的规则就是基线。
 */

import {
  getIconRegistry,
  type IconFontDefinition,
  type IProductIconTheme,
} from '@universe-editor/platform'
import { cssClassName, cssStringValue } from './generateFileIconThemeCss.js'

/**
 * Build the product icon stylesheet for the given theme. `resolveResourceUrl`
 * maps a font location (absolute URI string, scheme file) to a loadable URL
 * (universe-app resource URL).
 */
export function generateProductIconThemeCss(
  productIconTheme: IProductIconTheme,
  resolveResourceUrl: (location: string) => string,
): string {
  const usedFontIds = new Map<string, IconFontDefinition>()
  const rules: string[] = []
  const rootAttribs: string[] = []

  for (const contribution of getIconRegistry().getIcons()) {
    const definition = productIconTheme.getIcon(contribution)
    if (definition === undefined) {
      continue
    }
    const fontContribution = definition.font
    const fontFamilyVar = `--vscode-icon-${cssClassName(contribution.id)}-font-family`
    const contentVar = `--vscode-icon-${cssClassName(contribution.id)}-content`
    if (fontContribution !== undefined) {
      usedFontIds.set(fontContribution.id, fontContribution.definition)
      rootAttribs.push(
        `${fontFamilyVar}: ${cssStringValue(fontContribution.id)};`,
        `${contentVar}: ${cssStringValue(definition.fontCharacter)};`,
      )
      rules.push(
        `.codicon-${cssClassName(contribution.id)}:before { content: ${cssStringValue(
          definition.fontCharacter,
        )}; font-family: ${cssStringValue(fontContribution.id)}; }`,
      )
    } else {
      rootAttribs.push(
        `${contentVar}: ${cssStringValue(definition.fontCharacter)}; ${fontFamilyVar}: 'codicon';`,
      )
      rules.push(
        `.codicon-${cssClassName(contribution.id)}:before { content: ${cssStringValue(
          definition.fontCharacter,
        )}; }`,
      )
    }
  }

  for (const [id, definition] of usedFontIds) {
    const src = definition.src
      .map(
        (l) =>
          `url(${cssStringValue(resolveResourceUrl(l.location))}) format(${cssStringValue(l.format)})`,
      )
      .join(', ')
    const weight = definition.weight !== undefined ? `font-weight: ${definition.weight}; ` : ''
    const style = definition.style !== undefined ? `font-style: ${definition.style}; ` : ''
    rules.push(
      `@font-face { src: ${src}; font-family: ${cssStringValue(id)}; ${weight}${style}font-display: block; }`,
    )
  }

  if (rootAttribs.length > 0) {
    rules.push(`:root { ${rootAttribs.join(' ')} }`)
  }
  return rules.join('\n')
}
