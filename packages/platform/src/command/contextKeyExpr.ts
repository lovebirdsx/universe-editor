/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Adapted from Microsoft VSCode (src/vs/platform/contextkey/common/contextkey.ts).
 *
 *  Trimmed for the universe-editor runtime:
 *  - Removed substituteConstants / CONSTANT_VALUES (no compile-time constant table).
 *  - Removed IContextKeyExprMapper and map() — used by VSCode's extension host serialization.
 *  - Localized error messages reduced to plain English.
 *  Behaviour, normalization rules and serialize() output preserved.
 *--------------------------------------------------------------------------------------------*/

import { Parser } from './contextKeyParser.js'

export const enum ContextKeyExprType {
  False = 0,
  True = 1,
  Defined = 2,
  Not = 3,
  Equals = 4,
  NotEquals = 5,
  And = 6,
  Regex = 7,
  NotRegex = 8,
  Or = 9,
  In = 10,
  NotIn = 11,
  Greater = 12,
  GreaterEquals = 13,
  Smaller = 14,
  SmallerEquals = 15,
}

export type ContextKeyValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | Array<null | undefined | boolean | number | string>
  | Record<string, null | undefined | boolean | number | string>

export interface IContext {
  getValue<T extends ContextKeyValue = ContextKeyValue>(key: string): T | undefined
}

export interface IContextKeyExpression {
  readonly type: ContextKeyExprType
  cmp(other: ContextKeyExpression): number
  equals(other: ContextKeyExpression): boolean
  evaluate(context: IContext): boolean
  serialize(): string
  keys(): string[]
  negate(): ContextKeyExpression
}

export type ContextKeyExpression =
  | ContextKeyFalseExpr
  | ContextKeyTrueExpr
  | ContextKeyDefinedExpr
  | ContextKeyNotExpr
  | ContextKeyEqualsExpr
  | ContextKeyNotEqualsExpr
  | ContextKeyRegexExpr
  | ContextKeyNotRegexExpr
  | ContextKeyAndExpr
  | ContextKeyOrExpr
  | ContextKeyInExpr
  | ContextKeyNotInExpr
  | ContextKeyGreaterExpr
  | ContextKeyGreaterEqualsExpr
  | ContextKeySmallerExpr
  | ContextKeySmallerEqualsExpr

function cmp(a: ContextKeyExpression, b: ContextKeyExpression): number {
  return a.cmp(b)
}

function cmp1(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function cmp2(k1: string, v1: unknown, k2: string, v2: unknown): number {
  if (k1 < k2) return -1
  if (k1 > k2) return 1
  if ((v1 as never) < (v2 as never)) return -1
  if ((v1 as never) > (v2 as never)) return 1
  return 0
}

export class ContextKeyFalseExpr implements IContextKeyExpression {
  static INSTANCE = new ContextKeyFalseExpr()
  readonly type = ContextKeyExprType.False
  protected constructor() {}
  cmp(other: ContextKeyExpression): number {
    return this.type - other.type
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type
  }
  evaluate(_context: IContext): boolean {
    return false
  }
  serialize(): string {
    return 'false'
  }
  keys(): string[] {
    return []
  }
  negate(): ContextKeyExpression {
    return ContextKeyTrueExpr.INSTANCE
  }
}

export class ContextKeyTrueExpr implements IContextKeyExpression {
  static INSTANCE = new ContextKeyTrueExpr()
  readonly type = ContextKeyExprType.True
  protected constructor() {}
  cmp(other: ContextKeyExpression): number {
    return this.type - other.type
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type
  }
  evaluate(_context: IContext): boolean {
    return true
  }
  serialize(): string {
    return 'true'
  }
  keys(): string[] {
    return []
  }
  negate(): ContextKeyExpression {
    return ContextKeyFalseExpr.INSTANCE
  }
}

export class ContextKeyDefinedExpr implements IContextKeyExpression {
  static create(key: string, negated: ContextKeyExpression | null = null): ContextKeyExpression {
    return new ContextKeyDefinedExpr(key, negated)
  }
  readonly type = ContextKeyExprType.Defined
  protected constructor(
    readonly key: string,
    private negated: ContextKeyExpression | null,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return cmp1(this.key, other.key)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this.key === other.key
  }
  evaluate(context: IContext): boolean {
    return !!context.getValue(this.key)
  }
  serialize(): string {
    return this.key
  }
  keys(): string[] {
    return [this.key]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeyNotExpr.create(this.key, this)
    }
    return this.negated
  }
}

