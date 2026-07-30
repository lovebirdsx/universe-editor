/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/services/getIconClasses.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * 文件/文件夹 → 图标类名协议（VSCode `getIconClasses` 的对等物，裁剪版）。
 *
 * 这些是「驱动 JSON 图标主题 CSS」的协议类名：FileIcon 在 JSON 主题模式下
 * 只输出这些类，具体图形由 `style.contributedFileIconTheme` 里的选择器决定。
 * 类名拼装规则必须与 `services/themes/generateFileIconThemeCss.ts` 一致：
 * - 文件：`file-icon` + `<每条完整后缀链>-ext-file-icon` + `<小写文件名>-name-file-icon`
 *   （+ `<languageId>-lang-file-icon`，语言兜底）
 * - 文件夹：`folder-icon` / 根 `rootfolder-icon` + `<小写名>-name-folder-icon`
 *   （根用 `-root-name-folder-icon`）
 * - 空白替换成 `/`（VSCode `fileIconSelectorEscape`），`/` 保留原样，
 *   其余特殊字符经 CSS 转义。
 */

import { basenameOfResource } from './resourceInfo.js'
import type { URI } from '@universe-editor/platform'

/** Mirrors VSCode fileIconSelectorEscape: whitespace is not allowed in classes. */
export function fileIconSelectorEscape(str: string): string {
  return str.replace(/\s/g, '/')
}

// Keep in sync with cssClassName in generateFileIconThemeCss.ts ('/' stays
// verbatim — VSCode emits it unescaped and the themes' selectors rely on it).
function cssClassPart(str: string): string {
  return fileIconSelectorEscape(str).replace(/[^_a-zA-Z0-9/-]/g, (ch) => {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) {
      return `\\${code.toString(16)} `
    }
    return ch
  })
}

/** Join a name with its class suffix (see classSelector in the CSS generator). */
const HEX_ESCAPE_WITH_TRAILING_SPACE = /\\[0-9a-f]{1,6} $/

function classSelector(name: string, suffix: string): string {
  const part = cssClassPart(name.toLowerCase())
  if (HEX_ESCAPE_WITH_TRAILING_SPACE.test(part) && /^[a-z]/.test(suffix)) {
    return part.slice(0, -1) + suffix
  }
  return part + suffix
}

export interface FileIconClassOptions {
  readonly isDirectory: boolean
  /** The directory is the workspace root folder (VSCode `rootfolder-icon`). */
  readonly isRoot?: boolean
  /** Language id used for the `lang-file-icon` fallback (files only). */
  readonly languageId?: string | undefined
}

/**
 * Protocol class list for a resource (no `show-file-icons` — that gate lives on
 * the workbench container). Specificity is carried by the extra `.ext-file-icon`
 * / `.name-file-icon` segments emitted in the generated stylesheet.
 */
export function getFileIconClasses(resource: URI, options: FileIconClassOptions): string[] {
  const classes: string[] = []
  const name = basenameOfResource(resource).toLowerCase()

  if (options.isDirectory) {
    classes.push(options.isRoot === true ? 'rootfolder-icon' : 'folder-icon')
    if (name.length > 0) {
      classes.push(
        classSelector(
          name,
          options.isRoot === true ? '-root-name-folder-icon' : '-name-folder-icon',
        ),
      )
    }
    return classes
  }

  classes.push('file-icon')
  if (name.length > 0) {
    classes.push(classSelector(name, '-name-file-icon'))
    // Every full suffix chain: foo.spec.ts → 'spec.ts', 'ts' (VSCode pushes
    // `dotSegments.slice(i).join('.')` for each i ≥ 1; capped at 255 chars).
    if (name.length <= 255) {
      const dotSegments = name.split('.')
      for (let i = 1; i < dotSegments.length; i++) {
        classes.push(classSelector(dotSegments.slice(i).join('.'), '-ext-file-icon'))
      }
    }
  }
  if (options.languageId !== undefined && options.languageId.length > 0) {
    classes.push(classSelector(options.languageId, '-lang-file-icon'))
  }
  return classes
}
