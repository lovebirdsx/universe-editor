/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpAgentRegistry — resolves an agentId to a LaunchSpec. Holds built-in
 *  presets (claude-code) and merges in user-defined agents from the `acp.agents`
 *  configuration. User entries with the same id override built-ins.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  createDecorator,
  Disposable,
  IConfigurationService,
  InstantiationType,
  observableValue,
  registerSingleton,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import type { AcpLaunchSpec } from '../../../shared/ipc/acpHostService.js'
import { IAcpHostService } from '../../../shared/ipc/acpHostService.js'

export interface IAcpAgentDescriptor {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  /**
   * Icon identifier resolved to a logo by the renderer (`workbench/agents/agentIcon`).
   * Built-in: `'claude'` / `'openai'`. User agents may set it; unknown ids fall
   * back to a generic bot icon.
   */
  readonly icon?: string
  /**
   * Launch the bundled agent via Electron's own Node runtime (see
   * `AcpLaunchSpec.runAsNode`). Built-in presets only — never sourced from user
   * `acp.agents` config.
   */
  readonly runAsNode?: boolean
}

/** Generic fallback icon id for unknown / iconless agents. */
export const DEFAULT_AGENT_ICON_ID = 'bot'

/**
 * Resolve an agent's icon id without touching React — used by EditorInput / quick
 * pick where a string identifier is enough. `descriptorIcon` (when known) wins;
 * otherwise the built-in default mapping; otherwise the generic bot fallback.
 */
export function agentIconId(agentId: string | undefined, descriptorIcon?: string): string {
  if (descriptorIcon !== undefined && descriptorIcon.length > 0) return descriptorIcon
  switch (agentId) {
    case 'claude-code':
      return 'claude'
    case 'codex':
      return 'openai'
    default:
      return DEFAULT_AGENT_ICON_ID
  }
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
  /** Reactive default agent id — subscribe in React components via useObservable(). */
  readonly defaultAgentIdObs: IObservable<string>
  /** Update the default agent for this session (Memory layer, resets on restart). */
  setDefaultAgentId(agentId: string): void
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
    // Launched through Electron's own Node runtime against the bundled fork
    // (see AcpLaunchSpec.runAsNode); `command`/`args` are advisory — main owns
    // the entry-file resolution. No system node/npx required.
    command: 'claude-agent-acp',
    args: [],
    icon: 'claude',
    runAsNode: true,
  },
  {
    id: 'codex',
    name: 'Codex (OpenAI)',
    // The codex-acp adapter binary is not on PATH — it is downloaded on demand
    // by ICodexBinaryService and its absolute path is injected as the spawn
    // `command` in AcpClientService._ensureCodexBinary. `command` here is a
    // placeholder used only for logging / the system-source PATH lookup.
    command: 'codex-acp',
    args: [],
    icon: 'openai',
  },
]

/** Built-in agents whose binary is fetched on demand rather than found on PATH. */
const MANAGED_BINARY_AGENT_IDS: ReadonlySet<string> = new Set(['codex'])

export class AcpAgentRegistry extends Disposable implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined

  private readonly _probeCache = new Map<string, Promise<boolean>>()
  private readonly _defaultAgentIdSettable: ISettableObservable<string>
  readonly defaultAgentIdObs: IObservable<string>

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IAcpHostService private readonly _host: IAcpHostService,
  ) {
    super()
    this._defaultAgentIdSettable = observableValue<string>(
      'acp.defaultAgentId',
      this._config.get<string>('acp.defaultAgentId') ?? 'claude-code',
    )
    this.defaultAgentIdObs = this._defaultAgentIdSettable
    this._register(
      this._config.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('acp.defaultAgentId')) {
          this._defaultAgentIdSettable.set(
            this._config.get<string>('acp.defaultAgentId') ?? 'claude-code',
            undefined,
          )
        }
      }),
    )
  }

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
      ...(d.runAsNode ? { runAsNode: true } : {}),
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

  setDefaultAgentId(agentId: string): void {
    this._config.update('acp.defaultAgentId', agentId, ConfigurationTarget.User)
    // onDidChangeConfiguration syncs the observable automatically.
  }

  async health(agentId: string): Promise<IAcpAgentHealth> {
    let descriptor: IAcpAgentDescriptor
    try {
      descriptor = this.get(agentId)
    } catch {
      return { available: false }
    }
    // Bundled (runAsNode) agents ship inside the app — there is no PATH command
    // to probe. A missing entry surfaces as a spawn error on start instead.
    // Managed-binary agents (codex) resolve their binary on demand at start, so
    // PATH probing is likewise meaningless — report available and let a download
    // / resolve failure surface on start.
    if (descriptor.runAsNode || MANAGED_BINARY_AGENT_IDS.has(descriptor.id)) {
      return { available: true }
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
      const icon = typeof e['icon'] === 'string' ? e['icon'] : undefined
      out.push({
        id,
        name,
        command,
        args,
        ...(env ? { env } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(icon !== undefined ? { icon } : {}),
      })
    }
    return out
  }
}

registerSingleton(IAcpAgentRegistry, AcpAgentRegistry, InstantiationType.Delayed)
