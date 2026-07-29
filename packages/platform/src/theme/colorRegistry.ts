/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/colorUtils.ts
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../base/color.js'
import { Emitter, type Event } from '../base/event.js'
import type { IJSONSchema } from '../configuration/jsonSchemaRegistry.js'
import { localize } from '../nls/nls.js'
import type { IColorTheme } from './themeService.js'

//  ------ API types

export type ColorIdentifier = string

export interface ColorContribution {
  readonly id: ColorIdentifier
  readonly description: string
  readonly defaults: ColorDefaults | ColorValue | null
  readonly needsTransparency: boolean
  readonly deprecationMessage: string | undefined
}

/**
 * Returns the css variable name for the given color identifier. Dots (`.`) are replaced with hyphens (`-`) and
 * everything is prefixed with `--vscode-`.
 *
 * @sample `editorSuggestWidget.background` is `--vscode-editorSuggestWidget-background`.
 */
export function asCssVariableName(colorIdent: ColorIdentifier): string {
  return `--vscode-${colorIdent.replace(/\./g, '-')}`
}

export function asCssVariable(color: ColorIdentifier): string {
  return `var(${asCssVariableName(color)})`
}

export function asCssVariableWithDefault(color: ColorIdentifier, defaultCssValue: string): string {
  return `var(${asCssVariableName(color)}, ${defaultCssValue})`
}

export type ColorTransform =
  | { op: 'darken'; value: ColorValue; factor: number }
  | { op: 'lighten'; value: ColorValue; factor: number }
  | { op: 'transparent'; value: ColorValue; factor: number }
  | { op: 'opaque'; value: ColorValue; background: ColorValue }
  | { op: 'oneOf'; values: readonly ColorValue[] }
  | {
      op: 'lessProminent'
      value: ColorValue
      background: ColorValue
      factor: number
      transparency: number
    }
  | { op: 'ifDefinedThenElse'; if: ColorIdentifier; then: ColorValue; else: ColorValue }
  | { op: 'mix'; color: ColorValue; with: ColorValue; ratio?: number }

export interface ColorDefaults {
  light: ColorValue | null
  dark: ColorValue | null
  hcDark: ColorValue | null
  hcLight: ColorValue | null
}

export function isColorDefaults(value: unknown): value is ColorDefaults {
  return value !== null && typeof value === 'object' && 'light' in value && 'dark' in value
}

/**
 * A Color Value is either a color literal, a reference to an other color or a derived color
 */
export type ColorValue = Color | string | ColorIdentifier | ColorTransform

/**
 * Value in theme files and color customizations that restores the registry default.
 */
export const DEFAULT_COLOR_CONFIG_VALUE = 'default'

export interface IColorRegistry {
  readonly onDidChangeSchema: Event<void>

  /**
   * Register a color to the registry.
   * @param id The color id as used in theme description files
   * @param defaults The default values
   * @param description the description
   * @param needsTransparency Whether the color requires transparency
   */
  registerColor(
    id: string,
    defaults: ColorDefaults | ColorValue | null,
    description: string,
    needsTransparency?: boolean,
    deprecationMessage?: string,
  ): ColorIdentifier

  /**
   * Deregister a color from the registry.
   */
  deregisterColor(id: string): void

  /**
   * Get all color contributions
   */
  getColors(): ColorContribution[]

  /**
   * Gets the default color of the given id
   */
  resolveDefaultColor(id: ColorIdentifier, theme: IColorTheme): Color | undefined

  /**
   * JSON schema for an object to assign color values to one of the color contributions.
   */
  getColorSchema(): IJSONSchema

  /**
   * JSON schema for a reference to a color contribution.
   */
  getColorReferenceSchema(): IJSONSchema

  /**
   * Update the default color of a color identifier.
   */
  updateDefaultColor(id: string, defaults: ColorDefaults | ColorValue | null): void
}

class ColorRegistryImpl implements IColorRegistry {
  private readonly _onDidChangeSchema = new Emitter<void>()
  readonly onDidChangeSchema: Event<void> = this._onDidChangeSchema.event