export class ContextKeyEqualsExpr implements IContextKeyExpression {
  static create(
    key: string,
    value: unknown,
    negated: ContextKeyExpression | null = null,
  ): ContextKeyExpression {
    if (typeof value === 'boolean') {
      return value
        ? ContextKeyDefinedExpr.create(key, negated)
        : ContextKeyNotExpr.create(key, negated)
    }
    return new ContextKeyEqualsExpr(key, value, negated)
  }
  readonly type = ContextKeyExprType.Equals
  private constructor(
    readonly key: string,
    readonly value: unknown,
    private negated: ContextKeyExpression | null,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return cmp2(this.key, this.value, other.key, other.value)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this.key === other.key && this.value === other.value
  }
  evaluate(context: IContext): boolean {
    // Intentional == (loose) to mirror VSCode behavior.

    return context.getValue(this.key) == this.value
  }
  serialize(): string {
    return `${this.key} == '${String(this.value)}'`
  }
  keys(): string[] {
    return [this.key]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeyNotEqualsExpr.create(this.key, this.value, this)
    }
    return this.negated
  }
}

export class ContextKeyNotEqualsExpr implements IContextKeyExpression {
  static create(
    key: string,
    value: unknown,
    negated: ContextKeyExpression | null = null,
  ): ContextKeyExpression {
    if (typeof value === 'boolean') {
      return value
        ? ContextKeyNotExpr.create(key, negated)
        : ContextKeyDefinedExpr.create(key, negated)
    }
    return new ContextKeyNotEqualsExpr(key, value, negated)
  }
  readonly type = ContextKeyExprType.NotEquals
  private constructor(
    readonly key: string,
    readonly value: unknown,
    private negated: ContextKeyExpression | null,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return cmp2(this.key, this.value, other.key, other.value)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this.key === other.key && this.value === other.value
  }
  evaluate(context: IContext): boolean {
    // Intentional != (loose).

    return context.getValue(this.key) != this.value
  }
  serialize(): string {
    return `${this.key} != '${String(this.value)}'`
  }
  keys(): string[] {
    return [this.key]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeyEqualsExpr.create(this.key, this.value, this)
    }
    return this.negated
  }
}

export class ContextKeyNotExpr implements IContextKeyExpression {
  static create(key: string, negated: ContextKeyExpression | null = null): ContextKeyExpression {
    return new ContextKeyNotExpr(key, negated)
  }
  readonly type = ContextKeyExprType.Not
  private constructor(
    readonly key: string,
    private negated: ContextKeyExpression | null,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return cmp1(this.key, other.key)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this.key === other.key
  }
  evaluate(context: IContext): boolean {
    return !context.getValue(this.key)
  }
  serialize(): string {
    return `!${this.key}`
  }
  keys(): string[] {
    return [this.key]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeyDefinedExpr.create(this.key, this)
    }
    return this.negated
  }
}

function withFloatOrStr<T extends ContextKeyExpression>(
  rawValue: unknown,
  callback: (value: number | string) => T,
): T | ContextKeyFalseExpr {
  let value: unknown = rawValue
  if (typeof value === 'string') {
    const n = parseFloat(value)
    if (!isNaN(n)) {
      value = n
    }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return callback(value)
  }
  return ContextKeyFalseExpr.INSTANCE
}

export class ContextKeyGreaterExpr implements IContextKeyExpression {
  static create(
    key: string,
    rawValue: unknown,
    negated: ContextKeyExpression | null = null,
  ): ContextKeyExpression {
    return withFloatOrStr(rawValue, (v) => new ContextKeyGreaterExpr(key, v, negated))
  }
  readonly type = ContextKeyExprType.Greater
  private constructor(
    readonly key: string,
    readonly value: number | string,
    private negated: ContextKeyExpression | null,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return cmp2(this.key, this.value, other.key, other.value)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this.key === other.key && this.value === other.value
  }
  evaluate(context: IContext): boolean {
    if (typeof this.value === 'string') return false
    return parseFloat(context.getValue(this.key) as string) > this.value
  }
  serialize(): string {
    return `${this.key} > ${this.value}`
  }
  keys(): string[] {
    return [this.key]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeySmallerEqualsExpr.create(this.key, this.value, this)
    }
    return this.negated
  }
}

