/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/configuration/
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ConfigurationRegistry } from '../../configuration/configurationRegistry.js'
import {
  ConfigurationService,
  ConfigurationTarget,
} from '../../configuration/configurationService.js'

describe('ConfigurationRegistry', () => {
  it('registers a configuration node', () => {
    const d = ConfigurationRegistry.registerConfiguration({
      id: 'test',
      title: 'Test',
      properties: {
        'test.color': { type: 'string', default: 'red', description: 'A color' },
      },
    })

    const nodes = ConfigurationRegistry.getConfigurationNodes()
    expect(nodes.some((n) => n.id === 'test')).toBe(true)
    d.dispose()
  })

  it('getDefaultValue returns the schema default', () => {
    const d = ConfigurationRegistry.registerConfiguration({
      id: 'defaults-test',
      properties: {
        'defaults-test.gridSize': { type: 'number', default: 64 },
      },
    })

    expect(ConfigurationRegistry.getDefaultValue('defaults-test.gridSize')).toBe(64)
    d.dispose()
  })

  it('unregistering removes the node', () => {
    const d = ConfigurationRegistry.registerConfiguration({
      id: 'remove-test',
      properties: { 'remove-test.x': { type: 'boolean', default: true } },
    })
    d.dispose()

    expect(ConfigurationRegistry.getConfigurationNodes().some((n) => n.id === 'remove-test')).toBe(
      false,
    )
  })

  it('fires onDidRegisterConfiguration on register and unregister', () => {
    let count = 0
    const sub = ConfigurationRegistry.onDidRegisterConfiguration(() => count++)

    const d = ConfigurationRegistry.registerConfiguration({
      id: 'event-test',
      properties: {},
    })
    expect(count).toBe(1)

    d.dispose()
    expect(count).toBe(2)

    sub.dispose()
  })
})

describe('ConfigurationService', () => {
  it('returns undefined for unknown key without default', () => {
    const svc = new ConfigurationService()
    expect(svc.get('unknown.key')).toBeUndefined()
    svc.dispose()
  })

  it('returns provided fallback for unknown key', () => {
    const svc = new ConfigurationService()
    expect(svc.get('unknown.key', 42)).toBe(42)
    svc.dispose()
  })

  it('Memory target overrides Default', () => {
    const d = ConfigurationRegistry.registerConfiguration({
      id: 'svc-test',
      properties: {
        'svc-test.size': { type: 'number', default: 10 },
      },
    })

    const svc = new ConfigurationService()
    expect(svc.get('svc-test.size')).toBe(10)

    svc.update('svc-test.size', 99, ConfigurationTarget.Memory)
    expect(svc.get('svc-test.size')).toBe(99)

    d.dispose()
    svc.dispose()
  })

  it('Project target overrides User but not Memory', () => {
    const svc = new ConfigurationService()
    svc.update('x.val', 'user', ConfigurationTarget.User)
    svc.update('x.val', 'project', ConfigurationTarget.Project)
    svc.update('x.val', 'memory', ConfigurationTarget.Memory)

    expect(svc.get('x.val')).toBe('memory')
    svc.dispose()
  })

  it('update fires onDidChangeConfiguration', () => {
    const svc = new ConfigurationService()
    let affectedKey: string | null = null
    svc.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('my.key')) {
        affectedKey = 'my.key'
      }
    })

    svc.update('my.key', 'value')
    expect(affectedKey).toBe('my.key')
    svc.dispose()
  })

  it('update does NOT fire if value is unchanged', () => {
    const svc = new ConfigurationService()
    let count = 0
    svc.onDidChangeConfiguration(() => count++)

    svc.update('dup.key', 'same')
    svc.update('dup.key', 'same')
    expect(count).toBe(1)
    svc.dispose()
  })

  it('loadLayer bulk-loads a configuration layer', () => {
    const svc = new ConfigurationService()
    svc.loadLayer(ConfigurationTarget.User, { 'bulk.a': 1, 'bulk.b': 2 })
    expect(svc.get('bulk.a')).toBe(1)
    expect(svc.get('bulk.b')).toBe(2)
    svc.dispose()
  })

  it('loadLayer fires onDidChangeConfiguration for changed keys only', () => {
    const svc = new ConfigurationService()
    svc.loadLayer(ConfigurationTarget.User, { a: 1, b: 2 })

    const affected: string[] = []
    const sub = svc.onDidChangeConfiguration((e) => {
      for (const k of ['a', 'b', 'c']) {
        if (e.affectsConfiguration(k)) affected.push(k)
      }
    })

    // a unchanged (still 1), b changes 2->3, c new
    svc.loadLayer(ConfigurationTarget.User, { a: 1, b: 3, c: 4 })
    expect(affected.sort()).toEqual(['b', 'c'])
    sub.dispose()
    svc.dispose()
  })

  it('loadLayer with identical data does NOT fire', () => {
    const svc = new ConfigurationService()
    svc.loadLayer(ConfigurationTarget.User, { x: 1 })

    let fired = 0
    const sub = svc.onDidChangeConfiguration(() => fired++)
    svc.loadLayer(ConfigurationTarget.User, { x: 1 })
    expect(fired).toBe(0)
    sub.dispose()
    svc.dispose()
  })

  it('loadLayer fires for removed keys whose effective value changes', () => {
    const svc = new ConfigurationService()
    svc.loadLayer(ConfigurationTarget.User, { a: 1, b: 2 })

    const affected: string[] = []
    const sub = svc.onDidChangeConfiguration((e) => {
      for (const k of ['a', 'b']) {
        if (e.affectsConfiguration(k)) affected.push(k)
      }
    })

    svc.loadLayer(ConfigurationTarget.User, { a: 1 })
    expect(affected).toEqual(['b'])
    sub.dispose()
    svc.dispose()
  })

  it('loadLayer effective-value comparison: lower layer change masked by higher', () => {
    const svc = new ConfigurationService()
    svc.update('m.x', 99, ConfigurationTarget.Memory)
    svc.loadLayer(ConfigurationTarget.User, { 'm.x': 1 })

    let fired = 0
    const sub = svc.onDidChangeConfiguration(() => fired++)
    // User layer changes, but Memory still wins → effective value stays 99
    svc.loadLayer(ConfigurationTarget.User, { 'm.x': 2 })
    expect(fired).toBe(0)
    expect(svc.get('m.x')).toBe(99)
    sub.dispose()
    svc.dispose()
  })

  it('getLayerSnapshot returns a shallow copy', () => {
    const svc = new ConfigurationService()
    svc.loadLayer(ConfigurationTarget.User, { a: 1, b: 2 })

    const snap = svc.getLayerSnapshot(ConfigurationTarget.User) as Record<string, unknown>
    expect(snap).toEqual({ a: 1, b: 2 })

    snap['a'] = 999
    expect(svc.get('a')).toBe(1) // internal state unchanged
    svc.dispose()
  })

  it('auto-picks up defaults from newly registered configuration', () => {
    const svc = new ConfigurationService()
    expect(svc.get('auto.x')).toBeUndefined()

    const d = ConfigurationRegistry.registerConfiguration({
      id: 'auto',
      properties: { 'auto.x': { type: 'number', default: 7 } },
    })
    expect(svc.get('auto.x')).toBe(7)

    d.dispose()
    svc.dispose()
  })
})