  private readonly colorsById: { [key: string]: ColorContribution } = {}
  private colorSchema: IJSONSchema & { properties: Record<string, IJSONSchema> } = {
    type: 'object',
    properties: {},
  }
  private colorReferenceSchema: IJSONSchema & { enum: string[]; enumDescriptions: string[] } = {
    type: 'string',
    enum: [],
    enumDescriptions: [],
  }

  registerColor(
    id: string,
    defaults: ColorDefaults | ColorValue | null,
    description: string,
    needsTransparency = false,
    deprecationMessage?: string,
  ): ColorIdentifier {
    const colorContribution: ColorContribution = {
      id,
      description,
      defaults,
      needsTransparency,
      deprecationMessage,
    }
    this.colorsById[id] = colorContribution

    const propertySchema: IJSONSchema = { type: 'string', format: 'color-hex' }
    if (deprecationMessage) {
      propertySchema.deprecationMessage = deprecationMessage
    }
    if (needsTransparency) {
      propertySchema.pattern =
        '^#(?:(?<rgba>[0-9a-fA-f]{3}[0-9a-eA-E])|(?:[0-9a-fA-F]{6}(?:(?![fF]{2})(?:[0-9a-fA-F]{2}))))?$'
      propertySchema.patternErrorMessage = localize(
        'transparencyRequired',
        'This color must be transparent or it will obscure content',
      )
    }
    this.colorSchema.properties[id] = {
      description,
      oneOf: [
        propertySchema,
        {
          type: 'string',
          enum: [DEFAULT_COLOR_CONFIG_VALUE],
          description: localize('useDefault', 'Use the default color.'),
        },
      ],
    }
    this.colorReferenceSchema.enum.push(id)
    this.colorReferenceSchema.enumDescriptions.push(description)

    this._onDidChangeSchema.fire()
    return id
  }

  deregisterColor(id: string): void {
    delete this.colorsById[id]
    delete this.colorSchema.properties[id]
    const index = this.colorReferenceSchema.enum.indexOf(id)
    if (index !== -1) {
      this.colorReferenceSchema.enum.splice(index, 1)
      this.colorReferenceSchema.enumDescriptions.splice(index, 1)
    }
    this._onDidChangeSchema.fire()
  }

  getColors(): ColorContribution[] {
    return Object.keys(this.colorsById).map((id) => this.colorsById[id]!)
  }

  resolveDefaultColor(id: ColorIdentifier, theme: IColorTheme): Color | undefined {
    const colorDesc = this.colorsById[id]
    if (colorDesc?.defaults) {
      const colorValue = isColorDefaults(colorDesc.defaults)
        ? colorDesc.defaults[theme.type]
        : colorDesc.defaults
      return resolveColorValue(colorValue, theme)
    }
    return undefined
  }

  getColorSchema(): IJSONSchema {
    return this.colorSchema
  }

  getColorReferenceSchema(): IJSONSchema {
    return this.colorReferenceSchema
  }

  updateDefaultColor(id: string, defaults: ColorDefaults | ColorValue | null): void {
    const existing = this.colorsById[id]
    if (existing) {
      this.colorsById[id] = { ...existing, defaults }
    }
  }

  toString(): string {
    const sorter = (a: string, b: string) => {
      const cat1 = a.indexOf('.') === -1 ? 0 : 1
      const cat2 = b.indexOf('.') === -1 ? 0 : 1
      if (cat1 !== cat2) {
        return cat1 - cat2
      }
      return a.localeCompare(b)
    }

    return Object.keys(this.colorsById)
      .sort(sorter)
      .map((k) => `- \`${k}\`: ${this.colorsById[k]!.description}`)
      .join('\n')
  }
}

const colorRegistry = new ColorRegistryImpl()

export function registerColor(
  id: string,
  defaults: ColorDefaults | ColorValue | null,
  description: string,
  needsTransparency?: boolean,
  deprecationMessage?: string,
): ColorIdentifier {
  return colorRegistry.registerColor(
    id,
    defaults,
    description,
    needsTransparency,
    deprecationMessage,
  )
}

export function getColorRegistry(): IColorRegistry {
  return colorRegistry
}

// ----- color functions