export class ContextKeyGreaterEqualsExpr implements IContextKeyExpression {
  static create(
    key: string,
    rawValue: unknown,
    negated: ContextKeyExpression | null = null,
  ): ContextKeyExpression {
    return withFloatOrStr(rawValue, (v) => new ContextKeyGreaterEqualsExpr(key, v, negated))
  }
  readonly type = ContextKeyExprType.GreaterEquals
  private constructor(
    readonly key: string,
    readonly value: number | string,
    private negated: ContextKeyExpression | null,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return cmp2(this.key, this.value, other.key, other.value)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this.key === other.key && this.value === other.value
  }
  evaluate(context: IContext): boolean {
    if (typeof this.value === 'string') return false
    return parseFloat(context.getValue(this.key) as string) >= this.value
  }
  serialize(): string {
    return `${this.key} >= ${this.value}`
  }
  keys(): string[] {
    return [this.key]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeySmallerExpr.create(this.key, this.value, this)
    }
    return this.negated
  }
}

export class ContextKeySmallerExpr implements IContextKeyExpression {
  static create(
    key: string,
    rawValue: unknown,
    negated: ContextKeyExpression | null = null,
  ): ContextKeyExpression {
    return withFloatOrStr(rawValue, (v) => new ContextKeySmallerExpr(key, v, negated))
  }
  readonly type = ContextKeyExprType.Smaller
  private constructor(
    readonly key: string,
    readonly value: number | string,
    private negated: ContextKeyExpression | null,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return cmp2(this.key, this.value, other.key, other.value)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this.key === other.key && this.value === other.value
  }
  evaluate(context: IContext): boolean {
    if (typeof this.value === 'string') return false
    return parseFloat(context.getValue(this.key) as string) < this.value
  }
  serialize(): string {
    return `${this.key} < ${this.value}`
  }
  keys(): string[] {
    return [this.key]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeyGreaterEqualsExpr.create(this.key, this.value, this)
    }
    return this.negated
  }
}

export class ContextKeySmallerEqualsExpr implements IContextKeyExpression {
  static create(
    key: string,
    rawValue: unknown,
    negated: ContextKeyExpression | null = null,
  ): ContextKeyExpression {
    return withFloatOrStr(rawValue, (v) => new ContextKeySmallerEqualsExpr(key, v, negated))
  }
  readonly type = ContextKeyExprType.SmallerEquals
  private constructor(
    readonly key: string,
    readonly value: number | string,
    private negated: ContextKeyExpression | null,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return cmp2(this.key, this.value, other.key, other.value)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this.key === other.key && this.value === other.value
  }
  evaluate(context: IContext): boolean {
    if (typeof this.value === 'string') return false
    return parseFloat(context.getValue(this.key) as string) <= this.value
  }
  serialize(): string {
    return `${this.key} <= ${this.value}`
  }
  keys(): string[] {
    return [this.key]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeyGreaterExpr.create(this.key, this.value, this)
    }
    return this.negated
  }
}

export class ContextKeyInExpr implements IContextKeyExpression {
  static create(key: string, valueKey: string): ContextKeyInExpr {
    return new ContextKeyInExpr(key, valueKey)
  }
  readonly type = ContextKeyExprType.In
  private negated: ContextKeyExpression | null = null
  private constructor(
    readonly key: string,
    readonly valueKey: string,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return cmp2(this.key, this.valueKey, other.key, other.valueKey)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this.key === other.key && this.valueKey === other.valueKey
  }
  evaluate(context: IContext): boolean {
    const source = context.getValue(this.valueKey)
    const item = context.getValue(this.key)
    if (Array.isArray(source)) {
      return source.includes(item as never)
    }
    if (typeof item === 'string' && typeof source === 'object' && source !== null) {
      return Object.prototype.hasOwnProperty.call(source, item)
    }
    return false
  }
  serialize(): string {
    return `${this.key} in '${this.valueKey}'`
  }
  keys(): string[] {
    return [this.key, this.valueKey]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeyNotInExpr.create(this.key, this.valueKey)
    }
    return this.negated
  }
}

export class ContextKeyNotInExpr implements IContextKeyExpression {
  static create(key: string, valueKey: string): ContextKeyNotInExpr {
    return new ContextKeyNotInExpr(key, valueKey)
  }
  readonly type = ContextKeyExprType.NotIn
  private readonly _negated: ContextKeyInExpr
  private constructor(
    readonly key: string,
    readonly valueKey: string,
  ) {
    this._negated = ContextKeyInExpr.create(key, valueKey)
  }
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return this._negated.cmp(other._negated)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this._negated.equals(other._negated)
  }
  evaluate(context: IContext): boolean {
    return !this._negated.evaluate(context)
  }
  serialize(): string {
    return `${this.key} not in '${this.valueKey}'`
  }
  keys(): string[] {
    return this._negated.keys()
  }
  negate(): ContextKeyExpression {
    return this._negated
  }
}

