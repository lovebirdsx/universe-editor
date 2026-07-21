import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest-schema.js'

/** A minimal manifest that satisfies every required field. */
function baseManifest(): Record<string, unknown> {
  return {
    name: 'sample',
    version: '0.0.1',
    engines: { universe: '>=0.1.0 <1.0.0' },
  }
}

describe('parseManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = parseManifest(baseManifest())
    expect(m.name).toBe('sample')
    expect(m.engines.universe).toBe('>=0.1.0 <1.0.0')
  })

  describe('required fields', () => {
    it('rejects a missing name', () => {
      const raw = baseManifest()
      delete raw.name
      expect(() => parseManifest(raw)).toThrow(/invalid manifest/)
    })

    it('rejects an empty version', () => {
      expect(() => parseManifest({ ...baseManifest(), version: '' })).toThrow(/version/)
    })

    it('rejects a missing engines block', () => {
      const raw = baseManifest()
      delete raw.engines
      expect(() => parseManifest(raw)).toThrow(/engines/)
    })

    it('rejects engines without universe', () => {
      expect(() => parseManifest({ ...baseManifest(), engines: {} })).toThrow(/engines\.universe/)
    })
  })

  describe('activation events', () => {
    it('accepts the known events', () => {
      const m = parseManifest({
        ...baseManifest(),
        activationEvents: ['*', 'onStartupFinished', 'onCommand:foo.bar', 'onLanguage:ts'],
      })
      expect(m.activationEvents).toHaveLength(4)
    })

    it('rejects a typoed activation event', () => {
      expect(() =>
        parseManifest({ ...baseManifest(), activationEvents: ['onComand:foo'] }),
      ).toThrow(/unknown activation event/)
    })

    it('rejects a parameterized event with no argument', () => {
      expect(() => parseManifest({ ...baseManifest(), activationEvents: ['onCommand:'] })).toThrow(
        /unknown activation event/,
      )
    })
  })

  describe('capabilities.untrustedWorkspaces', () => {
    it('accepts the true form', () => {
      const m = parseManifest({
        ...baseManifest(),
        capabilities: { untrustedWorkspaces: true },
      })
      expect(m.capabilities?.untrustedWorkspaces).toBe(true)
    })

    it('accepts the limited form with a description', () => {
      const m = parseManifest({
        ...baseManifest(),
        capabilities: {
          untrustedWorkspaces: {
            supported: 'limited',
            description: 'partial',
            restrictedConfigurations: ['foo.bar'],
          },
        },
      })
      expect(m.capabilities?.untrustedWorkspaces).toMatchObject({ supported: 'limited' })
    })

    it('rejects the unsupported form without a description', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          capabilities: { untrustedWorkspaces: { supported: false } },
        }),
      ).toThrow(/invalid manifest/)
    })
  })

  describe('forward-compat passthrough', () => {
    it('tolerates unknown contribution points', () => {
      const m = parseManifest({
        ...baseManifest(),
        contributes: { commands: [{ command: 'a', title: 'A' }], somethingNew: [{ x: 1 }] },
      })
      expect(m.contributes?.commands).toHaveLength(1)
    })
  })

  it('rejects a non-object input', () => {
    expect(() => parseManifest(null)).toThrow(/invalid manifest/)
    expect(() => parseManifest('nope')).toThrow(/invalid manifest/)
  })
})
