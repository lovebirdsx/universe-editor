/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Simplified ContextKey service for M1. Only supports key=value storage.
 *  Full expression parser (DSL) is deferred to a later milestone.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import { Emitter, Event } from '../base/event.js'
import { Disposable, IDisposable } from '../base/lifecycle.js'

export interface IContextKeyChangeEvent {
  affectsContextKey(key: string): boolean
}

export interface IContextKeyService {
  readonly _serviceBrand: undefined
  readonly onDidChangeContext: Event<IContextKeyChangeEvent>

  /** Set a context key value. */
  set(key: string, value: unknown): void
  /** Get a context key value. */
  get(key: string): unknown
  /** Remove a key from the context. */
  remove(key: string): void
  /**
   * Evaluate a simple when-clause expression.
   * Supports: bare key (truthy check), key==value, key!=value, !key.
   */
  evaluate(when: string): boolean
  /**
   * Create a scoped child context. Changes in the child override the parent.
   */
  createScoped(overrides?: Record<string, unknown>): IScopedContextKeyService
}

export interface IScopedContextKeyService extends IContextKeyService, IDisposable {}

export const IContextKeyService = createDecorator<IContextKeyService>('contextKeyService')

export class ContextKeyService extends Disposable implements IContextKeyService {
  declare readonly _serviceBrand: undefined

  private readonly _keys = new Map<string, unknown>()
  private readonly _onDidChangeContext = this._register(new Emitter<IContextKeyChangeEvent>())
  readonly onDidChangeContext = this._onDidChangeContext.event

  constructor(private readonly _parent?: IContextKeyService) {
    super()
  }

  set(key: string, value: unknown): void {
    this._keys.set(key, value)
    this._onDidChangeContext.fire({
      affectsContextKey: (k) => k === key,
    })
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
      this._onDidChangeContext.fire({
        affectsContextKey: (k) => k === key,
      })
    }
  }

  /**
   * Evaluates simplified when-clause expressions:
   * - `"myKey"` → truthy check
   * - `"myKey == 'value'"` → equality check
   * - `"myKey != 'value'"` → inequality check
   * - `"!myKey"` → negation
   */
  evaluate(when: string): boolean {
    const trimmed = when.trim()

    // Negation: !key
    if (trimmed.startsWith('!')) {
      return !this.get(trimmed.slice(1).trim())
    }

    // Equality: key == value
    const eqMatch = /^(\w+)\s*==\s*'?([^']*)'?$/.exec(trimmed)
    if (eqMatch) {
      const [, key, val] = eqMatch
      return String(this.get(key ?? '')) === val
    }

    // Inequality: key != value
    const neqMatch = /^(\w+)\s*!=\s*'?([^']*)'?$/.exec(trimmed)
    if (neqMatch) {
      const [, key, val] = neqMatch
      return String(this.get(key ?? '')) !== val
    }

    // Bare key: truthy check
    return !!this.get(trimmed)
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
}

class ScopedContextKeyService extends ContextKeyService implements IScopedContextKeyService {
  constructor(parent: IContextKeyService) {
    super(parent)
  }
}