export class ContextKeyRegexExpr implements IContextKeyExpression {
  static create(key: string, regexp: RegExp | null): ContextKeyRegexExpr {
    return new ContextKeyRegexExpr(key, regexp)
  }
  readonly type = ContextKeyExprType.Regex
  private negated: ContextKeyExpression | null = null
  private constructor(
    readonly key: string,
    readonly regexp: RegExp | null,
  ) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    if (this.key < other.key) return -1
    if (this.key > other.key) return 1
    const a = this.regexp ? this.regexp.source : ''
    const b = other.regexp ? other.regexp.source : ''
    if (a < b) return -1
    if (a > b) return 1
    return 0
  }
  equals(other: ContextKeyExpression): boolean {
    if (other.type !== this.type) return false
    const a = this.regexp ? this.regexp.source : ''
    const b = other.regexp ? other.regexp.source : ''
    return this.key === other.key && a === b
  }
  evaluate(context: IContext): boolean {
    const value = context.getValue(this.key)
    return this.regexp ? this.regexp.test(value as string) : false
  }
  serialize(): string {
    const v = this.regexp ? `/${this.regexp.source}/${this.regexp.flags}` : '/invalid/'
    return `${this.key} =~ ${v}`
  }
  keys(): string[] {
    return [this.key]
  }
  negate(): ContextKeyExpression {
    if (!this.negated) {
      this.negated = ContextKeyNotRegexExpr.create(this)
    }
    return this.negated
  }
}

export class ContextKeyNotRegexExpr implements IContextKeyExpression {
  static create(actual: ContextKeyRegexExpr): ContextKeyExpression {
    return new ContextKeyNotRegexExpr(actual)
  }
  readonly type = ContextKeyExprType.NotRegex
  private constructor(readonly _actual: ContextKeyRegexExpr) {}
  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    return this._actual.cmp(other._actual)
  }
  equals(other: ContextKeyExpression): boolean {
    return other.type === this.type && this._actual.equals(other._actual)
  }
  evaluate(context: IContext): boolean {
    return !this._actual.evaluate(context)
  }
  serialize(): string {
    return `!(${this._actual.serialize()})`
  }
  keys(): string[] {
    return this._actual.keys()
  }
  negate(): ContextKeyExpression {
    return this._actual
  }
}

export class ContextKeyAndExpr implements IContextKeyExpression {
  static create(
    expr: ReadonlyArray<ContextKeyExpression | null | undefined>,
    negated: ContextKeyExpression | null,
    extraRedundantCheck: boolean,
  ): ContextKeyExpression | undefined {
    return ContextKeyAndExpr._normalizeArr(expr, negated, extraRedundantCheck)
  }

  readonly type = ContextKeyExprType.And

