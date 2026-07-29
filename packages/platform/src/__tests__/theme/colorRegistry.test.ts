/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/theme/colorRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Color } from '../../base/color.js'
import { ColorScheme } from '../../theme/colorScheme.js'
import {
  asCssVariable,
  asCssVariableName,
  asCssVariableWithDefault,
  darken,
  executeTransform,
  getColorRegistry,
  ifDefinedThenElse,
  lessProminent,
  lighten,
  mix,
  oneOf,
  opaque,
  registerColor,
  resolveColorValue,
  transparent,
} from '../../theme/colorRegistry.js'
import type { IColorTheme, ITokenStyle } from '../../theme/themeService.js'

function makeTheme(type: ColorScheme, colors: Record<string, string> = {}): IColorTheme {
  return {
    type,
    label: 'Test',
    semanticHighlighting: false,
    tokenColorMap: [],
    getColor: (id: string) => {
      const value = colors[id]
      return value ? Color.fromHex(value) : undefined
    },
    defines: (id: string) => id in colors,
    getTokenStyleMetadata: (): ITokenStyle | undefined => undefined,
  }
}

describe('asCssVariableName', () => {
  it('replaces dots with hyphens and prefixes --vscode-', () => {
    expect(asCssVariableName('editorSuggestWidget.background')).toBe(
      '--vscode-editorSuggestWidget-background',
    )
    expect(asCssVariableName('foreground')).toBe('--vscode-foreground')
    expect(asCssVariable('sideBar.background')).toBe('var(--vscode-sideBar-background)')
    expect(asCssVariableWithDefault('sideBar.background', '#000')).toBe(
      'var(--vscode-sideBar-background, #000)',
    )
  })
})

describe('ColorRegistry', () => {
  it('registers colors and resolves defaults per theme type', () => {
    const id = registerColor(
      'test.perType',
      { light: '#ffffff', dark: '#000000', hcDark: '#111111', hcLight: '#eeeeee' },
      'test color',
    )
    const registry = getColorRegistry()
    expect(registry.resolveDefaultColor(id, makeTheme(ColorScheme.LIGHT))?.toString()).toBe(
      '#ffffff',
    )
    expect(registry.resolveDefaultColor(id, makeTheme(ColorScheme.DARK))?.toString()).toBe(
      '#000000',
    )
    expect(
      registry.resolveDefaultColor(id, makeTheme(ColorScheme.HIGH_CONTRAST_DARK))?.toString(),
    ).toBe('#111111')
    registry.deregisterColor(id)
  })

  it('resolves a single ColorValue default regardless of theme type', () => {
    const id = registerColor('test.single', '#123456', 'test color')
    const registry = getColorRegistry()
    expect(registry.resolveDefaultColor(id, makeTheme(ColorScheme.LIGHT))?.toString()).toBe(
      '#123456',
    )
    expect(registry.resolveDefaultColor(id, makeTheme(ColorScheme.DARK))?.toString()).toBe(
      '#123456',
    )
    registry.deregisterColor(id)
  })

  it('resolves id-reference defaults through the theme', () => {
    const id = registerColor(
      'test.reference',
      { light: 'other.color', dark: 'other.color', hcDark: null, hcLight: null },
      'test color',
    )
    const registry = getColorRegistry()
    const theme = makeTheme(ColorScheme.DARK, { 'other.color': '#a0b0c0' })
    expect(registry.resolveDefaultColor(id, theme)?.toString()).toBe('#a0b0c0')
    registry.deregisterColor(id)
  })

  it('returns undefined for unknown ids and null defaults', () => {
    const registry = getColorRegistry()
    expect(
      registry.resolveDefaultColor('test.unknown', makeTheme(ColorScheme.DARK)),
    ).toBeUndefined()
    const id = registerColor('test.nullDefault', null, 'test color')
    expect(registry.resolveDefaultColor(id, makeTheme(ColorScheme.DARK))).toBeUndefined()
    registry.deregisterColor(id)
  })

  it('exposes registered ids in the color schema and reference schema', () => {
    const id = registerColor(
      'test.schema',
      { light: null, dark: '#000000', hcDark: null, hcLight: null },
      'schema color',
    )
    const registry = getColorRegistry()
    const colorSchema = registry.getColorSchema()
    expect(colorSchema.properties?.[id]?.description).toBe('schema color')
    expect(registry.getColorReferenceSchema().enum).toContain(id)
    registry.deregisterColor(id)
    expect(registry.getColorReferenceSchema().enum).not.toContain(id)
  })

  it('updateDefaultColor replaces defaults', () => {
    const id = registerColor(
      'test.update',
      { light: null, dark: '#000000', hcDark: null, hcLight: null },
      'updatable',
    )
    const registry = getColorRegistry()
    registry.updateDefaultColor(id, { light: null, dark: '#101010', hcDark: null, hcLight: null })
    expect(registry.resolveDefaultColor(id, makeTheme(ColorScheme.DARK))?.toString()).toBe(
      '#101010',
    )
    registry.deregisterColor(id)
  })
})

describe('resolveColorValue', () => {
  const theme = makeTheme(ColorScheme.DARK, { 'base.color': '#204060' })

  it('resolves hex strings, id references and Color instances', () => {
    expect(resolveColorValue('#ff0000', theme)?.toString()).toBe('#ff0000')
    expect(resolveColorValue('base.color', theme)?.toString()).toBe('#204060')
    const c = Color.fromHex('#010203')
    expect(resolveColorValue(c, theme)).toBe(c)
    expect(resolveColorValue(null, theme)).toBeUndefined()
  })

  it('executes transforms', () => {
    const darkened = executeTransform(darken('#808080', 0.5), theme)
    expect(darkened).toBeDefined()
    expect(darkened!.hsla.l).toBeLessThan(new Color(Color.fromHex('#808080').rgba).hsla.l)

    expect(executeTransform(lighten('#000000', 1), theme)?.toString()).toBe('#000000') // l=0 stays 0
    expect(executeTransform(transparent('#ffffff', 0.5), theme)?.rgba.a).toBeCloseTo(0.5, 3)

    const mixed = executeTransform(mix('#000000', '#ffffff', 0.5), theme)
    expect(mixed?.rgba.r).toBe(127)

    expect(executeTransform(oneOf('unknown.color', '#123456'), theme)?.toString()).toBe('#123456')

    const opaqueColor = executeTransform(opaque('#ffffff80', '#000000'), theme)
    expect(opaqueColor?.rgba.a).toBe(1)

    expect(
      executeTransform(ifDefinedThenElse('base.color', '#111111', '#222222'), theme)?.toString(),
    ).toBe('#111111')
    expect(
      executeTransform(ifDefinedThenElse('missing.color', '#111111', '#222222'), theme)?.toString(),
    ).toBe('#222222')

    const lp = executeTransform(lessProminent('#808080', '#000000', 0.5, 0.5), theme)
    expect(lp).toBeDefined()
    expect(lp!.rgba.a).toBeLessThan(1)
  })
})
