/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Adapted from Microsoft VSCode (src/vs/platform/contextkey/common/scanner.ts).
 *  Localized error messages and CharCode dependency simplified for a slimmer runtime.
 *--------------------------------------------------------------------------------------------*/

export const enum TokenType {
  LParen,
  RParen,
  Neg,
  Eq,
  NotEq,
  Lt,
  LtEq,
  Gt,
  GtEq,
  RegexOp,
  RegexStr,
  True,
  False,
  In,
  Not,
  And,
  Or,
  Str,
  QuotedStr,
  Error,
  EOF,
}

export type Token =
  | { type: TokenType.LParen; offset: number }
  | { type: TokenType.RParen; offset: number }
  | { type: TokenType.Neg; offset: number }
  | { type: TokenType.Eq; offset: number; isTripleEq: boolean }
  | { type: TokenType.NotEq; offset: number; isTripleEq: boolean }
  | { type: TokenType.Lt; offset: number }
  | { type: TokenType.LtEq; offset: number }
  | { type: TokenType.Gt; offset: number }
  | { type: TokenType.GtEq; offset: number }
  | { type: TokenType.RegexOp; offset: number }
  | { type: TokenType.RegexStr; offset: number; lexeme: string }
  | { type: TokenType.True; offset: number }
  | { type: TokenType.False; offset: number }
  | { type: TokenType.In; offset: number }
  | { type: TokenType.Not; offset: number }
  | { type: TokenType.And; offset: number }
  | { type: TokenType.Or; offset: number }
  | { type: TokenType.Str; offset: number; lexeme: string }
  | { type: TokenType.QuotedStr; offset: number; lexeme: string }
  | { type: TokenType.Error; offset: number; lexeme: string }
  | { type: TokenType.EOF; offset: number }

type KeywordTokenType = TokenType.Not | TokenType.In | TokenType.False | TokenType.True
type TokenTypeWithoutLexeme =
  | TokenType.LParen
  | TokenType.RParen
  | TokenType.Neg
  | TokenType.Lt
  | TokenType.LtEq
  | TokenType.Gt
  | TokenType.GtEq
  | TokenType.RegexOp
  | TokenType.True
  | TokenType.False
  | TokenType.In
  | TokenType.Not
  | TokenType.And
  | TokenType.Or
  | TokenType.EOF

export interface LexingError {
  offset: number
  lexeme: string
  additionalInfo?: string
}

// Character code constants (subset of base/common/charCode in VSCode).
const enum CC {
  Null = 0,
  Tab = 9,
  LineFeed = 10,
  CarriageReturn = 13,
  Space = 32,
  ExclamationMark = 33,
  SingleQuote = 39,
  OpenParen = 40,
  CloseParen = 41,
  Ampersand = 38,
  Slash = 47,
  LessThan = 60,
  Equals = 61,
  GreaterThan = 62,
  OpenSquareBracket = 91,
  Backslash = 92,
  CloseSquareBracket = 93,
  Pipe = 124,
  Tilde = 126,
  NoBreakSpace = 160,
}

function hintDidYouMean(...meant: string[]): string | undefined {
  switch (meant.length) {
    case 1:
      return `Did you mean ${meant[0]}?`
    case 2:
      return `Did you mean ${meant[0]} or ${meant[1]}?`
    case 3:
      return `Did you mean ${meant[0]}, ${meant[1]} or ${meant[2]}?`
    default:
      return undefined
  }
}

const hintDidYouForgetToOpenOrCloseQuote = 'Did you forget to open or close the quote?'
const hintDidYouForgetToEscapeSlash =
  "Did you forget to escape the '/' (slash) character? Put two backslashes before it to escape, e.g., '\\\\/'."

/**
 * A simple scanner for context keys.
 */
export class Scanner {
  static getLexeme(token: Token): string {
    switch (token.type) {
      case TokenType.LParen:
        return '('
      case TokenType.RParen:
        return ')'
      case TokenType.Neg:
        return '!'
      case TokenType.Eq:
        return token.isTripleEq ? '===' : '=='
      case TokenType.NotEq:
        return token.isTripleEq ? '!==' : '!='
      case TokenType.Lt:
        return '<'
      case TokenType.LtEq:
        return '<='
      case TokenType.Gt:
        return '>'
      case TokenType.GtEq:
        return '>='
      case TokenType.RegexOp:
        return '=~'
      case TokenType.RegexStr:
        return token.lexeme
      case TokenType.True:
        return 'true'
      case TokenType.False:
        return 'false'
      case TokenType.In:
        return 'in'
      case TokenType.Not:
        return 'not'
      case TokenType.And:
        return '&&'
      case TokenType.Or:
        return '||'
      case TokenType.Str:
      case TokenType.QuotedStr:
      case TokenType.Error:
        return token.lexeme
      case TokenType.EOF:
        return 'EOF'
    }
  }

  private static _regexFlags = new Set(['i', 'g', 's', 'm', 'y', 'u'].map((c) => c.charCodeAt(0)))

  private static _keywords = new Map<string, KeywordTokenType>([
    ['not', TokenType.Not],
    ['in', TokenType.In],
    ['false', TokenType.False],
    ['true', TokenType.True],
  ])

  private _input = ''
  private _start = 0
  private _current = 0
  private _tokens: Token[] = []
  private _errors: LexingError[] = []

  get errors(): Readonly<LexingError[]> {
    return this._errors
  }