  private constructor(
    readonly expr: ContextKeyExpression[],
    private negated: ContextKeyExpression | null,
  ) {}

  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    if (this.expr.length < other.expr.length) return -1
    if (this.expr.length > other.expr.length) return 1
    for (let i = 0; i < this.expr.length; i++) {
      const a = this.expr[i]
      const b = other.expr[i]
      if (a && b) {
        const r = cmp(a, b)
        if (r !== 0) return r
      }
    }
    return 0
  }

  equals(other: ContextKeyExpression): boolean {
    if (other.type !== this.type) return false
    if (this.expr.length !== other.expr.length) return false
    for (let i = 0; i < this.expr.length; i++) {
      const a = this.expr[i]
      const b = other.expr[i]
      if (!a || !b || !a.equals(b)) return false
    }
    return true
  }

  evaluate(context: IContext): boolean {
    for (const e of this.expr) {
      if (!e.evaluate(context)) return false
    }
    return true
  }

  private static _normalizeArr(
    arr: ReadonlyArray<ContextKeyExpression | null | undefined>,
    negated: ContextKeyExpression | null,
    extraRedundantCheck: boolean,
  ): ContextKeyExpression | undefined {
    const expr: ContextKeyExpression[] = []
    let hasTrue = false

    for (const e of arr) {
      if (!e) continue
      if (e.type === ContextKeyExprType.True) {
        hasTrue = true
        continue
      }
      if (e.type === ContextKeyExprType.False) {
        return ContextKeyFalseExpr.INSTANCE
      }
      if (e.type === ContextKeyExprType.And) {
        expr.push(...e.expr)
        continue
      }
      expr.push(e)
    }

    if (expr.length === 0 && hasTrue) return ContextKeyTrueExpr.INSTANCE
    if (expr.length === 0) return undefined
    if (expr.length === 1) return expr[0]

    expr.sort(cmp)

    for (let i = 1; i < expr.length; i++) {
      const prev = expr[i - 1]
      const cur = expr[i]
      if (prev && cur && prev.equals(cur)) {
        expr.splice(i, 1)
        i--
      }
    }

    if (expr.length === 1) return expr[0]

    // Distribute OR over the AND.
    while (expr.length > 1) {
      const lastElement = expr[expr.length - 1]
      if (!lastElement || lastElement.type !== ContextKeyExprType.Or) break
      expr.pop()
      const secondToLast = expr.pop()
      if (!secondToLast) break
      const isFinished = expr.length === 0
      const distributed = ContextKeyOrExpr.create(
        lastElement.expr.map((el) =>
          ContextKeyAndExpr.create([el, secondToLast], null, extraRedundantCheck),
        ),
        null,
        isFinished,
      )
      if (distributed) {
        expr.push(distributed)
        expr.sort(cmp)
      }
    }

    if (expr.length === 1) return expr[0]

    if (extraRedundantCheck) {
      for (let i = 0; i < expr.length; i++) {
        for (let j = i + 1; j < expr.length; j++) {
          const a = expr[i]
          const b = expr[j]
          if (a && b && a.negate().equals(b)) {
            return ContextKeyFalseExpr.INSTANCE
          }
        }
      }
      if (expr.length === 1) return expr[0]
    }

    return new ContextKeyAndExpr(expr, negated)
  }

  serialize(): string {
    return this.expr.map((e) => e.serialize()).join(' && ')
  }

  keys(): string[] {
    const result: string[] = []
    for (const e of this.expr) result.push(...e.keys())
    return result
  }

  negate(): ContextKeyExpression {
    if (!this.negated) {
      const result: ContextKeyExpression[] = []
      for (const e of this.expr) result.push(e.negate())
      this.negated = ContextKeyOrExpr.create(result, this, true)!
    }
    return this.negated
  }
}

export class ContextKeyOrExpr implements IContextKeyExpression {
  static create(
    expr: ReadonlyArray<ContextKeyExpression | null | undefined>,
    negated: ContextKeyExpression | null,
    extraRedundantCheck: boolean,
  ): ContextKeyExpression | undefined {
    return ContextKeyOrExpr._normalizeArr(expr, negated, extraRedundantCheck)
  }

  readonly type = ContextKeyExprType.Or

  private constructor(
    readonly expr: ContextKeyExpression[],
    private negated: ContextKeyExpression | null,
  ) {}

  cmp(other: ContextKeyExpression): number {
    if (other.type !== this.type) return this.type - other.type
    if (this.expr.length < other.expr.length) return -1
    if (this.expr.length > other.expr.length) return 1
    for (let i = 0; i < this.expr.length; i++) {
      const a = this.expr[i]
      const b = other.expr[i]
      if (a && b) {
        const r = cmp(a, b)
        if (r !== 0) return r
      }
    }
    return 0
  }

  equals(other: ContextKeyExpression): boolean {
    if (other.type !== this.type) return false
    if (this.expr.length !== other.expr.length) return false
    for (let i = 0; i < this.expr.length; i++) {
      const a = this.expr[i]
      const b = other.expr[i]
      if (!a || !b || !a.equals(b)) return false
    }
    return true
  }

  evaluate(context: IContext): boolean {
    for (const e of this.expr) {
      if (e.evaluate(context)) return true
    }
    return false
  }

