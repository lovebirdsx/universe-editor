/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/command/contextKeyExpr.ts (AST + Parser).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ContextKeyAndExpr,
  ContextKeyExpr,
  ContextKeyExprType,
  ContextKeyFalseExpr,
  ContextKeyOrExpr,
  ContextKeyTrueExpr,
  IContext,
} from '../../command/contextKeyExpr.js'

function ctx(values: Record<string, unknown>): IContext {
  return {
    getValue: <T>(key: string): T | undefined => values[key] as T | undefined,
  }
}

describe('ContextKeyExpr — basic constructors', () => {
  it('true() / false() evaluate to their constants', () => {
    expect(ContextKeyExpr.true().evaluate(ctx({}))).toBe(true)
    expect(ContextKeyExpr.false().evaluate(ctx({}))).toBe(false)
  })

  it('has(key) is truthy check on context', () => {
    const e = ContextKeyExpr.has('a')
    expect(e.evaluate(ctx({ a: 1 }))).toBe(true)
    expect(e.evaluate(ctx({ a: 0 }))).toBe(false)
    expect(e.evaluate(ctx({}))).toBe(false)
  })

  it('not(key) returns the inverse', () => {
    const e = ContextKeyExpr.not('a')
    expect(e.evaluate(ctx({ a: 1 }))).toBe(false)
    expect(e.evaluate(ctx({ a: 0 }))).toBe(true)
    expect(e.evaluate(ctx({}))).toBe(true)
  })

  it('equals() with a boolean reduces to defined/not', () => {
    // VSCode quirk: equals(key, true) is treated as has(key)
    const e = ContextKeyExpr.equals('a', true)
    expect(e.type).toBe(ContextKeyExprType.Defined)
    const eFalse = ContextKeyExpr.equals('a', false)
    expect(eFalse.type).toBe(ContextKeyExprType.Not)
  })

  it('equals() with a string compares loosely', () => {
    const e = ContextKeyExpr.equals('lang', 'json')
    expect(e.evaluate(ctx({ lang: 'json' }))).toBe(true)
    expect(e.evaluate(ctx({ lang: 'lua' }))).toBe(false)
  })

  it('notEquals(key, string) is the inverse of equals', () => {
    const e = ContextKeyExpr.notEquals('lang', 'json')
    expect(e.evaluate(ctx({ lang: 'lua' }))).toBe(true)
    expect(e.evaluate(ctx({ lang: 'json' }))).toBe(false)
  })

  it('regex() matches against context value', () => {
    const e = ContextKeyExpr.regex('file', /\.ts$/)
    expect(e.evaluate(ctx({ file: 'a.ts' }))).toBe(true)
    expect(e.evaluate(ctx({ file: 'a.js' }))).toBe(false)
  })

  it('greater / greaterEquals / smaller / smallerEquals do numeric compare', () => {
    expect(ContextKeyExpr.greater('n', 5).evaluate(ctx({ n: 10 }))).toBe(true)
    expect(ContextKeyExpr.greater('n', 5).evaluate(ctx({ n: 5 }))).toBe(false)
    expect(ContextKeyExpr.greaterEquals('n', 5).evaluate(ctx({ n: 5 }))).toBe(true)
    expect(ContextKeyExpr.smaller('n', 5).evaluate(ctx({ n: 4 }))).toBe(true)
    expect(ContextKeyExpr.smallerEquals('n', 5).evaluate(ctx({ n: 5 }))).toBe(true)
  })

  it('in() / notIn() check membership against arrays', () => {
    const e = ContextKeyExpr.in('item', 'list')
    expect(e.evaluate(ctx({ item: 'a', list: ['a', 'b'] }))).toBe(true)
    expect(e.evaluate(ctx({ item: 'c', list: ['a', 'b'] }))).toBe(false)

    const ne = ContextKeyExpr.notIn('item', 'list')
    expect(ne.evaluate(ctx({ item: 'a', list: ['a', 'b'] }))).toBe(false)
    expect(ne.evaluate(ctx({ item: 'c', list: ['a', 'b'] }))).toBe(true)
  })

  it('in() also checks object hasOwn when value is string', () => {
    const e = ContextKeyExpr.in('key', 'obj')
    expect(e.evaluate(ctx({ key: 'foo', obj: { foo: 1 } }))).toBe(true)
    expect(e.evaluate(ctx({ key: 'bar', obj: { foo: 1 } }))).toBe(false)
  })
})

