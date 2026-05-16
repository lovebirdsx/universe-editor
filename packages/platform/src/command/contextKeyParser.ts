/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Adapted from Microsoft VSCode (src/vs/platform/contextkey/common/contextkey.ts Parser class).
 *  - Removed `regexParsingWithErrorRecovery` flag (we always run with strict regex parsing).
 *  - Removed localize() bindings.
 *--------------------------------------------------------------------------------------------*/

import {
  ContextKeyExpr,
  ContextKeyExpression,
  ContextKeyFalseExpr,
  ContextKeyGreaterEqualsExpr,
  ContextKeyGreaterExpr,
  ContextKeyRegexExpr,
  ContextKeySmallerEqualsExpr,
  ContextKeySmallerExpr,
  ContextKeyTrueExpr,
} from './contextKeyExpr.js'
import { LexingError, Scanner, Token, TokenType } from './contextKeyScanner.js'

const errorEmptyString = 'Empty context key expression'
const hintEmptyString =
  "Did you forget to write an expression? You can also put 'false' or 'true' to always evaluate to false or true, respectively."
const errorNoInAfterNot = "'in' after 'not'."
const errorClosingParenthesis = "closing parenthesis ')'"
const errorUnexpectedToken = 'Unexpected token'
const hintUnexpectedToken = 'Did you forget to put && or || before the token?'
const errorUnexpectedEOF = 'Unexpected end of expression'
const hintUnexpectedEOF = 'Did you forget to put a context key?'

export interface ParsingError {
  message: string
  offset: number
  lexeme: string
  additionalInfo?: string
}

const EOF_TOKEN: Token = { type: TokenType.EOF, offset: 0 }

export class Parser {
  private static _parseError = new Error()

  private readonly _scanner = new Scanner()

  private _tokens: Token[] = []
  private _current = 0
  private _parsingErrors: ParsingError[] = []

  get lexingErrors(): Readonly<LexingError[]> {
    return this._scanner.errors
  }

  get parsingErrors(): Readonly<ParsingError[]> {
    return this._parsingErrors
  }

  parse(input: string): ContextKeyExpression | undefined {
    if (input === '') {
      this._parsingErrors.push({
        message: errorEmptyString,
        offset: 0,
        lexeme: '',
        additionalInfo: hintEmptyString,
      })
      return undefined
    }

    this._tokens = this._scanner.reset(input).scan()
    this._current = 0
    this._parsingErrors = []

    try {
      const expr = this._expr()
      if (!this._isAtEnd()) {
        const peek = this._peek()
        const additionalInfo = peek.type === TokenType.Str ? hintUnexpectedToken : undefined
        this._parsingErrors.push(
          additionalInfo !== undefined
            ? {
                message: errorUnexpectedToken,
                offset: peek.offset,
                lexeme: Scanner.getLexeme(peek),
                additionalInfo,
              }
            : {
                message: errorUnexpectedToken,
                offset: peek.offset,
                lexeme: Scanner.getLexeme(peek),
              },
        )
        throw Parser._parseError
      }
      return expr
    } catch (e) {
      if (e !== Parser._parseError) throw e
      return undefined
    }
  }

  private _expr(): ContextKeyExpression | undefined {
    return this._or()
  }

  private _or(): ContextKeyExpression | undefined {
    const expr: Array<ContextKeyExpression | undefined> = [this._and()]
    while (this._matchOne(TokenType.Or)) {
      expr.push(this._and())
    }
    return expr.length === 1 ? expr[0] : ContextKeyExpr.or(...expr)
  }

  private _and(): ContextKeyExpression | undefined {
    const expr: Array<ContextKeyExpression | undefined> = [this._term()]
    while (this._matchOne(TokenType.And)) {
      expr.push(this._term())
    }
    return expr.length === 1 ? expr[0] : ContextKeyExpr.and(...expr)
  }

  private _term(): ContextKeyExpression | undefined {
    if (this._matchOne(TokenType.Neg)) {
      const peek = this._peek()
      switch (peek.type) {
        case TokenType.True:
          this._advance()
          return ContextKeyFalseExpr.INSTANCE
        case TokenType.False:
          this._advance()
          return ContextKeyTrueExpr.INSTANCE
        case TokenType.LParen: {
          this._advance()
          const expr = this._expr()
          this._consume(TokenType.RParen, errorClosingParenthesis)
          return expr?.negate()
        }
        case TokenType.Str:
          this._advance()
          return ContextKeyExpr.not(peek.lexeme)
        default:
          throw this._errExpectedButGot(`KEY | true | false | '(' expression ')'`, peek)
      }
    }
    return this._primary()
  }