  private static _normalizeArr(
    arr: ReadonlyArray<ContextKeyExpression | null | undefined>,
    negated: ContextKeyExpression | null,
    extraRedundantCheck: boolean,
  ): ContextKeyExpression | undefined {
    let expr: ContextKeyExpression[] = []
    let hasFalse = false

    for (const e of arr) {
      if (!e) continue
      if (e.type === ContextKeyExprType.False) {
        hasFalse = true
        continue
      }
      if (e.type === ContextKeyExprType.True) {
        return ContextKeyTrueExpr.INSTANCE
      }
      if (e.type === ContextKeyExprType.Or) {
        expr = expr.concat(e.expr)
        continue
      }
      expr.push(e)
    }

    if (expr.length === 0 && hasFalse) return ContextKeyFalseExpr.INSTANCE
    if (expr.length === 0) return undefined
    if (expr.length === 1) return expr[0]

    expr.sort(cmp)

    for (let i = 1; i < expr.length; i++) {
      const prev = expr[i - 1]
      const cur = expr[i]
      if (prev && cur && prev.equals(cur)) {
        expr.splice(i, 1)
        i--
      }
    }

    if (expr.length === 1) return expr[0]

    if (extraRedundantCheck) {
      for (let i = 0; i < expr.length; i++) {
        for (let j = i + 1; j < expr.length; j++) {
          const a = expr[i]
          const b = expr[j]
          if (a && b && a.negate().equals(b)) {
            return ContextKeyTrueExpr.INSTANCE
          }
        }
      }
      if (expr.length === 1) return expr[0]
    }

    return new ContextKeyOrExpr(expr, negated)
  }

  serialize(): string {
    return this.expr.map((e) => e.serialize()).join(' || ')
  }

  keys(): string[] {
    const result: string[] = []
    for (const e of this.expr) result.push(...e.keys())
    return result
  }

  negate(): ContextKeyExpression {
    if (!this.negated) {
      const result: ContextKeyExpression[] = []
      for (const e of this.expr) result.push(e.negate())

      while (result.length > 1) {
        const LEFT = result.shift()!
        const RIGHT = result.shift()!
        const all: ContextKeyExpression[] = []
        for (const left of getTerminals(LEFT)) {
          for (const right of getTerminals(RIGHT)) {
            const a = ContextKeyAndExpr.create([left, right], null, false)
            if (a) all.push(a)
          }
        }
        const combined = ContextKeyOrExpr.create(all, null, false)
        if (combined) result.unshift(combined)
      }

      this.negated = ContextKeyOrExpr.create(result, this, true)!
    }
    return this.negated
  }
}

function getTerminals(node: ContextKeyExpression): ContextKeyExpression[] {
  if (node.type === ContextKeyExprType.Or) return node.expr
  return [node]
}

/**
 * The public-facing builder. Mirrors VSCode's `ContextKeyExpr`.
 */
export abstract class ContextKeyExpr {
  static false(): ContextKeyExpression {
    return ContextKeyFalseExpr.INSTANCE
  }
  static true(): ContextKeyExpression {
    return ContextKeyTrueExpr.INSTANCE
  }
  static has(key: string): ContextKeyExpression {
    return ContextKeyDefinedExpr.create(key)
  }
  static equals(key: string, value: unknown): ContextKeyExpression {
    return ContextKeyEqualsExpr.create(key, value)
  }
  static notEquals(key: string, value: unknown): ContextKeyExpression {
    return ContextKeyNotEqualsExpr.create(key, value)
  }
  static not(key: string): ContextKeyExpression {
    return ContextKeyNotExpr.create(key)
  }
  static regex(key: string, value: RegExp): ContextKeyExpression {
    return ContextKeyRegexExpr.create(key, value)
  }
  static in(key: string, valueKey: string): ContextKeyExpression {
    return ContextKeyInExpr.create(key, valueKey)
  }
  static notIn(key: string, valueKey: string): ContextKeyExpression {
    return ContextKeyNotInExpr.create(key, valueKey)
  }
  static greater(key: string, value: number | string): ContextKeyExpression {
    return ContextKeyGreaterExpr.create(key, value)
  }
  static greaterEquals(key: string, value: number | string): ContextKeyExpression {
    return ContextKeyGreaterEqualsExpr.create(key, value)
  }
  static smaller(key: string, value: number | string): ContextKeyExpression {
    return ContextKeySmallerExpr.create(key, value)
  }
  static smallerEquals(key: string, value: number | string): ContextKeyExpression {
    return ContextKeySmallerEqualsExpr.create(key, value)
  }
  static and(
    ...expr: Array<ContextKeyExpression | null | undefined>
  ): ContextKeyExpression | undefined {
    return ContextKeyAndExpr.create(expr, null, true)
  }
  static or(
    ...expr: Array<ContextKeyExpression | null | undefined>
  ): ContextKeyExpression | undefined {
    return ContextKeyOrExpr.create(expr, null, true)
  }

  private static _parser = new Parser()
  static deserialize(serialized: string | null | undefined): ContextKeyExpression | undefined {
    if (serialized === undefined || serialized === null) return undefined
    return this._parser.parse(serialized)
  }
}
