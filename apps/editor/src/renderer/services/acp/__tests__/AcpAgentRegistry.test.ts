/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpAgentRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { ConfigurationService, ConfigurationTarget, Emitter } from '@universe-editor/platform'
import { AcpAgentRegistry, agentIconId } from '../acpAgentRegistry.js'
import type { IAcpHostService } from '../../../../shared/ipc/acpHostService.js'

function makeHost(
  probeImpl: (cmd: string) => Promise<boolean> = async () => true,
): IAcpHostService {
  return {
    _serviceBrand: undefined,
    onStdout: new Emitter().event,
    onStderr: new Emitter().event,
    onExit: new Emitter().event,
    start: vi.fn(),
    writeStdin: vi.fn(),
    stop: vi.fn(),
    probe: vi.fn(probeImpl),
  } as unknown as IAcpHostService
}

function makeRegistry(probeImpl?: (cmd: string) => Promise<boolean>): {
  registry: AcpAgentRegistry
  config: ConfigurationService
  host: IAcpHostService
} {
  const config = new ConfigurationService()
  const host = makeHost(probeImpl)
  return { registry: new AcpAgentRegistry(config, host), config, host }
}

describe('AcpAgentRegistry', () => {
  it('exposes the built-in claude-code preset by default', () => {
    const { registry } = makeRegistry()
    const list = registry.list()
    const claude = list.find((a) => a.id === 'claude-code')
    expect(claude).toBeDefined()
    // Bundled fork launched via Electron-as-node — no npx, no PATH command.
    expect(claude?.runAsNode).toBe(true)
  })

  it('defaultAgentId falls back to claude-code when no config is set', () => {
    const { registry } = makeRegistry()
    expect(registry.defaultAgentId()).toBe('claude-code')
  })

  it('exposes the built-in codex preset (runAsNode against the bundled codex-acp adapter)', () => {
    const { registry } = makeRegistry()
    const codex = registry.list().find((a) => a.id === 'codex')
    expect(codex).toBeDefined()
    expect(codex?.runAsNode).toBe(true)
    expect(codex?.nodeEntry).toBe('codex')
  })

  it('resolve() carries codex runAsNode + nodeEntry into the launch spec', () => {
    const { registry } = makeRegistry()
    const spec = registry.resolve('codex')
    expect(spec.runAsNode).toBe(true)
    expect(spec.nodeEntry).toBe('codex')
  })

  it('health reports codex available without a PATH probe (managed binary)', async () => {
    // probeImpl returns false for everything; codex must still be available
    // because its binary is resolved on demand at start, not found on PATH.
    const { registry } = makeRegistry(() => Promise.resolve(false))
    await expect(registry.health('codex')).resolves.toEqual({ available: true })
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

  it('resolve passes runAsNode through for the built-in claude-code preset', () => {
    const { registry } = makeRegistry()
    const spec = registry.resolve('claude-code')
    expect(spec.runAsNode).toBe(true)
  })

  it('resolve omits runAsNode for user-defined PATH agents', () => {
    const { registry, config } = makeRegistry()
    config.update(
      'acp.agents',
      [{ id: 'plain', name: 'Plain', command: '/bin/plain', args: [] }],
      ConfigurationTarget.Memory,
    )
    expect(registry.resolve('plain').runAsNode).toBeUndefined()
  })

  it('health returns { available: true } without probing for runAsNode built-ins', async () => {
    const probe = vi.fn(async () => false)
    const { registry } = makeRegistry(probe)
    await expect(registry.health('claude-code')).resolves.toEqual({ available: true })
    expect(probe).not.toHaveBeenCalled()
  })

  it('health returns { available: true } when the host probe finds the command', async () => {
    const { registry, config } = makeRegistry(async () => true)
    config.update(
      'acp.agents',
      [{ id: 'pathy', name: 'Pathy', command: '/bin/pathy', args: [] }],
      ConfigurationTarget.Memory,
    )
    await expect(registry.health('pathy')).resolves.toEqual({ available: true })
  })

  it('health returns { available: false } when the command is not in PATH', async () => {
    const { registry, config } = makeRegistry(async () => false)
    config.update(
      'acp.agents',
      [{ id: 'pathy', name: 'Pathy', command: '/bin/pathy', args: [] }],
      ConfigurationTarget.Memory,
    )
    await expect(registry.health('pathy')).resolves.toEqual({ available: false })
  })

  it('health returns { available: false } for an unknown agent id without probing', async () => {
    const probe = vi.fn(async () => true)
    const { registry } = makeRegistry(probe)
    await expect(registry.health('nope')).resolves.toEqual({ available: false })
    expect(probe).not.toHaveBeenCalled()
  })

  it('built-in presets carry their official logo icon ids', () => {
    const { registry } = makeRegistry()
    const list = registry.list()
    expect(list.find((a) => a.id === 'claude-code')?.icon).toBe('claude')
    expect(list.find((a) => a.id === 'codex')?.icon).toBe('openai')
  })

  it('parses a user agent icon and keeps it absent when unset', () => {
    const { registry, config } = makeRegistry()
    config.update(
      'acp.agents',
      [
        { id: 'iconful', name: 'Iconful', command: '/x', args: [], icon: 'sparkle' },
        { id: 'plain', name: 'Plain', command: '/y', args: [] },
      ],
      ConfigurationTarget.Memory,
    )
    expect(registry.list().find((a) => a.id === 'iconful')?.icon).toBe('sparkle')
    expect(registry.list().find((a) => a.id === 'plain')?.icon).toBeUndefined()
  })
})

describe('agentIconId', () => {
  it('maps built-in agent ids to their official logo ids', () => {
    expect(agentIconId('claude-code')).toBe('claude')
    expect(agentIconId('codex')).toBe('openai')
  })

  it('prefers an explicit descriptor icon over the id default', () => {
    expect(agentIconId('claude-code', 'sparkle')).toBe('sparkle')
  })

  it('falls back to the generic bot for unknown / undefined agents', () => {
    expect(agentIconId('mystery')).toBe('bot')
    expect(agentIconId(undefined)).toBe('bot')
    expect(agentIconId('claude-code', '')).toBe('claude')
  })
})
