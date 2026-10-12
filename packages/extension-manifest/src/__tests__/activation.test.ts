import { describe, expect, it } from 'vitest'
import {
  ActivationEvents,
  isValidActivationEvent,
  matchesActivationEvent,
  matchesManifestActivationEvent,
} from '../activation.js'

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

describe('matchesManifestActivationEvent', () => {
  const commands = [{ command: 'ext.doIt', title: 'Do It' }]

  it('matches an explicitly declared event', () => {
    expect(
      matchesManifestActivationEvent({ activationEvents: ['onCommand:x'] }, 'onCommand:x'),
    ).toBe(true)
    expect(
      matchesManifestActivationEvent({ activationEvents: ['onLanguage:ts'] }, 'onView:v'),
    ).toBe(false)
  })

  it('derives onCommand from contributes.commands', () => {
    expect(
      matchesManifestActivationEvent(
        { activationEvents: ['onStartupFinished'], contributes: { commands } },
        'onCommand:ext.doIt',
      ),
    ).toBe(true)
  })

  it('does not derive a command the manifest does not contribute', () => {
    expect(
      matchesManifestActivationEvent(
        { activationEvents: ['onStartupFinished'], contributes: { commands } },
        'onCommand:ext.other',
      ),
    ).toBe(false)
  })

  it('keeps the wildcard rule', () => {
    expect(
      matchesManifestActivationEvent(
        { activationEvents: ['*'], contributes: { commands } },
        'onCommand:ext.doIt',
      ),
    ).toBe(true)
    expect(matchesManifestActivationEvent({ activationEvents: ['*'] }, 'onStartupFinished')).toBe(
      true,
    )
  })

  it('keeps an explicit onCommand for a runtime-registered command', () => {
    expect(
      matchesManifestActivationEvent(
        { activationEvents: ['onCommand:ext.internal'], contributes: { commands: [] } },
        'onCommand:ext.internal',
      ),
    ).toBe(true)
  })

  it('leaves non-command events on the declared path', () => {
    const manifest = { activationEvents: ['onLanguage:ts'], contributes: { commands } }
    expect(matchesManifestActivationEvent(manifest, 'onLanguage:ts')).toBe(true)
    expect(matchesManifestActivationEvent(manifest, 'onLanguage:md')).toBe(false)
    expect(matchesManifestActivationEvent(manifest, 'onView:v')).toBe(false)
    expect(matchesManifestActivationEvent(manifest, 'onStartupFinished')).toBe(false)
  })

  it('handles a manifest with no contributes at all', () => {
    expect(matchesManifestActivationEvent({}, 'onCommand:ext.doIt')).toBe(false)
    expect(matchesManifestActivationEvent({}, 'onStartupFinished')).toBe(false)
    expect(
      matchesManifestActivationEvent(
        { activationEvents: ['onCommand:ext.doIt'] },
        'onCommand:ext.doIt',
      ),
    ).toBe(true)
    expect(matchesManifestActivationEvent({ contributes: {} }, 'onCommand:ext.doIt')).toBe(false)
  })
})