  reset(value: string): this {
    this._input = value
    this._start = 0
    this._current = 0
    this._tokens = []
    this._errors = []
    return this
  }

  scan(): Token[] {
    while (!this._isAtEnd()) {
      this._start = this._current
      const ch = this._advance()
      switch (ch) {
        case CC.OpenParen:
          this._addToken(TokenType.LParen)
          break
        case CC.CloseParen:
          this._addToken(TokenType.RParen)
          break
        case CC.ExclamationMark:
          if (this._match(CC.Equals)) {
            const isTripleEq = this._match(CC.Equals)
            this._tokens.push({ type: TokenType.NotEq, offset: this._start, isTripleEq })
          } else {
            this._addToken(TokenType.Neg)
          }
          break
        case CC.SingleQuote:
          this._quotedString()
          break
        case CC.Slash:
          this._regex()
          break
        case CC.Equals:
          if (this._match(CC.Equals)) {
            const isTripleEq = this._match(CC.Equals)
            this._tokens.push({ type: TokenType.Eq, offset: this._start, isTripleEq })
          } else if (this._match(CC.Tilde)) {
            this._addToken(TokenType.RegexOp)
          } else {
            this._error(hintDidYouMean('==', '=~'))
          }
          break
        case CC.LessThan:
          this._addToken(this._match(CC.Equals) ? TokenType.LtEq : TokenType.Lt)
          break
        case CC.GreaterThan:
          this._addToken(this._match(CC.Equals) ? TokenType.GtEq : TokenType.Gt)
          break
        case CC.Ampersand:
          if (this._match(CC.Ampersand)) {
            this._addToken(TokenType.And)
          } else {
            this._error(hintDidYouMean('&&'))
          }
          break
        case CC.Pipe:
          if (this._match(CC.Pipe)) {
            this._addToken(TokenType.Or)
          } else {
            this._error(hintDidYouMean('||'))
          }
          break
        case CC.Space:
        case CC.CarriageReturn:
        case CC.Tab:
        case CC.LineFeed:
        case CC.NoBreakSpace:
          break
        default:
          this._string()
      }
    }

    this._start = this._current
    this._addToken(TokenType.EOF)
    return Array.from(this._tokens)
  }

  private _match(expected: number): boolean {
    if (this._isAtEnd()) {
      return false
    }
    if (this._input.charCodeAt(this._current) !== expected) {
      return false
    }
    this._current++
    return true
  }

  private _advance(): number {
    return this._input.charCodeAt(this._current++)
  }

  private _peek(): number {
    return this._isAtEnd() ? CC.Null : this._input.charCodeAt(this._current)
  }

  private _addToken(type: TokenTypeWithoutLexeme): void {
    this._tokens.push({ type, offset: this._start } as Token)
  }

  private _error(additional?: string): void {
    const offset = this._start
    const lexeme = this._input.substring(this._start, this._current)
    const errToken: Token = { type: TokenType.Error, offset: this._start, lexeme }
    this._errors.push(
      additional !== undefined
        ? { offset, lexeme, additionalInfo: additional }
        : { offset, lexeme },
    )
    this._tokens.push(errToken)
  }

  // Matches identifiers / unquoted values. Mirrors VSCode's regex.
  private _stringRe = /[a-zA-Z0-9_<>\-./\\:*?+[\]^,#@;"%$\p{L}-]+/uy

  private _string(): void {
    this._stringRe.lastIndex = this._start
    const match = this._stringRe.exec(this._input)
    if (match) {
      this._current = this._start + match[0].length
      const lexeme = this._input.substring(this._start, this._current)
      const keyword = Scanner._keywords.get(lexeme)
      if (keyword !== undefined) {
        this._addToken(keyword)
      } else {
        this._tokens.push({ type: TokenType.Str, lexeme, offset: this._start })
      }
    }
  }

  private _quotedString(): void {
    while (this._peek() !== CC.SingleQuote && !this._isAtEnd()) {
      this._advance()
    }

    if (this._isAtEnd()) {
      this._error(hintDidYouForgetToOpenOrCloseQuote)
      return
    }

    // consume the closing '
    this._advance()

    this._tokens.push({
      type: TokenType.QuotedStr,
      lexeme: this._input.substring(this._start + 1, this._current - 1),
      offset: this._start + 1,
    })
  }

  private _regex(): void {
    let p = this._current
    let inEscape = false
    let inCharacterClass = false
    while (true) {
      if (p >= this._input.length) {
        this._current = p
        this._error(hintDidYouForgetToEscapeSlash)
        return
      }

      const ch = this._input.charCodeAt(p)

      if (inEscape) {
        inEscape = false
      } else if (ch === CC.Slash && !inCharacterClass) {
        p++
        break
      } else if (ch === CC.OpenSquareBracket) {
        inCharacterClass = true
      } else if (ch === CC.Backslash) {
        inEscape = true
      } else if (ch === CC.CloseSquareBracket) {
        inCharacterClass = false
      }
      p++
    }

    while (p < this._input.length && Scanner._regexFlags.has(this._input.charCodeAt(p))) {
      p++
    }

    this._current = p
    const lexeme = this._input.substring(this._start, this._current)
    this._tokens.push({ type: TokenType.RegexStr, lexeme, offset: this._start })
  }

  private _isAtEnd(): boolean {
    return this._current >= this._input.length
  }
}