  private _primary(): ContextKeyExpression | undefined {
    const peek = this._peek()
    switch (peek.type) {
      case TokenType.True:
        this._advance()
        return ContextKeyExpr.true()

      case TokenType.False:
        this._advance()
        return ContextKeyExpr.false()

      case TokenType.LParen: {
        this._advance()
        const expr = this._expr()
        this._consume(TokenType.RParen, errorClosingParenthesis)
        return expr
      }

      case TokenType.Str: {
        const key = peek.lexeme
        this._advance()

        if (this._matchOne(TokenType.RegexOp)) {
          const expr = this._peek()
          this._advance()
          if (expr.type !== TokenType.RegexStr) {
            // Allow QuotedStr regex literal as VSCode does for backward compatibility.
            if (expr.type === TokenType.QuotedStr) {
              const serialized = expr.lexeme
              let regex: RegExp | null = null
              if (serialized.trim().length > 0) {
                const start = serialized.indexOf('/')
                const end = serialized.lastIndexOf('/')
                if (start !== end && start >= 0) {
                  const value = serialized.slice(start + 1, end)
                  const flag = serialized[end + 1] === 'i' ? 'i' : ''
                  try {
                    regex = new RegExp(value, flag)
                  } catch {
                    throw this._errExpectedButGot('REGEX', expr)
                  }
                }
              }
              if (regex === null) throw this._errExpectedButGot('REGEX', expr)
              return ContextKeyRegexExpr.create(key, regex)
            }
            throw this._errExpectedButGot('REGEX', expr)
          }

          const regexLexeme = expr.lexeme
          const closingSlashIndex = regexLexeme.lastIndexOf('/')
          const flags =
            closingSlashIndex === regexLexeme.length - 1
              ? undefined
              : this._removeFlagsGY(regexLexeme.substring(closingSlashIndex + 1))
          try {
            const regexp =
              flags !== undefined
                ? new RegExp(regexLexeme.substring(1, closingSlashIndex), flags)
                : new RegExp(regexLexeme.substring(1, closingSlashIndex))
            return ContextKeyRegexExpr.create(key, regexp)
          } catch {
            throw this._errExpectedButGot('REGEX', expr)
          }
        }

        // 'not' 'in' value
        if (this._matchOne(TokenType.Not)) {
          this._consume(TokenType.In, errorNoInAfterNot)
          const right = this._value()
          return ContextKeyExpr.notIn(key, right)
        }

        const maybeOp = this._peek().type
        switch (maybeOp) {
          case TokenType.Eq: {
            this._advance()
            const right = this._value()
            if (this._previous()?.type === TokenType.QuotedStr) {
              return ContextKeyExpr.equals(key, right)
            }
            switch (right) {
              case 'true':
                return ContextKeyExpr.has(key)
              case 'false':
                return ContextKeyExpr.not(key)
              default:
                return ContextKeyExpr.equals(key, right)
            }
          }
          case TokenType.NotEq: {
            this._advance()
            const right = this._value()
            if (this._previous()?.type === TokenType.QuotedStr) {
              return ContextKeyExpr.notEquals(key, right)
            }
            switch (right) {
              case 'true':
                return ContextKeyExpr.not(key)
              case 'false':
                return ContextKeyExpr.has(key)
              default:
                return ContextKeyExpr.notEquals(key, right)
            }
          }
          case TokenType.Lt:
            this._advance()
            return ContextKeySmallerExpr.create(key, this._value())
          case TokenType.LtEq:
            this._advance()
            return ContextKeySmallerEqualsExpr.create(key, this._value())
          case TokenType.Gt:
            this._advance()
            return ContextKeyGreaterExpr.create(key, this._value())
          case TokenType.GtEq:
            this._advance()
            return ContextKeyGreaterEqualsExpr.create(key, this._value())
          case TokenType.In:
            this._advance()
            return ContextKeyExpr.in(key, this._value())
          default:
            return ContextKeyExpr.has(key)
        }
      }

      case TokenType.EOF:
        this._parsingErrors.push({
          message: errorUnexpectedEOF,
          offset: peek.offset,
          lexeme: '',
          additionalInfo: hintUnexpectedEOF,
        })
        throw Parser._parseError

      default:
        throw this._errExpectedButGot(
          `true | false | KEY | KEY '=~' REGEX | KEY ('==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not' 'in') value`,
          this._peek(),
        )
    }
  }

  private _value(): string {
    const token = this._peek()
    switch (token.type) {
      case TokenType.Str:
      case TokenType.QuotedStr:
        this._advance()
        return token.lexeme
      case TokenType.True:
        this._advance()
        return 'true'
      case TokenType.False:
        this._advance()
        return 'false'
      case TokenType.In:
        this._advance()
        return 'in'
      default:
        // allow empty value ("foo == ")
        return ''
    }
  }

  private _flagsGYRe = /g|y/g
  private _removeFlagsGY(flags: string): string {
    return flags.replaceAll(this._flagsGYRe, '')
  }

  private _previous(): Token | undefined {
    return this._tokens[this._current - 1]
  }

  private _matchOne(type: TokenType): boolean {
    if (this._check(type)) {
      this._advance()
      return true
    }
    return false
  }

  private _advance(): Token {
    if (!this._isAtEnd()) this._current++
    return this._previous() ?? EOF_TOKEN
  }

  private _consume(type: TokenType, message: string): Token {
    if (this._check(type)) return this._advance()
    throw this._errExpectedButGot(message, this._peek())
  }

  private _errExpectedButGot(expected: string, got: Token, additionalInfo?: string): Error {
    const message = `Expected: ${expected}\nReceived: '${Scanner.getLexeme(got)}'.`
    this._parsingErrors.push(
      additionalInfo !== undefined
        ? { message, offset: got.offset, lexeme: Scanner.getLexeme(got), additionalInfo }
        : { message, offset: got.offset, lexeme: Scanner.getLexeme(got) },
    )
    return Parser._parseError
  }

  private _check(type: TokenType): boolean {
    return this._peek().type === type
  }

  private _peek(): Token {
    return this._tokens[this._current] ?? EOF_TOKEN
  }

  private _isAtEnd(): boolean {
    return this._peek().type === TokenType.EOF
  }
}
