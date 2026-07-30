/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { ITokenColorRule } from '../colorThemeData.js'
import {
  parseClassifierString,
  parseSemanticTokenStyle,
  parseTokenSelector,
  resolveScopeToStyle,
  SEMANTIC_TOKEN_DEFAULT_RULES,
} from '../semanticSelector.js'

describe('parseClassifierString', () => {
  it('splits type, modifiers and language by scanning from the end', () => {
    expect(parseClassifierString('variable')).toEqual({
      type: 'variable',
      modifiers: [],
      language: undefined,
    })
    expect(parseClassifierString('variable.readonly')).toEqual({
      type: 'variable',
      modifiers: ['readonly'],
      language: undefined,
    })
    expect(parseClassifierString('variable.declaration.readonly:typescript')).toEqual({
      type: 'variable',
      modifiers: ['readonly', 'declaration'],
      language: 'typescript',
    })
    expect(parseClassifierString('*:typescript')).toEqual({
      type: '*',
      modifiers: [],
      language: 'typescript',
    })
  })

  it('applies the default language when the classifier has no language suffix', () => {
    expect(parseClassifierString('variable.readonly', 'typescript').language).toBe('typescript')
    expect(parseClassifierString('variable.readonly:javascript', 'typescript').language).toBe(
      'javascript',
    )
  })
})

describe('parseTokenSelector scoring', () => {
  it('exact type match scores 100, language match adds 10', () => {
    const selector = parseTokenSelector('variable')
    expect(selector.match('variable', [], 'typescript')).toBe(100)
    const langSelector = parseTokenSelector('variable:typescript')
    expect(langSelector.match('variable', [], 'typescript')).toBe(110)
    expect(langSelector.match('variable', [], 'javascript')).toBe(-1)
  })

  it('each selector modifier must be present; each adds 100', () => {
    const selector = parseTokenSelector('variable.readonly')
    expect(selector.match('variable', ['readonly'], 'ts')).toBe(200)
    // token with extra modifiers still matches (subset semantics)
    expect(selector.match('variable', ['declaration', 'readonly'], 'ts')).toBe(200)
    expect(selector.match('variable', [], 'ts')).toBe(-1)
    expect(selector.match('variable', ['declaration'], 'ts')).toBe(-1)
  })

  it('supertype hierarchy: member token matches method selector one level up', () => {
    const selector = parseTokenSelector('method')
    expect(selector.match('member', [], 'ts')).toBe(99)
    expect(selector.match('method', [], 'ts')).toBe(100)
    expect(selector.match('function', [], 'ts')).toBe(-1)
  })

  it('wildcard matches any type at score 0, modifiers still add 100 each', () => {
    const selector = parseTokenSelector('*.readonly')
    expect(selector.match('variable', ['readonly'], 'ts')).toBe(100)
    expect(selector.match('class', ['readonly'], 'ts')).toBe(100)
    expect(selector.match('class', [], 'ts')).toBe(-1)
  })

  it('specificity ordering: type+modifier beats type, language beats plain', () => {
    const plain = parseTokenSelector('variable')
    const withModifier = parseTokenSelector('variable.readonly')
    const withLanguage = parseTokenSelector('variable:typescript')
    const full = parseTokenSelector('variable.readonly:typescript')
    const modifiers = ['readonly']
    expect(withModifier.match('variable', modifiers, 'typescript')).toBeGreaterThan(
      plain.match('variable', modifiers, 'typescript'),
    )
    expect(withLanguage.match('variable', modifiers, 'typescript')).toBeGreaterThan(
      plain.match('variable', modifiers, 'typescript'),
    )
    expect(full.match('variable', modifiers, 'typescript')).toBeGreaterThan(
      withModifier.match('variable', modifiers, 'typescript'),
    )
    expect(full.match('variable', modifiers, 'typescript')).toBeGreaterThan(
      withLanguage.match('variable', modifiers, 'typescript'),
    )
  })

  it('invalid selector never matches', () => {
    expect(parseTokenSelector('.readonly').match('variable', ['readonly'], 'ts')).toBe(-1)
  })
})

