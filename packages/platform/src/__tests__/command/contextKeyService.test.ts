/*---------------------------------------------------------------------------------------------
 *  Tests for the enhanced ContextKeyService surface (IContextKey<T> handles,
 *  createKey, contextMatchesRules, getContext, scoped propagation).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { ContextKeyService } from '../../command/contextKey.js'
import { ContextKeyExpr } from '../../command/contextKeyExpr.js'

describe('ContextKeyService — createKey handle', () => {
  it('createKey with default seeds the value', () => {
    const svc = new ContextKeyService()
    const k = svc.createKey<boolean>('isReady', true)
    expect(k.get()).toBe(true)
    expect(svc.get('isReady')).toBe(true)
    svc.dispose()
  })

  it('createKey with undefined default does not seed', () => {
    const svc = new ContextKeyService()
    const k = svc.createKey<string>('lang', undefined)
    expect(k.get()).toBeUndefined()
    expect(svc.get('lang')).toBeUndefined()
    svc.dispose()
  })

  it('handle.set updates the service', () => {
    const svc = new ContextKeyService()
    const k = svc.createKey<string>('lang', 'json')
    k.set('lua')
    expect(svc.get('lang')).toBe('lua')
    expect(k.get()).toBe('lua')
    svc.dispose()
  })

  it('handle.reset returns to default', () => {
    const svc = new ContextKeyService()
    const k = svc.createKey<number>('n', 5)
    k.set(99)
    k.reset()
    expect(k.get()).toBe(5)
    svc.dispose()
  })

  it('handle.reset with no default removes the key', () => {
    const svc = new ContextKeyService()
    const k = svc.createKey<string>('lang', undefined)
    k.set('json')
    k.reset()
    expect(k.get()).toBeUndefined()
    expect(svc.get('lang')).toBeUndefined()
    svc.dispose()
  })

  it('handle.set fires onDidChangeContext with affectsContextKey', () => {
    const svc = new ContextKeyService()
    const k = svc.createKey<string>('lang', undefined)
    const spy = vi.fn()
    svc.onDidChangeContext(spy)
    k.set('json')
    expect(spy).toHaveBeenCalledOnce()
    const event = spy.mock.calls[0]?.[0]
    expect(event.affectsContextKey('lang')).toBe(true)
    expect(event.affectsContextKey('other')).toBe(false)
    svc.dispose()
  })

  it('set with same value does not fire change event', () => {
    const svc = new ContextKeyService()
    svc.set('x', 1)
    const spy = vi.fn()
    svc.onDidChangeContext(spy)
    svc.set('x', 1)
    expect(spy).not.toHaveBeenCalled()
    svc.dispose()
  })
})

describe('ContextKeyService — contextMatchesRules', () => {
  it('undefined rules always matches', () => {
    const svc = new ContextKeyService()
    expect(svc.contextMatchesRules(undefined)).toBe(true)
    svc.dispose()
  })

  it('matches a Defined expression', () => {
    const svc = new ContextKeyService()
    svc.set('a', 1)
    expect(svc.contextMatchesRules(ContextKeyExpr.has('a'))).toBe(true)
    expect(svc.contextMatchesRules(ContextKeyExpr.has('b'))).toBe(false)
    svc.dispose()
  })

  it('matches a compound And/Or expression', () => {
    const svc = new ContextKeyService()
    svc.set('a', true)
    svc.set('lang', 'json')
    const expr = ContextKeyExpr.and(ContextKeyExpr.has('a'), ContextKeyExpr.equals('lang', 'json'))!
    expect(svc.contextMatchesRules(expr)).toBe(true)
    svc.set('lang', 'lua')
    expect(svc.contextMatchesRules(expr)).toBe(false)
    svc.dispose()
  })

  it('legacy evaluate(string) routes through deserialize', () => {
    const svc = new ContextKeyService()
    svc.set('a', true)
    svc.set('b', 1)
    expect(svc.evaluate('a && b')).toBe(true)
    expect(svc.evaluate('a && !b')).toBe(false)
    svc.dispose()
  })

  it('evaluate(string) with malformed expression returns false', () => {
    const svc = new ContextKeyService()
    expect(svc.evaluate('a &&')).toBe(false)
    svc.dispose()
  })
})

describe('ContextKeyService — getContext', () => {
  it('returns an IContext with parent fallback', () => {
    const parent = new ContextKeyService()
    parent.set('p', 'fromParent')
    const child = parent.createScoped()
    child.set('c', 'fromChild')

    const ctx = child.getContext()
    expect(ctx.getValue('p')).toBe('fromParent')
    expect(ctx.getValue('c')).toBe('fromChild')
    expect(ctx.getValue('missing')).toBeUndefined()
    child.dispose()
    parent.dispose()
  })
})

describe('ContextKeyService — scoped', () => {
  it('scoped overrides parent value', () => {
    const parent = new ContextKeyService()
    parent.set('color', 'red')
    const child = parent.createScoped({ color: 'blue' })
    expect(child.get('color')).toBe('blue')
    expect(parent.get('color')).toBe('red')
    child.dispose()
    parent.dispose()
  })

  it('parent change propagates to scoped onDidChangeContext', () => {
    const parent = new ContextKeyService()
    const child = parent.createScoped()
    const spy = vi.fn()
    child.onDidChangeContext(spy)
    parent.set('x', 42)
    expect(spy).toHaveBeenCalledOnce()
    const event = spy.mock.calls[0]?.[0]
    expect(event.affectsContextKey('x')).toBe(true)
    child.dispose()
    parent.dispose()
  })

  it('scoped.dispose clears its local keys', () => {
    const parent = new ContextKeyService()
    const child = parent.createScoped({ localKey: 'value' })
    expect(child.get('localKey')).toBe('value')
    child.dispose()
    // After dispose the scoped instance retains no state.
    expect(child.get('localKey')).toBeUndefined()
    parent.dispose()
  })
})
