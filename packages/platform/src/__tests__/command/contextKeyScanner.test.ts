/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/command/contextKeyScanner.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Scanner, TokenType } from '../../command/contextKeyScanner.js'

function tokenize(input: string) {
  return new Scanner().reset(input).scan()
}

describe('Scanner', () => {
  it('emits a single EOF token for empty input', () => {
    const tokens = tokenize('')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.type).toBe(TokenType.EOF)
  })

  it('tokenizes a bare identifier', () => {
    const tokens = tokenize('foo')
    expect(tokens.map((t) => t.type)).toEqual([TokenType.Str, TokenType.EOF])
    expect(tokens[0]).toMatchObject({ lexeme: 'foo' })
  })

  it('recognizes keywords true / false / not / in', () => {
    const tokens = tokenize('true false not in')
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.True,
      TokenType.False,
      TokenType.Not,
      TokenType.In,
      TokenType.EOF,
    ])
  })

  it('tokenizes comparison operators', () => {
    const tokens = tokenize('a == b != c < d <= e > f >= g =~ /x/')
    const types = tokens.map((t) => t.type)
    expect(types).toContain(TokenType.Eq)
    expect(types).toContain(TokenType.NotEq)
    expect(types).toContain(TokenType.Lt)
    expect(types).toContain(TokenType.LtEq)
    expect(types).toContain(TokenType.Gt)
    expect(types).toContain(TokenType.GtEq)
    expect(types).toContain(TokenType.RegexOp)
    expect(types).toContain(TokenType.RegexStr)
  })

  it('distinguishes == from === (isTripleEq flag)', () => {
    const tokens = tokenize('a == b')
    const eq = tokens.find((t) => t.type === TokenType.Eq)
    expect(eq).toMatchObject({ isTripleEq: false })

    const tokens3 = tokenize('a === b')
    const eq3 = tokens3.find((t) => t.type === TokenType.Eq)
    expect(eq3).toMatchObject({ isTripleEq: true })
  })

  it('parses single-quoted strings', () => {
    const tokens = tokenize("'hello world'")
    expect(tokens[0]).toMatchObject({ type: TokenType.QuotedStr, lexeme: 'hello world' })
  })

  it('errors on unclosed single-quoted string', () => {
    const scanner = new Scanner().reset("'unterminated")
    scanner.scan()
    expect(scanner.errors).toHaveLength(1)
  })

  it('parses regex literal with flags', () => {
    const tokens = tokenize('/abc/i')
    expect(tokens[0]).toMatchObject({ type: TokenType.RegexStr, lexeme: '/abc/i' })
  })

  it('parses regex literal containing character class', () => {
    const tokens = tokenize('/[a-z]+/')
    expect(tokens[0]).toMatchObject({ type: TokenType.RegexStr, lexeme: '/[a-z]+/' })
  })

  it('tokenizes && and ||', () => {
    const tokens = tokenize('a && b || c')
    const types = tokens.map((t) => t.type)
    expect(types).toContain(TokenType.And)
    expect(types).toContain(TokenType.Or)
  })

  it('errors on single & (suggests &&)', () => {
    const scanner = new Scanner().reset('a & b')
    scanner.scan()
    expect(scanner.errors.length).toBeGreaterThan(0)
    expect(scanner.errors[0]?.additionalInfo).toContain('&&')
  })

  it('errors on single | (suggests ||)', () => {
    const scanner = new Scanner().reset('a | b')
    scanner.scan()
    expect(scanner.errors.length).toBeGreaterThan(0)
    expect(scanner.errors[0]?.additionalInfo).toContain('||')
  })

  it('errors on lone = (suggests == or =~)', () => {
    const scanner = new Scanner().reset('a = b')
    scanner.scan()
    expect(scanner.errors.length).toBeGreaterThan(0)
    expect(scanner.errors[0]?.additionalInfo).toContain('==')
  })

  it('handles parentheses', () => {
    const tokens = tokenize('(a)')
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.LParen,
      TokenType.Str,
      TokenType.RParen,
      TokenType.EOF,
    ])
  })

  it('skips whitespace (space, tab, newline)', () => {
    const tokens = tokenize('  a\n\tb  ')
    expect(tokens.filter((t) => t.type === TokenType.Str)).toHaveLength(2)
  })

  it('Scanner.getLexeme returns canonical lexeme', () => {
    expect(Scanner.getLexeme({ type: TokenType.And, offset: 0 })).toBe('&&')
    expect(Scanner.getLexeme({ type: TokenType.Or, offset: 0 })).toBe('||')
    expect(Scanner.getLexeme({ type: TokenType.LParen, offset: 0 })).toBe('(')
    expect(Scanner.getLexeme({ type: TokenType.EOF, offset: 0 })).toBe('EOF')
  })
})
