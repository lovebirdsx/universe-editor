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
