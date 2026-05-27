/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpAgentRegistry — resolves an agentId to a LaunchSpec. Holds built-in
 *  presets (claude-code) and merges in user-defined agents from the `acp.agents`
 *  configuration. User entries with the same id override built-ins.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, IConfigurationService } from '@universe-editor/platform'
import type { AcpLaunchSpec } from '../../../shared/ipc/acpHostService.js'
import { IAcpHostService } from '../../../shared/ipc/acpHostService.js'

export interface IAcpAgentDescriptor {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
}

export interface IAcpAgentHealth {
  readonly available: boolean
}

export interface IAcpAgentRegistry {
  readonly _serviceBrand: undefined
  /** Snapshot of all known agents (built-in merged with user). */
  list(): readonly IAcpAgentDescriptor[]
  /** Convenience: ids only. Used by the hydrate sweep that polls every known agent. */
  allAgentIds(): readonly string[]
  /** Resolve an agentId to its descriptor; throws if unknown. */
  get(agentId: string): IAcpAgentDescriptor
  /** Resolve an agentId to a LaunchSpec ready to feed to IAcpHostService.start. */
  resolve(agentId: string, cwdOverride?: string): AcpLaunchSpec
  /** Default agent id (`acp.defaultAgentId`, falls back to `claude-code`). */
  defaultAgentId(): string
  /**
   * Probe whether the agent's command resolves in PATH. Memoized per command —
   * call sites can hit this repeatedly without paying the `where`/`which` cost
   * every time. Returns `{ available: false }` for unknown agents.
   */
  health(agentId: string): Promise<IAcpAgentHealth>
}

export const IAcpAgentRegistry = createDecorator<IAcpAgentRegistry>('acpAgentRegistry')

const BUILTIN_AGENTS: readonly IAcpAgentDescriptor[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
]

export class AcpAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined

  private readonly _probeCache = new Map<string, Promise<boolean>>()

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IAcpHostService private readonly _host: IAcpHostService,
  ) {}

  list(): readonly IAcpAgentDescriptor[] {
    const userAgents = this._readUserAgents()
    const byId = new Map<string, IAcpAgentDescriptor>()
    for (const a of BUILTIN_AGENTS) byId.set(a.id, a)
    for (const a of userAgents) byId.set(a.id, a)
    return [...byId.values()]
  }

  allAgentIds(): readonly string[] {
    return this.list().map((a) => a.id)
  }

  get(agentId: string): IAcpAgentDescriptor {
    const found = this.list().find((a) => a.id === agentId)
    if (!found) throw new Error(`Unknown ACP agent: ${agentId}`)
    return found
  }

  resolve(agentId: string, cwdOverride?: string): AcpLaunchSpec {
    const d = this.get(agentId)
    const spec: AcpLaunchSpec = {
      command: d.command,
      args: d.args,
      ...(d.env ? { env: d.env } : {}),
      ...(cwdOverride !== undefined
        ? { cwd: cwdOverride }
        : d.cwd !== undefined
          ? { cwd: d.cwd }
          : {}),
    }
    return spec
  }

  defaultAgentId(): string {
    return this._config.get<string>('acp.defaultAgentId') ?? 'claude-code'
  }

  async health(agentId: string): Promise<IAcpAgentHealth> {
    let descriptor: IAcpAgentDescriptor
    try {
      descriptor = this.get(agentId)
    } catch {
      return { available: false }
    }
    let probe = this._probeCache.get(descriptor.command)
    if (!probe) {
      probe = this._host.probe(descriptor.command)
      this._probeCache.set(descriptor.command, probe)
    }
    return { available: await probe }
  }

  private _readUserAgents(): readonly IAcpAgentDescriptor[] {
    const raw = this._config.get<unknown>('acp.agents')
    if (!Array.isArray(raw)) return []
    const out: IAcpAgentDescriptor[] = []
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const id = typeof e['id'] === 'string' ? e['id'] : undefined
      const command = typeof e['command'] === 'string' ? e['command'] : undefined
      if (!id || !command) continue
      const name = typeof e['name'] === 'string' ? e['name'] : id
      const args = Array.isArray(e['args'])
        ? e['args'].filter((s): s is string => typeof s === 'string')
        : []
      const env =
        e['env'] && typeof e['env'] === 'object'
          ? (Object.fromEntries(
              Object.entries(e['env'] as Record<string, unknown>).filter(
                ([, v]) => typeof v === 'string',
              ),
            ) as Record<string, string>)
          : undefined
      const cwd = typeof e['cwd'] === 'string' ? e['cwd'] : undefined
      out.push({
        id,
        name,
        command,
        args,
        ...(env ? { env } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      })
    }
    return out
  }
}
