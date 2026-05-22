/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpAgentRegistry — resolves an agentId to a LaunchSpec. Holds built-in
 *  presets (claude-code) and merges in user-defined agents from the `acp.agents`
 *  configuration. User entries with the same id override built-ins.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, IConfigurationService } from '@universe-editor/platform'
import type { AcpLaunchSpec } from '../../../shared/ipc/acpHostService.js'

export interface IAcpAgentDescriptor {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
}

export interface IAcpAgentRegistry {
  readonly _serviceBrand: undefined
  /** Snapshot of all known agents (built-in merged with user). */
  list(): readonly IAcpAgentDescriptor[]
  /** Resolve an agentId to its descriptor; throws if unknown. */
  get(agentId: string): IAcpAgentDescriptor
  /** Resolve an agentId to a LaunchSpec ready to feed to IAcpHostService.start. */
  resolve(agentId: string, cwdOverride?: string): AcpLaunchSpec
  /** Default agent id (`acp.defaultAgentId`, falls back to `claude-code`). */
  defaultAgentId(): string
}

export const IAcpAgentRegistry = createDecorator<IAcpAgentRegistry>('acpAgentRegistry')

const BUILTIN_AGENTS: readonly IAcpAgentDescriptor[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    // ACP-mode entry for Claude Code is the Zed-maintained wrapper package
    // `@zed-industries/claude-agent-acp` — the official `@anthropic-ai/claude-code`
    // CLI does not speak ACP itself. Users can override via `acp.agents`.
    command: 'npx',
    args: ['-y', '@zed-industries/claude-agent-acp'],
  },
]

export class AcpAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined

  constructor(@IConfigurationService private readonly _config: IConfigurationService) {}

  list(): readonly IAcpAgentDescriptor[] {
    const userAgents = this._readUserAgents()
    const byId = new Map<string, IAcpAgentDescriptor>()
    for (const a of BUILTIN_AGENTS) byId.set(a.id, a)
    for (const a of userAgents) byId.set(a.id, a)
    return [...byId.values()]
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
