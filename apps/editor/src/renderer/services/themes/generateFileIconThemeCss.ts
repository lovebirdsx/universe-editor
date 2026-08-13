/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/browser/fileIconThemeData.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * 文件图标主题 JSON → CSS 的纯函数生成器（VSCode `FileIconThemeLoader.
 * processIconThemeDocument` 的对等物）。
 *
 * 机制（选择器驱动）：
 * - 每个 iconDefinition 映射到一组 CSS 选择器：folder/file 默认、folderNames
 *   （`<name>-name-folder-icon`）、fileExtensions（`<ext>-ext-file-icon`）、
 *   fileNames（`<name>-name-file-icon`）、languageIds（`<lang>-lang-file-icon`）；
 * - 特异性提分与 VSCode 相同：扩展名/文件名选择器追加一个提分类段
 *   （`.ext-file-icon` / `.name-file-icon`），保证 fileNames > fileExtensions >
 *   languageIds > file/folder 默认的覆盖顺序；
 * - 图片定义 → `content: '\2001'; background-image: url(...)`（em quad 占位防塌）；
 * - 字形定义 → `content: '<char>'; color; font-family; font-size`，字体走
 *   `@font-face`（font-display: block）；
 * - `light` / `highContrast` 块生成 `.vs` / `.hc-black`/`.hc-light` 前缀变体。
 *
 * 与 VSCode 的两处刻意差异：
 * - `folderNames` 里带 `/` 的「父目录/子目录」组合（handleParentFolder）不支持，
 *   键按普通名字处理（我们的图标协议没有 `name-dir-icon` 段）；
 * - `showLanguageModeIcons` 的「未覆盖语言用语言服务默认图标兜底」不实现——
 *   兜底落回 `file` 默认图标（我们的 FileIcon 渲染层始终输出协议类名，
 *   未命中任何条目时只带 `file-icon` 基类）。
 */

import { URI } from '@universe-editor/platform'

// ---------------------------------------------------------------------------
// Theme document shapes (VSCode fileIconThemeData.ts L156-194)
// ---------------------------------------------------------------------------

export interface IIconDefinition {
  readonly iconPath?: string
  readonly fontColor?: string
  readonly fontCharacter?: string
  readonly fontSize?: string
  readonly fontId?: string
}

export interface IFontDefinition {
  readonly id: string
  readonly weight?: string
  readonly style?: string
  readonly size?: string
  readonly src: readonly { readonly path: string; readonly format: string }[]
}

export interface IIconsAssociation {
  readonly folder?: string
  readonly file?: string
  readonly folderExpanded?: string
  readonly rootFolder?: string
  readonly rootFolderExpanded?: string
  readonly rootFolderNames?: Readonly<Record<string, string>>
  readonly rootFolderNamesExpanded?: Readonly<Record<string, string>>
  readonly folderNames?: Readonly<Record<string, string>>
  readonly folderNamesExpanded?: Readonly<Record<string, string>>
  readonly fileExtensions?: Readonly<Record<string, string>>
  readonly fileNames?: Readonly<Record<string, string>>
  readonly languageIds?: Readonly<Record<string, string>>
}

export interface IIconThemeDocument extends IIconsAssociation {
  readonly iconDefinitions?: Readonly<Record<string, IIconDefinition>>
  readonly fonts?: readonly IFontDefinition[]
  readonly light?: IIconsAssociation
  readonly highContrast?: IIconsAssociation
  readonly hidesExplorerArrows?: boolean
  readonly showLanguageModeIcons?: boolean
}

export interface IProcessedIconTheme {
  readonly content: string
  readonly hasFileIcons: boolean
  readonly hasFolderIcons: boolean
  readonly hidesExplorerArrows: boolean
}

// ---------------------------------------------------------------------------
// CSS value escaping (VSCode cssValue.ts 的裁剪移植)
// ---------------------------------------------------------------------------