describe('parseSemanticTokenStyle', () => {
  it('fontStyle parses the four flags and overrides explicit booleans', () => {
    expect(parseSemanticTokenStyle({ fontStyle: 'bold italic' })).toEqual({
      foreground: undefined,
      bold: true,
      italic: true,
      underline: false,
      strikethrough: false,
    })
    // fontStyle present (even empty) resets all explicit booleans
    expect(parseSemanticTokenStyle({ fontStyle: '', bold: true })).toEqual({
      foreground: undefined,
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
    })
  })

  it('explicit booleans apply when fontStyle is absent', () => {
    expect(parseSemanticTokenStyle({ bold: true, underline: false })).toEqual({
      foreground: undefined,
      bold: true,
      italic: undefined,
      underline: false,
      strikethrough: undefined,
    })
  })

  it('normalizes foreground to uppercase hex', () => {
    expect(parseSemanticTokenStyle({ foreground: '#4ec9b0' }).foreground).toBe('#4EC9B0')
    expect(parseSemanticTokenStyle({ foreground: 'not-a-color' }).foreground).toBeUndefined()
  })
})

describe('resolveScopeToStyle', () => {
  const themeRules: ITokenColorRule[] = [
    { scope: 'variable.other', settings: { foreground: '#111111' } },
    { scope: 'variable.other.constant', settings: { foreground: '#222222', fontStyle: 'bold' } },
  ]

  it('prefix-matches scope segments and prefers the deepest rule per property', () => {
    const style = resolveScopeToStyle(['variable.other.constant'], themeRules, [])
    expect(style?.foreground).toBe('#222222')
    expect(style?.bold).toBe(true)
  })

  it('falls back to a shallower rule when the deep one lacks the property', () => {
    const rules: ITokenColorRule[] = [
      { scope: 'support.type', settings: { fontStyle: 'italic' } },
      { scope: 'support', settings: { foreground: '#333333' } },
    ]
    const style = resolveScopeToStyle(['support.type'], rules, [])
    expect(style?.italic).toBe(true)
    expect(style?.foreground).toBe('#333333')
  })

  it('tries probes in order and returns the first that resolves anything', () => {
    const style = resolveScopeToStyle(['no.such.scope', 'variable.other.constant'], themeRules, [])
    expect(style?.foreground).toBe('#222222')
  })

  it('custom rules override theme rules at equal score', () => {
    const custom: ITokenColorRule[] = [
      { scope: 'variable.other.constant', settings: { foreground: '#444444' } },
    ]
    const style = resolveScopeToStyle(['variable.other.constant'], themeRules, custom)
    expect(style?.foreground).toBe('#444444')
  })

  it('returns undefined when nothing matches', () => {
    expect(resolveScopeToStyle(['entity.name.type'], themeRules, [])).toBeUndefined()
  })
})

describe('SEMANTIC_TOKEN_DEFAULT_RULES', () => {
  it('covers the VSCode built-in selectors', () => {
    const ids = SEMANTIC_TOKEN_DEFAULT_RULES.map((r) => r.selector.id)
    expect(ids).toContain('variable.readonly')
    expect(ids).toContain('property.readonly')
    expect(ids).toContain('type.defaultLibrary')
    expect(ids).toContain('variable.defaultLibrary.readonly')
    expect(ids).toContain('member.defaultLibrary')
    expect(SEMANTIC_TOKEN_DEFAULT_RULES).toHaveLength(11)
  })

  it('selectors only match tokens carrying every declared modifier', () => {
    const readonlyVar = SEMANTIC_TOKEN_DEFAULT_RULES.find(
      (r) => r.selector.id === 'variable.readonly',
    )!
    expect(readonlyVar.selector.match('variable', ['readonly'], 'ts')).toBeGreaterThanOrEqual(0)
    expect(readonlyVar.selector.match('variable', [], 'ts')).toBe(-1)
  })
})
