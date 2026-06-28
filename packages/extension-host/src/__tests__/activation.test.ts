import { describe, expect, it } from 'vitest'
import {
  ActivationEvents,
  commandActivationEvent,
  isValidActivationEvent,
  languageActivationEvent,
  matchesActivationEvent,
  viewActivationEvent,
} from '@universe-editor/extensions-common'

describe('activation event builders', () => {
  it('build the canonical event strings', () => {
    expect(commandActivationEvent('git.commit')).toBe('onCommand:git.commit')
    expect(languageActivationEvent('typescript')).toBe('onLanguage:typescript')
    expect(viewActivationEvent('scm')).toBe('onView:scm')
  })

  it('ActivationEvents namespace mirrors the builders + constants', () => {
    expect(ActivationEvents.startup).toBe('*')
    expect(ActivationEvents.startupFinished).toBe('onStartupFinished')
    expect(ActivationEvents.onCommand('x')).toBe('onCommand:x')
    expect(ActivationEvents.onLanguage('x')).toBe('onLanguage:x')
    expect(ActivationEvents.onView('x')).toBe('onView:x')
  })
})

describe('isValidActivationEvent', () => {
  it('accepts the standalone events', () => {
    expect(isValidActivationEvent('*')).toBe(true)
    expect(isValidActivationEvent('onStartupFinished')).toBe(true)
  })

  it('accepts parameterized events with a non-empty argument', () => {
    expect(isValidActivationEvent('onCommand:git.commit')).toBe(true)
    expect(isValidActivationEvent('onLanguage:typescript')).toBe(true)
    expect(isValidActivationEvent('onView:scm')).toBe(true)
  })

  it('rejects typos and empty arguments', () => {
    expect(isValidActivationEvent('onComand:git.commit')).toBe(false)
    expect(isValidActivationEvent('onCommand:')).toBe(false)
    expect(isValidActivationEvent('onCommand')).toBe(false)
    expect(isValidActivationEvent('')).toBe(false)
    expect(isValidActivationEvent('startup')).toBe(false)
  })
})

describe('matchesActivationEvent', () => {
  it('matches an exactly declared event', () => {
    expect(matchesActivationEvent(['onCommand:x'], 'onCommand:x')).toBe(true)
    expect(matchesActivationEvent(['onCommand:x'], 'onCommand:y')).toBe(false)
  })

  it('a wildcard matches any non-startup event but not "*" itself driving startup', () => {
    expect(matchesActivationEvent(['*'], 'onStartupFinished')).toBe(true)
    expect(matchesActivationEvent(['*'], 'onCommand:anything')).toBe(true)
    // The '*' trigger only matches an explicit '*' declaration.
    expect(matchesActivationEvent(['onCommand:x'], '*')).toBe(false)
  })
})