/** Escape a string for use inside a single-quoted CSS string literal. */
export function cssStringValue(str: string): string {
  return `'${str.replace(/\\/g, '\\\\').replace(/'/g, '\\000027')}'`
}

/** Escape an arbitrary string for use as a CSS class name segment. */
export function cssClassName(str: string): string {
  // Mirrors CSS.escape for the characters we can encounter (identifiers and
  // paths); falls back to hex-escaping anything outside [_a-zA-Z0-9-].
  return str.replace(/[^_a-zA-Z0-9\/-]/g, (ch) => {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) {
      return `\\${code.toString(16)} `
    }
    return ch
  })
}

const VALID_HEX_COLOR = /^#[0-9a-f]{3,8}$/i

function cssHexColorValue(color: string): string | undefined {
  return VALID_HEX_COLOR.test(color) ? color : undefined
}

const VALID_IDENT = /^[_a-zA-Z][_a-zA-Z0-9-]*$/

function cssIdentValue(ident: string): string | undefined {
  return VALID_IDENT.test(ident) ? ident : undefined
}

function cssFontSizeValue(size: string): string | undefined {
  return /^\d+(\.\d+)?(px|%|em)$/.test(size) ? size : undefined
}

// ---------------------------------------------------------------------------
// Selector class parts —— DOM 侧协议在 workbench/files/fileIconClasses.ts，
// 两侧的段拼装规则必须一致（VSCode getIconClasses.ts 的对应协议）。
// ---------------------------------------------------------------------------

/**
 * VSCode `fileIconSelectorEscape`：类名里不允许空白，空白替换成 `/`（material
 * 等主题里有带空格的文件名键，如 "docker compose"）。
 */
function selectorEscape(str: string): string {
  return str.replace(/\s/g, '/')
}

function nameClassPart(name: string): string {
  return cssClassName(selectorEscape(name.toLowerCase()))
}

/**
 * Join a class part with its suffix, dropping the mandatory whitespace after a
 * trailing hex escape only when the next char cannot continue the escape
 * (CSS spec: the whitespace may be omitted if unambiguous).
 */
const HEX_ESCAPE_WITH_TRAILING_SPACE = /\\[0-9a-f]{1,6} $/

function classSelector(name: string, suffix: string): string {
  const part = nameClassPart(name)
  if (HEX_ESCAPE_WITH_TRAILING_SPACE.test(part) && /^[a-z]/.test(suffix)) {
    return part.slice(0, -1) + suffix
  }
  return part + suffix
}

const SHOW_FILE_ICONS = '.show-file-icons'
const FILE_ICON_BASE = '.file-icon'
const FOLDER_ICON_BASE = '.folder-icon'
const ROOT_FOLDER_ICON_BASE = '.rootfolder-icon'
// Expanded folder state: our FileIcon renders the expanded flag as the
// `.folder-expanded-icon` class on the icon element itself (VSCode drives it
// from the twistie's DOM state instead). The stylesheet targets that class
// directly, so no sibling/twistie markup is required.

function qualifierFor(baseThemeClassName: string | undefined): string {
  return baseThemeClassName === undefined
    ? SHOW_FILE_ICONS
    : `${baseThemeClassName} ${SHOW_FILE_ICONS}`
}

/** `.folder-icon` ↔ `.folder-expanded-icon` swap for expanded variants. */
function expandedVariant(selector: string): string {
  return selector.replace('-icon', '-expanded-icon')
}

// ---------------------------------------------------------------------------
// Font size normalization (VSCode tryNormalizeFontSize)
// ---------------------------------------------------------------------------

