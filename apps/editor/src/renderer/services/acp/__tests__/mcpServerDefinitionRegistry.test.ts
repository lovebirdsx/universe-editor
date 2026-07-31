import { describe, expect, it } from 'vitest'
import { McpServerDefinitionRegistry } from '../mcpServerDefinitionRegistry.js'

describe('McpServerDefinitionRegistry', () => {
  it('keeps extension definitions in memory and converts them to ACP wire servers', () => {
    const registry = new McpServerDefinitionRegistry()
    registry.set('sample/provider', [
      {
        type: 'stdio',
        name: 'sample',
        command: 'node',
        args: ['server.mjs'],
        env: { SAMPLE: '1' },
      },
    ])

    expect(registry.definitions()).toEqual([
      { name: 'sample', transport: 'stdio', disabled: false, source: 'extension' },
    ])
    expect(registry.wireServers()).toEqual([
      {
        name: 'sample',
        command: 'node',
        args: ['server.mjs'],
        env: [{ name: 'SAMPLE', value: '1' }],
      },
    ])

    registry.remove('sample/provider')
    expect(registry.definitions()).toEqual([])
  })

  it('lets the later provider snapshot win a duplicate server name', () => {
    const registry = new McpServerDefinitionRegistry()
    registry.set('first/provider', [
      { type: 'stdio', name: 'shared', command: 'first', args: [], env: {} },
    ])
    registry.set('second/provider', [
      { type: 'stdio', name: 'shared', command: 'second', args: [], env: {} },
    ])

    expect(registry.wireServers()[0]).toMatchObject({ name: 'shared', command: 'second' })
  })
})
