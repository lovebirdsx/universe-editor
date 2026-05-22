/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpAgentRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ConfigurationService, ConfigurationTarget } from '@universe-editor/platform'
import { AcpAgentRegistry } from '../acpAgentRegistry.js'

function makeRegistry(): { registry: AcpAgentRegistry; config: ConfigurationService } {
  const config = new ConfigurationService()
  return { registry: new AcpAgentRegistry(config), config }
}

describe('AcpAgentRegistry', () => {
  it('exposes the built-in claude-code preset by default', () => {
    const { registry } = makeRegistry()
    const list = registry.list()
    const claude = list.find((a) => a.id === 'claude-code')
    expect(claude).toBeDefined()
    expect(claude?.command).toBe('npx')
    expect(claude?.args).toContain('@zed-industries/claude-agent-acp')
  })

  it('defaultAgentId falls back to claude-code when no config is set', () => {
    const { registry } = makeRegistry()
    expect(registry.defaultAgentId()).toBe('claude-code')
  })

  it('defaultAgentId honors acp.defaultAgentId from configuration', () => {
    const { registry, config } = makeRegistry()
    config.update('acp.defaultAgentId', 'my-agent', ConfigurationTarget.Memory)
    expect(registry.defaultAgentId()).toBe('my-agent')
  })

  it('merges user agents from acp.agents with built-ins', () => {
    const { registry, config } = makeRegistry()
    config.update(
      'acp.agents',
      [{ id: 'custom', name: 'Custom', command: '/bin/custom', args: ['--acp'] }],
      ConfigurationTarget.Memory,
    )
    const ids = registry.list().map((a) => a.id)
    expect(ids).toContain('claude-code')
    expect(ids).toContain('custom')
  })

  it('user agent with the same id overrides the built-in', () => {
    const { registry, config } = makeRegistry()
    config.update(
      'acp.agents',
      [
        {
          id: 'claude-code',
          name: 'Local Claude',
          command: '/usr/local/bin/claude',
          args: ['--acp'],
        },
      ],
      ConfigurationTarget.Memory,
    )
    const claude = registry.list().find((a) => a.id === 'claude-code')
    expect(claude?.command).toBe('/usr/local/bin/claude')
    expect(claude?.name).toBe('Local Claude')
  })

  it('ignores malformed entries (missing id/command, non-objects, non-string args)', () => {
    const { registry, config } = makeRegistry()
    config.update(
      'acp.agents',
      [
        null,
        'string-entry',
        { id: 'no-command' },
        { command: '/x', args: [] },
        { id: 'partly-bad', command: '/y', args: ['ok', 42, { x: 1 }] },
      ],
      ConfigurationTarget.Memory,
    )
    const partly = registry.list().find((a) => a.id === 'partly-bad')
    expect(partly).toBeDefined()
    expect(partly?.args).toEqual(['ok'])
    const noCommand = registry.list().find((a) => a.id === 'no-command')
    expect(noCommand).toBeUndefined()
  })

  it('get throws when the agent is unknown', () => {
    const { registry } = makeRegistry()
    expect(() => registry.get('not-there')).toThrow(/Unknown ACP agent/)
  })

  it('resolve(agentId) produces a LaunchSpec compatible with IAcpHostService', () => {
    const { registry, config } = makeRegistry()
    config.update(
      'acp.agents',
      [
        {
          id: 'envful',
          name: 'Envful',
          command: '/bin/agent',
          args: ['-v'],
          env: { TOKEN: 'abc', BAD: 42 },
          cwd: '/work',
        },
      ],
      ConfigurationTarget.Memory,
    )
    const spec = registry.resolve('envful')
    expect(spec.command).toBe('/bin/agent')
    expect(spec.args).toEqual(['-v'])
    expect(spec.cwd).toBe('/work')
    // Non-string env values are dropped during normalization.
    expect(spec.env).toEqual({ TOKEN: 'abc' })
  })

  it('resolve accepts a cwd override that takes precedence over descriptor cwd', () => {
    const { registry, config } = makeRegistry()
    config.update(
      'acp.agents',
      [{ id: 'with-cwd', name: 'X', command: '/x', args: [], cwd: '/baked' }],
      ConfigurationTarget.Memory,
    )
    const spec = registry.resolve('with-cwd', '/runtime')
    expect(spec.cwd).toBe('/runtime')
  })

  it('resolve omits cwd entirely when neither descriptor nor override provides one', () => {
    const { registry } = makeRegistry()
    const spec = registry.resolve('claude-code')
    expect(spec.cwd).toBeUndefined()
  })
})