describe('ContextKeyExpr — and / or normalization', () => {
  it('and([true, x, true]) reduces to x', () => {
    const x = ContextKeyExpr.has('x')
    const result = ContextKeyExpr.and(ContextKeyExpr.true(), x, ContextKeyExpr.true())
    expect(result).toBeDefined()
    expect(result!.equals(x)).toBe(true)
  })

  it('and([x, false]) reduces to false', () => {
    const result = ContextKeyExpr.and(ContextKeyExpr.has('x'), ContextKeyExpr.false())
    expect(result).toBe(ContextKeyFalseExpr.INSTANCE)
  })

  it('or([false, x]) reduces to x', () => {
    const x = ContextKeyExpr.has('x')
    const result = ContextKeyExpr.or(ContextKeyExpr.false(), x)
    expect(result!.equals(x)).toBe(true)
  })

  it('or([x, true]) reduces to true', () => {
    const result = ContextKeyExpr.or(ContextKeyExpr.has('x'), ContextKeyExpr.true())
    expect(result).toBe(ContextKeyTrueExpr.INSTANCE)
  })

  it('and(undefined values) returns undefined', () => {
    expect(ContextKeyExpr.and(undefined, undefined)).toBeUndefined()
  })

  it('and flattens nested ands', () => {
    const inner = ContextKeyExpr.and(ContextKeyExpr.has('a'), ContextKeyExpr.has('b'))
    const outer = ContextKeyExpr.and(inner, ContextKeyExpr.has('c'))
    expect(outer?.type).toBe(ContextKeyExprType.And)
    expect((outer as ContextKeyAndExpr).expr).toHaveLength(3)
  })

  it('or flattens nested ors', () => {
    const inner = ContextKeyExpr.or(ContextKeyExpr.has('a'), ContextKeyExpr.has('b'))
    const outer = ContextKeyExpr.or(inner, ContextKeyExpr.has('c'))
    expect(outer?.type).toBe(ContextKeyExprType.Or)
    expect((outer as ContextKeyOrExpr).expr).toHaveLength(3)
  })

  it('and removes duplicates', () => {
    const result = ContextKeyExpr.and(ContextKeyExpr.has('a'), ContextKeyExpr.has('a'))
    expect(result?.type).toBe(ContextKeyExprType.Defined)
  })

  it('and([x, !x]) detects contradiction and returns false', () => {
    const result = ContextKeyExpr.and(ContextKeyExpr.has('x'), ContextKeyExpr.not('x'))
    expect(result).toBe(ContextKeyFalseExpr.INSTANCE)
  })

  it('or([x, !x]) detects tautology and returns true', () => {
    const result = ContextKeyExpr.or(ContextKeyExpr.has('x'), ContextKeyExpr.not('x'))
    expect(result).toBe(ContextKeyTrueExpr.INSTANCE)
  })

  it('and evaluates short-circuit', () => {
    const e = ContextKeyExpr.and(ContextKeyExpr.has('a'), ContextKeyExpr.has('b'))!
    expect(e.evaluate(ctx({ a: 1, b: 1 }))).toBe(true)
    expect(e.evaluate(ctx({ a: 1, b: 0 }))).toBe(false)
    expect(e.evaluate(ctx({ a: 0, b: 1 }))).toBe(false)
  })

  it('or evaluates short-circuit', () => {
    const e = ContextKeyExpr.or(ContextKeyExpr.has('a'), ContextKeyExpr.has('b'))!
    expect(e.evaluate(ctx({ a: 0, b: 0 }))).toBe(false)
    expect(e.evaluate(ctx({ a: 1, b: 0 }))).toBe(true)
    expect(e.evaluate(ctx({ a: 0, b: 1 }))).toBe(true)
  })
})

describe('ContextKeyExpr — keys() / negate() / serialize()', () => {
  it('keys() returns referenced context keys', () => {
    const e = ContextKeyExpr.and(
      ContextKeyExpr.has('a'),
      ContextKeyExpr.equals('b', 'x'),
      ContextKeyExpr.not('c'),
    )!
    expect(Array.from(new Set(e.keys())).sort()).toEqual(['a', 'b', 'c'])
  })

  it('keys() of regex / equals returns the key', () => {
    expect(ContextKeyExpr.regex('f', /x/).keys()).toEqual(['f'])
    expect(ContextKeyExpr.equals('lang', 'json').keys()).toEqual(['lang'])
  })

  it('double-negate equals the original (by equals())', () => {
    const e = ContextKeyExpr.equals('lang', 'json')
    expect(e.negate().negate().equals(e)).toBe(true)
  })

  it('negate() of greater is smallerEquals', () => {
    const e = ContextKeyExpr.greater('n', 5)
    const n = e.negate()
    expect(n.type).toBe(ContextKeyExprType.SmallerEquals)
  })

  it('serialize() round-trips through deserialize()', () => {
    const e = ContextKeyExpr.and(
      ContextKeyExpr.has('a'),
      ContextKeyExpr.equals('lang', 'json'),
      ContextKeyExpr.not('c'),
    )!
    const round = ContextKeyExpr.deserialize(e.serialize())
    expect(round?.equals(e)).toBe(true)
  })
})