describe('ConfigurationService.getValueOrigin', () => {
  it('returns undefined when key is not in any layer', () => {
    const svc = new ConfigurationService()
    expect(svc.getValueOrigin('no.such.key')).toBeUndefined()
    svc.dispose()
  })

  it('returns Default when key only has a schema default', () => {
    const d = ConfigurationRegistry.registerConfiguration({
      id: 'origin-test',
      properties: { 'origin-test.x': { type: 'number', default: 5 } },
    })
    const svc = new ConfigurationService()
    expect(svc.getValueOrigin('origin-test.x')).toBe(ConfigurationTarget.Default)
    d.dispose()
    svc.dispose()
  })

  it('returns User when key is set in User layer', () => {
    const svc = new ConfigurationService()
    svc.update('my.key', 1, ConfigurationTarget.User)
    expect(svc.getValueOrigin('my.key')).toBe(ConfigurationTarget.User)
    svc.dispose()
  })

  it('returns Project when key is set in both User and Project layers (Project wins)', () => {
    const svc = new ConfigurationService()
    svc.update('my.key', 'user', ConfigurationTarget.User)
    svc.update('my.key', 'project', ConfigurationTarget.Project)
    expect(svc.getValueOrigin('my.key')).toBe(ConfigurationTarget.Project)
    svc.dispose()
  })
})

describe('ConfigurationService layer precedence (5 layers)', () => {
  it('VSCodeWorkspace overrides User but is overridden by Project', () => {
    const svc = new ConfigurationService()
    svc.update('p.val', 'user', ConfigurationTarget.User)
    svc.update('p.val', 'vscode', ConfigurationTarget.VSCodeWorkspace)
    expect(svc.get('p.val')).toBe('vscode')

    svc.update('p.val', 'project', ConfigurationTarget.Project)
    expect(svc.get('p.val')).toBe('project')
    expect(svc.getValueOrigin('p.val')).toBe(ConfigurationTarget.Project)
    svc.dispose()
  })
})

describe('ConfigurationService.getMerged', () => {
  it('returns an empty object when no layer defines the key', () => {
    const svc = new ConfigurationService()
    expect(svc.getMerged('files.exclude')).toEqual({})
    svc.dispose()
  })

  it('merges object values across layers, higher layers overriding keys', () => {
    const svc = new ConfigurationService()
    svc.loadLayer(ConfigurationTarget.User, { 'files.exclude': { '**/a': true } })
    svc.loadLayer(ConfigurationTarget.VSCodeWorkspace, { 'files.exclude': { '**/b': true } })
    svc.update('files.exclude', { '**/a': false, '**/c': true }, ConfigurationTarget.Project)

    expect(svc.getMerged('files.exclude')).toEqual({
      '**/a': false, // Project cancels User's true
      '**/b': true,
      '**/c': true,
    })
    svc.dispose()
  })

  it('ignores non-object layer values defensively', () => {
    const svc = new ConfigurationService()
    svc.update('files.exclude', 'not-an-object', ConfigurationTarget.User)
    svc.update('files.exclude', { '**/x': true }, ConfigurationTarget.Project)
    expect(svc.getMerged('files.exclude')).toEqual({ '**/x': true })
    svc.dispose()
  })
})
