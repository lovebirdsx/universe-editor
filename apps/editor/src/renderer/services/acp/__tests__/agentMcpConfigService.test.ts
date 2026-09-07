/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  Tests for AgentMcpConfigService — per-agent routing of the two config
 *  services into MCP pool layers: claude-code contributes a user layer only
 *  (its project layer is the workspace `.mcp.json`, owned by the session
 *  service), codex contributes user + project layers, unknown agents get
 *  nothing, and the underlying file-change events aggregate into a single
 *  affinity-tagged onDidChange.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Emitter, type Event } from '@universe-editor/platform'
import type { IClaudeConfigService } from '../../../../shared/ipc/claudeConfigService.js'
import type { ICodexConfigService } from '../../../../shared/ipc/codexConfigService.js'
import { AgentMcpConfigService } from '../agentMcpConfigService.js'

class FakeClaudeConfigService {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChangeMcpConfig = new Emitter<void>()
  readonly onDidChangeMcpConfig: Event<void> = this._onDidChangeMcpConfig.event
  mcpServers: Record<string, unknown> = {}
  readMcpServers(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.mcpServers)
  }
  fireMcpChange(): void {
    this._onDidChangeMcpConfig.fire()
  }
}

class FakeCodexConfigService {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChangeMcpConfig = new Emitter<void>()
  readonly onDidChangeMcpConfig: Event<void> = this._onDidChangeMcpConfig.event
  userMcpServers: Record<string, unknown> = {}
  projectMcpServers: Record<string, unknown> = {}
  projectCalls: string[] = []
  readUserMcpServers(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.userMcpServers)
  }
  readProjectMcpServers(cwd: string): Promise<Record<string, unknown>> {
    this.projectCalls.push(cwd)
    return Promise.resolve(this.projectMcpServers)
  }
  fireMcpChange(): void {
    this._onDidChangeMcpConfig.fire()
  }
}

function makeService() {
  const claude = new FakeClaudeConfigService()
  const codex = new FakeCodexConfigService()
  const service = new AgentMcpConfigService(
    claude as unknown as IClaudeConfigService,
    codex as unknown as ICodexConfigService,
  )
  return { claude, codex, service }
}

describe('AgentMcpConfigService layer routing', () => {
  it('claude-code contributes a user layer only — project stays empty', async () => {
    const { claude, service } = makeService()
    claude.mcpServers = { fs: { command: 'npx' } }
    const layers = await service.readAgentMcpLayers('claude-code', '/ws')
    expect(layers.userLayers).toEqual([
      { source: 'agent-user', raw: { fs: { command: 'npx' } }, agentAffinity: 'claude-code' },
    ])
    expect(layers.projectLayers).toEqual([])
  })

  it('codex contributes user + project layers when a cwd is given', async () => {
    const { codex, service } = makeService()
    codex.userMcpServers = { u: { command: 'user-srv' } }
    codex.projectMcpServers = { p: { command: 'proj-srv' } }
    const layers = await service.readAgentMcpLayers('codex', '/ws')
    expect(layers.userLayers).toEqual([
      { source: 'agent-user', raw: { u: { command: 'user-srv' } }, agentAffinity: 'codex' },
    ])
    expect(layers.projectLayers).toEqual([
      { source: 'agent-project', raw: { p: { command: 'proj-srv' } }, agentAffinity: 'codex' },
    ])
    expect(codex.projectCalls).toEqual(['/ws'])
  })

  it('codex without a cwd contributes only the user layer (project file not read)', async () => {
    const { codex, service } = makeService()
    codex.userMcpServers = { u: { command: 'user-srv' } }
    const layers = await service.readAgentMcpLayers('codex')
    expect(layers.userLayers).toHaveLength(1)
    expect(layers.projectLayers).toEqual([])
    expect(codex.projectCalls).toEqual([])
  })

  it('unknown agents resolve to empty layers', async () => {
    const { service } = makeService()
    await expect(service.readAgentMcpLayers('some-other-agent', '/ws')).resolves.toEqual({
      userLayers: [],
      projectLayers: [],
    })
  })

  it('forwards the authority argument to the config services', async () => {
    const { claude, service } = makeService()
    let seen: string | undefined
    claude.readMcpServers = (authority?: string) => {
      seen = authority
      return Promise.resolve({})
    }
    await service.readAgentMcpLayers('claude-code', '/ws', 'ssh-remote+dev.example.com')
    expect(seen).toBe('ssh-remote+dev.example.com')
  })
})

describe('AgentMcpConfigService change aggregation', () => {
  it('claude file changes fire with the claude-code affinity', () => {
    const { claude, service } = makeService()
    const events: string[] = []
    service.onDidChange((e) => events.push(e.agentAffinity))
    claude.fireMcpChange()
    expect(events).toEqual(['claude-code'])
  })

  it('codex file changes fire with the codex affinity', () => {
    const { codex, service } = makeService()
    const events: string[] = []
    service.onDidChange((e) => events.push(e.agentAffinity))
    codex.fireMcpChange()
    expect(events).toEqual(['codex'])
  })
})
