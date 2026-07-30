/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/themeService.ts
 *--------------------------------------------------------------------------------------------*/

import type { Color } from '../base/color.js'
import type { Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'
import type { ColorIdentifier } from './colorRegistry.js'
import type { ColorScheme } from './colorScheme.js'
import type { IconContribution, IconDefinition } from './iconRegistry.js'

export const IThemeService = createDecorator<IThemeService>('themeService')

export function themeColorFromId(id: ColorIdentifier) {
  return { id }
}

export interface ITokenStyle {
  readonly foreground: number | undefined
  readonly bold: boolean | undefined
  readonly underline: boolean | undefined
  readonly strikethrough: boolean | undefined
  readonly italic: boolean | undefined
}

export interface IColorTheme {
  readonly type: ColorScheme

  readonly label: string

  /**
   * Resolves the color of the given color identifier. If the theme does not
   * specify the color, the default color is returned unless `useDefault` is set to false.
   */
  getColor(color: ColorIdentifier, useDefault?: boolean): Color | undefined

  /**
   * Returns whether the theme defines a value for the color. If not, that means the
   * default color will be used.
   */
  defines(color: ColorIdentifier): boolean

  /**
   * Returns the token style for a given semantic token classification. The
   * returned `foreground` is an index into {@link tokenColorMap}.
   */
  getTokenStyleMetadata(
    type: string,
    modifiers: string[],
    modelLanguage: string,
  ): ITokenStyle | undefined

  /**
   * List of all colors used with tokens. `getTokenStyleMetadata` references
   * the colors by index into this list.
   */
  readonly tokenColorMap: string[]

  /**
   * Defines whether semantic highlighting should be enabled for the theme.
   */
  readonly semanticHighlighting: boolean
}

export interface IFileIconTheme {
  readonly id: string
  readonly label: string
  readonly settingsId: string | null
  readonly hasFileIcons: boolean
  readonly hasFolderIcons: boolean
  readonly hidesExplorerArrows: boolean
}

export type { IconContribution, IconDefinition } from './iconRegistry.js'

export interface IProductIconTheme {
  readonly id: string
  readonly label: string
  readonly settingsId: string
  /**
   * Resolves the definition for the given icon as defined by the theme.
   */
  getIcon(iconContribution: IconContribution): IconDefinition | undefined
}

export interface IThemeService {
  readonly _serviceBrand: undefined

  getColorTheme(): IColorTheme

  readonly onDidColorThemeChange: Event<IColorTheme>

  getFileIconTheme(): IFileIconTheme

  readonly onDidFileIconThemeChange: Event<IFileIconTheme>

  /**
   * Apply a file icon theme by settingsId or full theme id. Pass `undefined` to
   * select the built-in default; `null` is the explicit "None" choice (icons
   * rendered programmatically by the embedding workbench). Serialized through
   * the theme service's promise chain like color themes.
   */
  setFileIconTheme(
    themeIdOrSettingsId: string | null | undefined,
  ): Promise<IFileIconTheme | undefined>

  getProductIconTheme(): IProductIconTheme

  readonly onDidProductIconThemeChange: Event<IProductIconTheme>

  /**
   * Apply a product icon theme by settingsId or full theme id; `undefined` /
   * unknown ids fall back to the default (built-in codicons).
   */
  setProductIconTheme(
    themeIdOrSettingsId: string | undefined,
  ): Promise<IProductIconTheme | undefined>
}