function tryNormalizeFontSize(fontSize: string): string | undefined {
  const match = fontSize.match(/^(\d+)(px|%|em)$/)
  if (match) {
    const value = parseInt(match[1]!, 10)
    const unit = match[2]!
    if (unit === 'px') {
      // VSCode: sizes in px are relative to the default size of 13px.
      return `${Math.round((value / 13) * 100)}%`
    }
    return `${value}${unit}`
  }
  return cssFontSizeValue(fontSize)
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Convert a parsed icon theme document into a stylesheet. `themeLocation` is the
 * theme JSON's URI; relative `iconPath` / font `src.path` values resolve against
 * its directory. `resolveResourceUrl` maps an absolute resource URI to a URL the
 * renderer can load (universe-app resource URL); defaults to the plain fsPath so
 * unit tests can assert deterministic paths.
 */
export function processIconThemeDocument(
  id: string,
  themeLocation: URI,
  doc: IIconThemeDocument,
  // 本机路径：图标/字体资源是随扩展安装的本地 file: 资源（默认解析器供单测断言确定路径）。
  resolveResourceUrl: (resource: URI) => string = (resource) => resource.fsPath,
): IProcessedIconTheme {
  // Mutable accumulator; the exported interface stays readonly for consumers.
  const result: { -readonly [K in keyof IProcessedIconTheme]: IProcessedIconTheme[K] } = {
    content: '',
    hasFileIcons: false,
    hasFolderIcons: false,
    hidesExplorerArrows: doc.hidesExplorerArrows === true,
  }

  if (doc.iconDefinitions === undefined) {
    return result
  }

  const iconThemeDocumentLocationDirname = URI.joinPath(themeLocation, '..')
  const resolvePath = (path: string): string =>
    resolveResourceUrl(URI.joinPath(iconThemeDocumentLocationDirname, path))

  const cssRules: string[] = []
  const fontCharacterMapping = new Map<string, string>()
  const fontColorMapping = new Map<string, string>()
  const fontSizeMapping = new Map<string, string>()
  const fontIdMapping = new Map<string, string>()
  const fonts = new Map<string, IFontDefinition>()

  if (Array.isArray(doc.fonts)) {
    for (const font of doc.fonts) {
      const fontId = font.id
      if (typeof fontId === 'string' && VALID_IDENT.test(fontId)) {
        fonts.set(fontId, font)
        if (Array.isArray(font.src)) {
          for (const src of font.src) {
            if (typeof src.path !== 'string' || typeof src.format !== 'string') {
              continue
            }
          }
        }
      }
    }
  }
  const primaryFontId = fonts.size > 0 ? Array.from(fonts.keys())[0]! : undefined

  // @font-face rules
  for (const font of fonts.values()) {
    if (!Array.isArray(font.src) || font.src.length === 0) {
      continue
    }
    const src = font.src
      .filter((s) => typeof s.path === 'string' && typeof s.format === 'string')
      .map((s) => `url(${cssStringValue(resolvePath(s.path))}) format(${cssStringValue(s.format)})`)
    if (src.length === 0) {
      continue
    }
    const weight = font.weight !== undefined ? cssIdentValue(font.weight) : undefined
    const style = font.style !== undefined ? cssIdentValue(font.style) : undefined
    cssRules.push(
      `@font-face { src: ${src.join(', ')}; font-family: ${cssStringValue(font.id)};` +
        `${weight !== undefined ? ` font-weight: ${weight};` : ''}` +
        `${style !== undefined ? ` font-style: ${style};` : ''} font-display: block; }`,
    )
  }

  // Global glyph baseline (first font) — VSCode applies fonts[0] at 150% to all
  // icon ::before elements so font-based themes look right without per-icon rules.
  const firstFont = primaryFontId !== undefined ? fonts.get(primaryFontId) : undefined
  if (firstFont !== undefined) {
    const defaultFontSize =
      firstFont.size !== undefined ? tryNormalizeFontSize(firstFont.size) : '150%'
    cssRules.push(
      `${SHOW_FILE_ICONS} ${FILE_ICON_BASE}::before, ${SHOW_FILE_ICONS} ${FOLDER_ICON_BASE}::before, ` +
        `${SHOW_FILE_ICONS} ${ROOT_FOLDER_ICON_BASE}::before { font-family: ${cssStringValue(
          firstFont.id,
        )}; font-size: ${defaultFontSize ?? '150%'}; }`,
    )
  }

  for (const [defId, def] of Object.entries(doc.iconDefinitions)) {
    if (def.fontCharacter !== undefined) {
      fontCharacterMapping.set(defId, def.fontCharacter)
      if (def.fontColor !== undefined) {
        const color = cssHexColorValue(def.fontColor)
        if (color !== undefined) {
          fontColorMapping.set(defId, color)
        }
      }
      if (def.fontSize !== undefined) {
        const size = tryNormalizeFontSize(def.fontSize)
        if (size !== undefined) {
          fontSizeMapping.set(defId, size)
        }
      }
      const fontId = def.fontId ?? primaryFontId
      if (fontId !== undefined && fonts.has(fontId)) {
        fontIdMapping.set(defId, fontId)
      }
    }
  }

  const byDefinitionId = new Map<string, string[]>()

  const collect = (definitionId: string | undefined, selector: string): void => {
    if (definitionId === undefined) {
      return
    }
    const list = byDefinitionId.get(definitionId)
    if (list === undefined) {
      byDefinitionId.set(definitionId, [selector])
    } else if (!list.includes(selector)) {
      list.push(selector)
    }
  }

  const collectAssociations = (associations: IIconsAssociation, qualifier: string): void => {
    if (associations.folder !== undefined) {
      result.hasFolderIcons = true
      collect(associations.folder, `${qualifier} ${FOLDER_ICON_BASE}::before`)
    }
    const folderExpanded = associations.folderExpanded ?? associations.folder
    if (folderExpanded !== undefined) {
      result.hasFolderIcons = true
      collect(folderExpanded, `${qualifier} ${expandedVariant(FOLDER_ICON_BASE)}::before`)
    }
    const rootFolder = associations.rootFolder ?? associations.folder
    if (rootFolder !== undefined) {
      result.hasFolderIcons = true
      collect(rootFolder, `${qualifier} ${ROOT_FOLDER_ICON_BASE}::before`)
    }
    const rootFolderExpanded = associations.rootFolderExpanded ?? folderExpanded
    if (rootFolderExpanded !== undefined) {
      result.hasFolderIcons = true
      collect(rootFolderExpanded, `${qualifier} ${expandedVariant(ROOT_FOLDER_ICON_BASE)}::before`)
    }
    if (associations.file !== undefined) {
      result.hasFileIcons = true
      collect(associations.file, `${qualifier} ${FILE_ICON_BASE}::before`)
    }

    if (associations.rootFolderNames !== undefined) {
      for (const [name, definitionId] of Object.entries(associations.rootFolderNames)) {
        result.hasFolderIcons = true
        collect(
          definitionId,
          `${qualifier} .${classSelector(name, '-root-name-folder-icon')}.rootfolder-icon::before`,
        )
      }
    }
    if (associations.rootFolderNamesExpanded !== undefined) {
      for (const [name, definitionId] of Object.entries(associations.rootFolderNamesExpanded)) {
        result.hasFolderIcons = true
        collect(
          definitionId,
          `${qualifier} .${classSelector(name, '-root-name-folder-icon')}.rootfolder-expanded-icon::before`,
        )
      }
    }
    if (associations.folderNames !== undefined) {
      for (const [name, definitionId] of Object.entries(associations.folderNames)) {
        result.hasFolderIcons = true
        collect(
          definitionId,
          `${qualifier} .${classSelector(name, '-name-folder-icon')}.folder-icon::before`,
        )
      }
    }
    if (associations.folderNamesExpanded !== undefined) {
      for (const [name, definitionId] of Object.entries(associations.folderNamesExpanded)) {
        result.hasFolderIcons = true
        collect(
          definitionId,
          `${qualifier} .${classSelector(name, '-name-folder-icon')}.folder-expanded-icon::before`,
        )
      }
    }
    if (associations.languageIds !== undefined) {
      const languageIds = { ...associations.languageIds }
      // VSCode: json icon also applies to jsonc.
      if (languageIds['jsonc'] === undefined && languageIds['json'] !== undefined) {
        languageIds['jsonc'] = languageIds['json']
      }
      for (const [lang, definitionId] of Object.entries(languageIds)) {
        result.hasFileIcons = true
        collect(
          definitionId,
          `${qualifier} .${classSelector(lang, '-lang-file-icon')}.file-icon::before`,
        )
      }
    }
    if (associations.fileExtensions !== undefined) {
      for (const [ext, definitionId] of Object.entries(associations.fileExtensions)) {
        result.hasFileIcons = true
        // Every full suffix chain gets its own class (foo.spec.ts →
        // 'spec.ts' AND 'ts'); the extra `.ext-file-icon` segment raises
        // specificity over language and default rules (VSCode's scoring trick).
        const dotSegments = ext.toLowerCase().split('.')
        for (let i = 0; i < dotSegments.length; i++) {
          const suffix = dotSegments.slice(i).join('.')
          if (suffix.length > 0) {
            collect(
              definitionId,
              `${qualifier} .${classSelector(suffix, '-ext-file-icon')}.ext-file-icon.file-icon::before`,
            )
          }
        }
      }
    }
    if (associations.fileNames !== undefined) {
      for (const [name, definitionId] of Object.entries(associations.fileNames)) {
        result.hasFileIcons = true
        const namePart = classSelector(name, '-name-file-icon')
        collect(definitionId, `${qualifier} .${namePart}.name-file-icon.file-icon::before`)
        // Also match the file's extension suffix chains (same tie-breaker
        // as VSCode; skip the bare name itself — index 0).
        const dotSegments = name.toLowerCase().split('.')
        for (let i = 1; i < dotSegments.length; i++) {
          const suffix = dotSegments.slice(i).join('.')
          if (suffix.length > 0) {
            collect(
              definitionId,
              `${qualifier} .${classSelector(suffix, '-ext-file-icon')}.ext-file-icon.file-icon::before`,
            )
          }
        }
      }
    }
  }

  collectAssociations(doc, qualifierFor(undefined))
  if (doc.light !== undefined) {
    collectAssociations(doc.light, qualifierFor('.vs'))
  }
  if (doc.highContrast !== undefined) {
    collectAssociations(doc.highContrast, qualifierFor('.hc-black'))
    collectAssociations(doc.highContrast, qualifierFor('.hc-light'))
  }

  // Emit one rule per definition id, selectors joined.
  for (const [defId, selectors] of byDefinitionId) {
    const definition = doc.iconDefinitions[defId]
    if (definition === undefined) {
      continue
    }
    const selector = selectors.join(', ')
    if (definition.iconPath !== undefined) {
      cssRules.push(
        `${selector} { content: '\\2001'; background-image: url(${cssStringValue(
          resolvePath(definition.iconPath),
        )}); }`,
      )
    } else {
      const fontCharacter = fontCharacterMapping.get(defId)
      if (fontCharacter !== undefined) {
        const declarations: string[] = [`content: ${cssStringValue(fontCharacter)}`]
        const color = fontColorMapping.get(defId)
        if (color !== undefined) {
          declarations.push(`color: ${color}`)
        }
        const size = fontSizeMapping.get(defId)
        if (size !== undefined) {
          declarations.push(`font-size: ${size}`)
        }
        const fontId = fontIdMapping.get(defId)
        if (fontId !== undefined) {
          declarations.push(`font-family: ${cssStringValue(fontId)}`)
        }
        cssRules.push(`${selector} { ${declarations.join('; ')}; }`)
      }
    }
  }

  result.content = cssRules.join('\n')
  return result
}
