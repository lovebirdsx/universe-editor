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

  describe('contributes.mcpServers', () => {
    it('accepts a stdio entry with variables and a whenConfiguration gate', () => {
      const m = parseManifest({
        ...baseManifest(),
        contributes: {
          mcpServers: {
            'universe-editor': {
              command: '${execPath}',
              args: ['${extensionPath}/resources/bridge/bridge.mjs'],
              env: { ELECTRON_RUN_AS_NODE: '1' },
              whenConfiguration: 'universeEditorMcp.enabled',
            },
          },
        },
      })
      expect(m.contributes?.mcpServers?.['universe-editor']).toMatchObject({
        command: '${execPath}',
        whenConfiguration: 'universeEditorMcp.enabled',
      })
    })

    it('is lenient: passes through unknown entry fields (future transports)', () => {
      const m = parseManifest({
        ...baseManifest(),
        contributes: { mcpServers: { remote: { type: 'http', url: 'https://x' } } },
      })
      expect(m.contributes?.mcpServers?.remote).toBeDefined()
    })

    it('rejects an empty command string', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          contributes: { mcpServers: { s: { command: '' } } },
        }),
      ).toThrow(/invalid manifest/)
    })

    it('rejects non-string args items', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          contributes: { mcpServers: { s: { command: 'node', args: [42] } } },
        }),
      ).toThrow(/invalid manifest/)
    })
  })

  describe('contributes.viewsContainers / views', () => {
    it('accepts an activitybar container and views bound to it', () => {
      const m = parseManifest({
        ...baseManifest(),
        activationEvents: ['onView:myExt.nodeDeps'],
        contributes: {
          viewsContainers: {
            activitybar: [{ id: 'myExt.explorer', title: 'My Explorer', icon: '$(files)' }],
          },
          views: {
            'myExt.explorer': [{ id: 'myExt.nodeDeps', name: 'Node Dependencies' }],
            explorer: [{ id: 'myExt.extra', name: 'Extra', when: 'resourceExtname == .ts' }],
          },
        },
      })
      expect(m.contributes?.viewsContainers?.activitybar).toHaveLength(1)
      expect(m.contributes?.views?.['myExt.explorer']?.[0]).toMatchObject({
        id: 'myExt.nodeDeps',
        name: 'Node Dependencies',
      })
      expect(m.contributes?.views?.['explorer']?.[0]?.when).toBe('resourceExtname == .ts')
    })

    it('rejects a container without an icon', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          contributes: {
            viewsContainers: { activitybar: [{ id: 'c', title: 'C' }] },
          },
        }),
      ).toThrow(/invalid manifest/)
    })

    it('rejects a view with an empty id', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          contributes: { views: { explorer: [{ id: '', name: 'X' }] } },
        }),
      ).toThrow(/invalid manifest/)
    })

    it('rejects a view without a name', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          contributes: { views: { explorer: [{ id: 'v' }] } },
        }),
      ).toThrow(/invalid manifest/)
    })
  })

  describe('contributes.languages', () => {
    it('accepts a language with file associations and configuration', () => {
      const m = parseManifest({
        ...baseManifest(),
        contributes: {
          languages: [
            {
              id: 'csv',
              aliases: ['CSV', 'csv'],
              extensions: ['.csv'],
              filenames: ['DATA.CSV'],
              filenamePatterns: ['*.csv'],
              mimetypes: ['text/csv'],
              configuration: './language-configuration.json',
            },
          ],
        },
      })
      expect(m.contributes?.languages?.[0]).toMatchObject({ id: 'csv', extensions: ['.csv'] })
    })

    it('rejects a language without an id', () => {
      expect(() =>
        parseManifest({ ...baseManifest(), contributes: { languages: [{ extensions: ['.x'] }] } }),
      ).toThrow(/invalid manifest/)
    })

    it('rejects non-string association items', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          contributes: { languages: [{ id: 'x', extensions: [42] }] },
        }),
      ).toThrow(/invalid manifest/)
    })
  })

  describe('contributes.colors', () => {
    it('accepts a color with light/dark defaults and optional high-contrast overrides', () => {
      const m = parseManifest({
        ...baseManifest(),
        contributes: {
          colors: [
            {
              id: 'myExt.color1',
              description: 'A themeable color',
              defaults: {
                light: '#ff0000',
                dark: '#00ff00',
                highContrastLight: '#000000',
                highContrastDark: '#ffffff',
              },
            },
          ],
        },
      })
      expect(m.contributes?.colors?.[0]).toMatchObject({
        id: 'myExt.color1',
        defaults: { light: '#ff0000', dark: '#00ff00' },
      })
      expect(m.contributes?.colors?.[0]?.defaults.highContrastDark).toBe('#ffffff')
    })

    it('accepts a defaults value that references another color id', () => {
      const m = parseManifest({
        ...baseManifest(),
        contributes: {
          colors: [
            {
              id: 'myExt.color2',
              description: 'Ref',
              defaults: { light: 'editor.background', dark: '#000000' },
            },
          ],
        },
      })
      expect(m.contributes?.colors?.[0]?.defaults.light).toBe('editor.background')
    })

    it('rejects a color without an id', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          contributes: {
            colors: [{ description: 'x', defaults: { light: '#fff', dark: '#000' } }],
          },
        }),
      ).toThrow(/invalid manifest/)
    })

    it('rejects a color without defaults', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          contributes: { colors: [{ id: 'x', description: 'x' }] },
        }),
      ).toThrow(/invalid manifest/)
    })

    it('rejects a color missing the dark default', () => {
      expect(() =>
        parseManifest({
          ...baseManifest(),
          contributes: {
            colors: [{ id: 'x', description: 'x', defaults: { light: '#fff' } }],
          },
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