describe('ContextKeyExpr.deserialize — parser integration', () => {
  it('returns undefined for empty string', () => {
    expect(ContextKeyExpr.deserialize('')).toBeUndefined()
  })

  it('returns undefined for null / undefined', () => {
    expect(ContextKeyExpr.deserialize(undefined)).toBeUndefined()
    expect(ContextKeyExpr.deserialize(null)).toBeUndefined()
  })

  it('parses bare key into Defined', () => {
    const e = ContextKeyExpr.deserialize('myKey')!
    expect(e.type).toBe(ContextKeyExprType.Defined)
    expect(e.evaluate(ctx({ myKey: 1 }))).toBe(true)
  })

  it('parses !key into Not', () => {
    const e = ContextKeyExpr.deserialize('!myKey')!
    expect(e.type).toBe(ContextKeyExprType.Not)
    expect(e.evaluate(ctx({}))).toBe(true)
  })

  it("parses a == 'b' into Equals", () => {
    const e = ContextKeyExpr.deserialize("lang == 'json'")!
    expect(e.type).toBe(ContextKeyExprType.Equals)
    expect(e.evaluate(ctx({ lang: 'json' }))).toBe(true)
  })

  it('parses a == true into Defined (VSCode quirk)', () => {
    const e = ContextKeyExpr.deserialize('a == true')!
    expect(e.type).toBe(ContextKeyExprType.Defined)
  })

  it('parses a == false into Not (VSCode quirk)', () => {
    const e = ContextKeyExpr.deserialize('a == false')!
    expect(e.type).toBe(ContextKeyExprType.Not)
  })

  it('parses a && b || c with correct precedence', () => {
    // (a && b) || c
    const e = ContextKeyExpr.deserialize('a && b || c')!
    expect(e.evaluate(ctx({ a: 1, b: 1 }))).toBe(true)
    expect(e.evaluate(ctx({ c: 1 }))).toBe(true)
    expect(e.evaluate(ctx({ a: 1 }))).toBe(false)
  })

  it('parses parenthesized expression', () => {
    const e = ContextKeyExpr.deserialize('a && (b || c)')!
    expect(e.evaluate(ctx({ a: 1, b: 1 }))).toBe(true)
    expect(e.evaluate(ctx({ a: 1, c: 1 }))).toBe(true)
    expect(e.evaluate(ctx({ a: 1 }))).toBe(false)
    expect(e.evaluate(ctx({ b: 1 }))).toBe(false)
  })

  it('parses numeric comparison', () => {
    const e = ContextKeyExpr.deserialize('n >= 5')!
    expect(e.type).toBe(ContextKeyExprType.GreaterEquals)
    expect(e.evaluate(ctx({ n: 10 }))).toBe(true)
    expect(e.evaluate(ctx({ n: 4 }))).toBe(false)
  })

  it('parses regex via =~', () => {
    const e = ContextKeyExpr.deserialize('file =~ /\\.ts$/')!
    expect(e.type).toBe(ContextKeyExprType.Regex)
    expect(e.evaluate(ctx({ file: 'a.ts' }))).toBe(true)
  })

  it('parses in / not in', () => {
    const ein = ContextKeyExpr.deserialize('x in list')!
    expect(ein.type).toBe(ContextKeyExprType.In)
    const enot = ContextKeyExpr.deserialize('x not in list')!
    expect(enot.type).toBe(ContextKeyExprType.NotIn)
  })

  it('returns undefined for malformed expressions', () => {
    expect(ContextKeyExpr.deserialize('a &&')).toBeUndefined()
    expect(ContextKeyExpr.deserialize('(a')).toBeUndefined()
  })

  it('parses negated parenthesized: !(a && b)', () => {
    const e = ContextKeyExpr.deserialize('!(a && b)')!
    expect(e.evaluate(ctx({ a: 1, b: 1 }))).toBe(false)
    expect(e.evaluate(ctx({ a: 1 }))).toBe(true)
  })

  it('treats foo == bare-value as a string compare', () => {
    const e = ContextKeyExpr.deserialize('lang == json')!
    expect(e.type).toBe(ContextKeyExprType.Equals)
    expect(e.evaluate(ctx({ lang: 'json' }))).toBe(true)
  })
})
