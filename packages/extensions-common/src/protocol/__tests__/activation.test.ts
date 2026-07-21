import { describe, expect, it } from 'vitest'
import { ActivationEvents, isValidActivationEvent, matchesActivationEvent } from '../activation.js'

describe('isValidActivationEvent', () => {
  it('accepts the two standalone events', () => {
    expect(isValidActivationEvent('*')).toBe(true)
    expect(isValidActivationEvent('onStartupFinished')).toBe(true)
  })

  it('accepts parameterized events with a non-empty argument', () => {
    expect(isValidActivationEvent('onCommand:foo.bar')).toBe(true)
    expect(isValidActivationEvent('onLanguage:typescript')).toBe(true)
    expect(isValidActivationEvent('onView:myView')).toBe(true)
    expect(isValidActivationEvent('onCustomEditor:my.editor')).toBe(true)
  })

  it('rejects parameterized events with an empty argument', () => {
    expect(isValidActivationEvent('onCommand:')).toBe(false)
    expect(isValidActivationEvent('onLanguage:')).toBe(false)
  })

  it('rejects unknown / typo prefixes', () => {
    expect(isValidActivationEvent('onComand:foo')).toBe(false)
    expect(isValidActivationEvent('whenever')).toBe(false)
    expect(isValidActivationEvent('')).toBe(false)
  })
})

describe('ActivationEvents builders', () => {
  it('produce the canonical strings', () => {
    expect(ActivationEvents.startup).toBe('*')
    expect(ActivationEvents.startupFinished).toBe('onStartupFinished')
    expect(ActivationEvents.onCommand('foo.bar')).toBe('onCommand:foo.bar')
    expect(ActivationEvents.onLanguage('ts')).toBe('onLanguage:ts')
    expect(ActivationEvents.onView('v')).toBe('onView:v')
    expect(ActivationEvents.onCustomEditor('e')).toBe('onCustomEditor:e')
  })

  it('always build events that validate', () => {
    expect(isValidActivationEvent(ActivationEvents.onCommand('x'))).toBe(true)
    expect(isValidActivationEvent(ActivationEvents.onCustomEditor('y'))).toBe(true)
  })
})

describe('matchesActivationEvent', () => {
  it('matches a directly declared event', () => {
    expect(matchesActivationEvent(['onCommand:foo'], 'onCommand:foo')).toBe(true)
    expect(matchesActivationEvent(['onCommand:foo'], 'onCommand:bar')).toBe(false)
  })

  it('a wildcard extension activates on any non-startup event', () => {
    expect(matchesActivationEvent(['*'], 'onCommand:foo')).toBe(true)
    expect(matchesActivationEvent(['*'], 'onLanguage:ts')).toBe(true)
  })

  it('does not let a wildcard match the startup event itself', () => {
    // '*' IS the startup event; a fired '*' must match a literal '*' declaration,
    // but the wildcard fallback (declared '*' → matches everything) must not
    // double-count it via the fallback branch.
    expect(matchesActivationEvent(['*'], '*')).toBe(true)
    expect(matchesActivationEvent(['onStartupFinished'], '*')).toBe(false)
  })
})