export function executeTransform(transform: ColorTransform, theme: IColorTheme): Color | undefined {
  switch (transform.op) {
    case 'darken':
      return resolveColorValue(transform.value, theme)?.darken(transform.factor)

    case 'lighten':
      return resolveColorValue(transform.value, theme)?.lighten(transform.factor)

    case 'transparent':
      return resolveColorValue(transform.value, theme)?.transparent(transform.factor)

    case 'mix': {
      const primaryColor = resolveColorValue(transform.color, theme) || Color.transparent
      const otherColor = resolveColorValue(transform.with, theme) || Color.transparent
      return primaryColor.mix(otherColor, transform.ratio)
    }

    case 'opaque': {
      const backgroundColor = resolveColorValue(transform.background, theme)
      if (!backgroundColor) {
        return resolveColorValue(transform.value, theme)
      }
      return resolveColorValue(transform.value, theme)?.makeOpaque(backgroundColor)
    }

    case 'oneOf':
      for (const candidate of transform.values) {
        const color = resolveColorValue(candidate, theme)
        if (color) {
          return color
        }
      }
      return undefined

    case 'ifDefinedThenElse':
      return resolveColorValue(theme.defines(transform.if) ? transform.then : transform.else, theme)

    case 'lessProminent': {
      const from = resolveColorValue(transform.value, theme)
      if (!from) {
        return undefined
      }

      const backgroundColor = resolveColorValue(transform.background, theme)
      if (!backgroundColor) {
        return from.transparent(transform.factor * transform.transparency)
      }

      return from.isDarkerThan(backgroundColor)
        ? Color.getLighterColor(from, backgroundColor, transform.factor).transparent(
            transform.transparency,
          )
        : Color.getDarkerColor(from, backgroundColor, transform.factor).transparent(
            transform.transparency,
          )
    }
    default: {
      const exhaustiveCheck: never = transform
      throw new Error(`Unknown color transform: ${JSON.stringify(exhaustiveCheck)}`)
    }
  }
}

export function darken(colorValue: ColorValue, factor: number): ColorTransform {
  return { op: 'darken', value: colorValue, factor }
}

export function lighten(colorValue: ColorValue, factor: number): ColorTransform {
  return { op: 'lighten', value: colorValue, factor }
}

export function transparent(colorValue: ColorValue, factor: number): ColorTransform {
  return { op: 'transparent', value: colorValue, factor }
}

export function opaque(colorValue: ColorValue, background: ColorValue): ColorTransform {
  return { op: 'opaque', value: colorValue, background }
}

export function oneOf(...colorValues: ColorValue[]): ColorTransform {
  return { op: 'oneOf', values: colorValues }
}

export function mix(color: ColorValue, withColor: ColorValue, ratio?: number): ColorTransform {
  return ratio === undefined
    ? { op: 'mix', color, with: withColor }
    : { op: 'mix', color, with: withColor, ratio }
}

export function ifDefinedThenElse(
  ifArg: ColorIdentifier,
  thenArg: ColorValue,
  elseArg: ColorValue,
): ColorTransform {
  return { op: 'ifDefinedThenElse', if: ifArg, then: thenArg, else: elseArg }
}

export function lessProminent(
  colorValue: ColorValue,
  backgroundColorValue: ColorValue,
  factor: number,
  transparency: number,
): ColorTransform {
  return {
    op: 'lessProminent',
    value: colorValue,
    background: backgroundColorValue,
    factor,
    transparency,
  }
}

// ----- implementation

/**
 * Resolve a color value in the context of a theme
 */
export function resolveColorValue(
  colorValue: ColorValue | null,
  theme: IColorTheme,
): Color | undefined {
  if (colorValue === null) {
    return undefined
  } else if (typeof colorValue === 'string') {
    if (colorValue[0] === '#') {
      return Color.fromHex(colorValue)
    }
    // A plain string is a reference to another color id; fall back to CSS
    // literal parsing so rgba()/rgb()/named defaults are accepted too.
    const byId = theme.getColor(colorValue)
    if (byId) {
      return byId
    }
    return Color.Format.CSS.parse(colorValue) ?? undefined
  } else if (colorValue instanceof Color) {
    return colorValue
  } else if (typeof colorValue === 'object') {
    return executeTransform(colorValue, theme)
  }
  return undefined
}

export const workbenchColorsSchemaId = 'universe-editor://schemas/workbench-colors'
