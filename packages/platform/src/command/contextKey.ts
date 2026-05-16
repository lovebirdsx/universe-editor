/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ContextKey service. Provides:
 *   - IContextKey<T> strongly-typed key handle (set / reset / get)
 *   - createKey(name, defaultValue) factory
 *   - contextMatchesRules(expr) for evaluating ContextKeyExpression AST nodes
 *   - evaluate(when) legacy string entry — delegates to ContextKeyExpr.deserialize
 *   - getContext() returns an IContext compatible with ContextKeyExpression.evaluate
 *   - createScoped() for nested scopes with parent-fallback lookup
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../base/event.js'
import { Disposable, IDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'
import {
  ContextKeyExpr,
  ContextKeyExpression,
  ContextKeyValue,
  IContext,
} from './contextKeyExpr.js'

export interface IContextKeyChangeEvent {
  affectsContextKey(key: string): boolean
}

export interface IContextKey<T extends ContextKeyValue = ContextKeyValue> {
  set(value: T): void
  reset(): void
  get(): T | undefined
}

export interface IContextKeyService {
  readonly _serviceBrand: undefined
  readonly onDidChangeContext: Event<IContextKeyChangeEvent>

  /** Set a context key value. */
  set(key: string, value: unknown): void
  /** Get a context key value (falls back to parent scope). */
  get(key: string): unknown
  /** Remove a key from this context. */
  remove(key: string): void
  /**
   * Evaluate a when-clause expression string.
   * Routes through ContextKeyExpr.deserialize.
   */
  evaluate(when: string): boolean
  /**
   * Evaluate a ContextKeyExpression AST against the current context.
   * `undefined` rules evaluates to true (VSCode semantics).
   */
  contextMatchesRules(rules: ContextKeyExpression | undefined): boolean
  /**
   * Create a strongly-typed handle for a context key.
   * Setting `defaultValue` initializes the key immediately.
   */
  createKey<T extends ContextKeyValue>(key: string, defaultValue: T | undefined): IContextKey<T>
  /** Return an IContext snapshot view over this service. */
  getContext(): IContext
  /**
   * Create a scoped child context. Reads fall back to the parent;
   * writes stay local.
   */
  createScoped(overrides?: Record<string, unknown>): IScopedContextKeyService
}

export interface IScopedContextKeyService extends IContextKeyService, IDisposable {}

export const IContextKeyService = createDecorator<IContextKeyService>('contextKeyService')

class ContextKeyHandle<T extends ContextKeyValue> implements IContextKey<T> {
  constructor(
    private readonly _service: ContextKeyService,
    private readonly _key: string,
    private readonly _defaultValue: T | undefined,
  ) {
    if (this._defaultValue !== undefined) {
      this._service.set(this._key, this._defaultValue)
    }
  }

  set(value: T): void {
    this._service.set(this._key, value)
  }

  reset(): void {
    if (this._defaultValue === undefined) {
      this._service.remove(this._key)
    } else {
      this._service.set(this._key, this._defaultValue)
    }
  }

  get(): T | undefined {
    return this._service.get(this._key) as T | undefined
  }
}

export class ContextKeyService extends Disposable implements IContextKeyService {
  declare readonly _serviceBrand: undefined

  protected readonly _keys = new Map<string, unknown>()
  protected readonly _onDidChangeContext = this._register(new Emitter<IContextKeyChangeEvent>())
  readonly onDidChangeContext = this._onDidChangeContext.event

  constructor(private readonly _parent?: ContextKeyService) {
    super()
    if (this._parent) {
      // Propagate parent changes so scoped consumers re-evaluate.
      this._register(
        this._parent.onDidChangeContext((e) => {
          this._onDidChangeContext.fire(e)
        }),
      )
    }
  }

  set(key: string, value: unknown): void {
    if (this._keys.get(key) === value && this._keys.has(key)) {
      return
    }
    this._keys.set(key, value)
    this._fireChange([key])
  }

  get(key: string): unknown {
    if (this._keys.has(key)) {
      return this._keys.get(key)
    }
    return this._parent?.get(key)
  }

  remove(key: string): void {
    if (this._keys.has(key)) {
      this._keys.delete(key)
      this._fireChange([key])
    }
  }

  evaluate(when: string): boolean {
    const expr = ContextKeyExpr.deserialize(when)
    if (expr === undefined) {
      // Empty or malformed expressions are treated as non-matching for the
      // legacy string entry. (contextMatchesRules(undefined) === true is
      // reserved for callers that explicitly hold no constraint.)
      return false
    }
    return expr.evaluate(this.getContext())
  }

  contextMatchesRules(rules: ContextKeyExpression | undefined): boolean {
    if (rules === undefined) {
      return true
    }
    return rules.evaluate(this.getContext())
  }

  createKey<T extends ContextKeyValue>(key: string, defaultValue: T | undefined): IContextKey<T> {
    return new ContextKeyHandle<T>(this, key, defaultValue)
  }

  getContext(): IContext {
    return {
      getValue: <T>(key: string): T | undefined => this.get(key) as T | undefined,
    }
  }

  createScoped(overrides?: Record<string, unknown>): IScopedContextKeyService {
    const scoped = new ScopedContextKeyService(this)
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        scoped.set(key, value)
      }
    }
    return scoped
  }

  protected _fireChange(keys: readonly string[]): void {
    const set = new Set(keys)
    this._onDidChangeContext.fire({
      affectsContextKey: (k) => set.has(k),
    })
  }
}

class ScopedContextKeyService extends ContextKeyService implements IScopedContextKeyService {
  constructor(parent: ContextKeyService) {
    super(parent)
  }

  override dispose(): void {
    this._keys.clear()
    super.dispose()
  }
}
