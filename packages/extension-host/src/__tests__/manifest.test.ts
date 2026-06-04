import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest.js'

const valid = {
  name: 'git',
  version: '0.0.0',
  engines: { universe: '^0.1.0' },
  activationEvents: ['onCommand:git.helloWorld'],
  contributes: {
    commands: [{ command: 'git.helloWorld', title: 'Git: Hello World', category: 'Git' }],
  },
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseManifest(valid)
    expect(m.name).toBe('git')
    expect(m.engines.universe).toBe('^0.1.0')
    expect(m.contributes?.commands?.[0]?.command).toBe('git.helloWorld')
  })

  it('tolerates unknown contribution points (forward-compat)', () => {
    const m = parseManifest({ ...valid, contributes: { commands: [], menus: { x: [] } } })
    expect(m.contributes?.commands).toEqual([])
  })

  it('rejects a manifest missing engines.universe', () => {
    const { engines: _omit, ...withoutEngines } = valid
    expect(() => parseManifest(withoutEngines)).toThrow(/invalid manifest/)
  })

  it('rejects a command contribution missing a title', () => {
    expect(() =>
      parseManifest({ ...valid, contributes: { commands: [{ command: 'x' }] } }),
    ).toThrow(/title/)
  })

  it('rejects a non-object', () => {
    expect(() => parseManifest(null)).toThrow(/invalid manifest/)
  })
})
