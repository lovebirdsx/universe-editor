/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  acpMcpServers — pure helpers that turn the user-facing `acp.mcpServers`
 *  setting into the ACP wire shape (`McpServer[]`) and gate it against the
 *  transports the connected agent actually advertises.
 *
 *  The setting accepts a Record keyed by server name (close to Claude's
 *  `.mcp.json`), e.g.
 *    { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *      "docs": { "type": "http", "url": "https://…", "headers": { "Authorization": "…" } } }
 *  The legacy ACP array form is also accepted so existing configs keep working.
 *
 *  Invalid entries are skipped with a warning rather than thrown, mirroring
 *  `AcpAgentRegistry._readUserAgents`: a single typo must not break session
 *  creation.细粒度校验全部落在这里——平台的 configuration schema 不支持
 *  `properties`/`additionalProperties`,无法在 schema 层校验对象结构。
 *--------------------------------------------------------------------------------------------*/

import type { EnvVariable, HttpHeader, McpCapabilities, McpServer } from '@agentclientprotocol/sdk'

type WarnFn = (msg: string) => void

/** A name+value pair shared by both `EnvVariable` and `HttpHeader`. */
export function mcpServerPairs(input: unknown): Array<{ name: string; value: string }> {
  if (Array.isArray(input)) {
    const out: Array<{ name: string; value: string }> = []
    for (const item of input) {
      if (item != null && typeof item === 'object') {
        const name = (item as { name?: unknown }).name
        const value = (item as { value?: unknown }).value
        if (typeof name === 'string' && typeof value === 'string') out.push({ name, value })
      }
    }
    return out
  }
  if (input != null && typeof input === 'object') {
    const out: Array<{ name: string; value: string }> = []
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      if (typeof value === 'string') out.push({ name, value })
    }
    return out
  }
  return []
}

function buildServer(name: string, cfg: unknown, onWarn?: WarnFn): McpServer | undefined {
  if (!name) {
    onWarn?.('entry with empty name, skipped')
    return undefined
  }
  if (cfg == null || typeof cfg !== 'object') {
    onWarn?.(`mcp server "${name}": config must be an object, skipped`)
    return undefined
  }
  const o = cfg as Record<string, unknown>
  const type = typeof o.type === 'string' ? o.type : undefined

  if (type === 'http' || type === 'sse') {
    if (typeof o.url !== 'string' || !o.url) {
      onWarn?.(`mcp server "${name}": ${type} transport requires "url", skipped`)
      return undefined
    }
    const headers: HttpHeader[] = mcpServerPairs(o.headers)
    return { type, name, url: o.url, headers }
  }

  if (type === 'acp') {
    onWarn?.(`mcp server "${name}": acp transport is experimental and not supported yet, skipped`)
    return undefined
  }

  if (type === undefined || type === 'stdio') {
    if (typeof o.command !== 'string' || !o.command) {
      onWarn?.(`mcp server "${name}": stdio transport requires "command", skipped`)
      return undefined
    }
    const args = Array.isArray(o.args)
      ? o.args.filter((a): a is string => typeof a === 'string')
      : []
    const env: EnvVariable[] = mcpServerPairs(o.env)
    // stdio entries MUST NOT carry a `type` field: the agent detects stdio via
    // `!('type' in server)` and would otherwise drop the server silently.
    return { name, command: o.command, args, env }
  }

  onWarn?.(`mcp server "${name}": unknown transport "${type}", skipped`)
  return undefined
}

/**
 * Normalize the raw `acp.mcpServers` value into the ACP wire shape.
 * Accepts the Record form (key = server name) or the legacy array form.
 */
export function normalizeMcpServers(raw: unknown, onWarn?: WarnFn): McpServer[] {
  if (raw == null) return []

  const byName = new Map<string, McpServer>()

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item == null || typeof item !== 'object') {
        onWarn?.('mcp server entry must be an object, skipped')
        continue
      }
      const name = (item as { name?: unknown }).name
      if (typeof name !== 'string' || !name) {
        onWarn?.('mcp server entry missing "name", skipped')
        continue
      }
      const server = buildServer(name, item, onWarn)
      if (server) {
        if (byName.has(name)) onWarn?.(`mcp server "${name}": duplicate name, later entry wins`)
        byName.set(name, server)
      }
    }
    return [...byName.values()]
  }

  if (typeof raw === 'object') {
    for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
      const server = buildServer(name, cfg, onWarn)
      if (server) byName.set(name, server)
    }
    return [...byName.values()]
  }

  return []
}

export type McpTransport = 'stdio' | 'http' | 'sse'

/** Transport of a wire `McpServer` (stdio entries carry no `type` field). */
export function mcpServerTransport(server: McpServer): McpTransport {
  if (!('type' in server)) return 'stdio'
  return server.type === 'http' ? 'http' : server.type === 'sse' ? 'sse' : 'stdio'
}

// ---------------------------------------------------------------------------
// Definition pool (UI-facing) — where servers come from and whether they are
// enabled by default. The wire `McpServer[]` must never carry these editor-side
// annotations (`disabled` / `source`), so the pool is tracked separately and
// joined back by server name.
// ---------------------------------------------------------------------------

/**
 * Where an MCP server definition came from. Later layers override earlier ones
 * with the same name: `extension` (declarative `contributes.mcpServers`, lowest)
 * < `agent-user` (agent's own user-level config: `~/.claude.json`,
 * `~/.claude/settings.json`, `~/.codex/config.toml`)
 * < `global` (user settings)
 * < `project` (workspace settings)
 * < `agent-project` (agent's own project-level config: `<cwd>/.mcp.json` for
 * Claude, `<cwd>/.codex/config.toml` for Codex).
 *
 * `agent-*` sources are per-agent isolated: a Claude MCP definition only flows
 * to claude-code sessions, a Codex one only to codex sessions. The pool
 * filters by the active agent — see `agentAffinity` on `McpServerDefinition`.
 */
export type McpServerSource = 'extension' | 'global' | 'project' | 'agent-user' | 'agent-project'

/** Identifies which agent family an `agent-*` source belongs to. */
export type McpAgentAffinity = 'claude-code' | 'codex'

/**
 * The MCP-source affinity an agent id maps to. Only the two built-in agents
 * own config files the editor imports; custom agents share the settings pool.
 * Single source of truth — `AgentMcpConfigService` (which layers to read) and
 * `AcpSessionService` (wire isolation) both derive from this.
 */
export function agentIdToMcpAffinity(agentId: string | undefined): McpAgentAffinity | undefined {
  return agentId === 'claude-code' || agentId === 'codex' ? agentId : undefined
}

/**
 * One settings layer contributing to `acp.mcpServers`, lowest priority first.
 * `source` is the pool attribution a server gets when THIS layer wins its name.
 */
export interface McpServerRawLayer {
  readonly source: McpServerSource
  readonly raw: unknown
  /**
   * Which agent family this layer belongs to. Required when `source` is
   * `agent-user` or `agent-project`; omitted for the shared layers (extension /
   * settings). Layers with a different affinity than the active agent are
   * dropped before merging.
   */
  readonly agentAffinity?: McpAgentAffinity
}

/** Convert one raw layer value (Record or legacy array form) into a by-name record. */
export function mcpServerRawToRecord(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {}
    for (const item of raw) {
      if (item != null && typeof item === 'object') {
        const name = (item as { name?: unknown }).name
        if (typeof name === 'string' && name) out[name] = item
      }
    }
    return out
  }
  if (raw != null && typeof raw === 'object') return raw as Record<string, unknown>
  return {}
}

/**
 * Merge raw `acp.mcpServers` layer values per server name (later layers win).
 * Settings layers compose like VSCode's `files.exclude` — a workspace entry
 * overrides only the global entry with the same name, never the whole map.
 */
export function mergeMcpServerRawLayers(
  layers: readonly McpServerRawLayer[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const layer of layers) Object.assign(out, mcpServerRawToRecord(layer.raw))
  return out
}

/**
 * Layered variant of {@link readMcpServerDefinitions}: merges the raw layers
 * per name and attributes each surviving definition to the layer that won it
 * (transport is read from the winning entry). An invalid winning entry drops
 * the name entirely — a broken workspace override must not silently fall back
 * to the global definition it shadows.
 *
 * `agentAffinity` filters the layers before merging: when provided, layers
 * whose own `agentAffinity` mismatches are dropped (per-agent isolation);
 * when omitted, **all** layers participate — the union view the picker mirror
 * shows, where each definition carries its `agentAffinity` badge and the UI
 * narrows by the session's agent (see `McpServerPicker.filterPoolForSession`).
 */
export function readMcpServerDefinitionsLayered(
  layers: readonly McpServerRawLayer[],
  onWarn?: WarnFn,
  isDisabled?: (name: string) => boolean,
  agentAffinity?: McpAgentAffinity,
): McpServerDefinition[] {
  const filtered =
    agentAffinity === undefined
      ? layers
      : layers.filter((l) => l.agentAffinity === undefined || l.agentAffinity === agentAffinity)
  const sourceByName = new Map<string, McpServerSource>()
  const affinityByName = new Map<string, McpAgentAffinity>()
  const affinitiesByName = new Map<string, Set<McpAgentAffinity>>()
  const sharedLayerNames = new Set<string>()
  // Names defined by any user-level layer (everything except the workspace
  // `project` layers: extension contributions, agent-user, VSCodeUser, User,
  // Memory) — the UI offers the user-level default toggle only for these.
  const userLevelNames = new Set<string>()
  for (const layer of filtered) {
    for (const name of Object.keys(mcpServerRawToRecord(layer.raw))) {
      sourceByName.set(name, layer.source)
      if (layer.agentAffinity !== undefined) {
        affinityByName.set(name, layer.agentAffinity)
        const set = affinitiesByName.get(name) ?? new Set<McpAgentAffinity>()
        set.add(layer.agentAffinity)
        affinitiesByName.set(name, set)
      } else {
        sharedLayerNames.add(name)
      }
      if (layer.source !== 'project' && layer.source !== 'agent-project') userLevelNames.add(name)
    }
  }
  // Union-view only: the union shows one row per name, labeled with the
  // winning layer's affinity. Other agents that also define the name must
  // stay visible in their own picker (their layers DO wire the server), so
  // they are recorded in `sharedWith`:
  //  - winner is agent-A's layer and agent-B also defines the name
  //    (B's definition is shadowed — `filterPoolForSession` would otherwise
  //    drop the row entirely from B's picker);
  //  - winner is a shared layer and agent-A also defines the name (A's own
  //    definition is shadowed but A's wire path still includes the shared
  //    winner) — the other known agent is recorded so B's picker keeps the
  //    row too; B simply has nothing shadowed here.
  // Per-agent filtered reads (the wire paths) skip this entirely — their
  // consumers never see cross-agent rows.
  const sharedWithByName = new Map<string, Set<McpAgentAffinity>>()
  if (agentAffinity === undefined) {
    const KNOWN_AFFINITIES: readonly McpAgentAffinity[] = ['claude-code', 'codex']
    for (const [name, affinities] of affinitiesByName) {
      const winner = affinityByName.get(name)
      if (winner !== undefined) {
        const others = new Set([...affinities].filter((a) => a !== winner))
        if (sharedLayerNames.has(name)) {
          for (const a of KNOWN_AFFINITIES) {
            if (a !== winner && !affinities.has(a)) others.add(a)
          }
        }
        if (others.size > 0) sharedWithByName.set(name, others)
      }
    }
  }
  const defs = readMcpServerDefinitions(
    mergeMcpServerRawLayers(filtered),
    'global',
    onWarn,
    isDisabled,
  )
  return defs.map((d) => {
    // In the union view the winner's own affinity labels the definition; a
    // shared-layer winner shadowed by a same-named agent layer (the other
    // agent's view) keeps the affinity the per-agent read would attribute.
    const affinity = affinityByName.get(d.name)
    const sharedWith = sharedWithByName.get(d.name)
    return {
      ...d,
      source: sourceByName.get(d.name) ?? d.source,
      ...(affinity !== undefined ? { agentAffinity: affinity } : {}),
      ...(sharedWith !== undefined ? { sharedWith: [...sharedWith] } : {}),
      ...(userLevelNames.has(d.name) ? { hasUserLevelDefinition: true } : {}),
    }
  })
}

/**
 * One entry of the MCP definition pool shown in the session picker. `disabled`
 * is the default switch for new sessions, resolved by the caller via the
 * `isDisabled` callback (today: `IMcpServerEnablementService`, persisted in
 * storage — the legacy `disabled` entry field in settings.json is inert and
 * never read): a disabled server is not forwarded on session/new unless a
 * session-level whitelist explicitly re-enables it.
 */
export interface McpServerDefinition {
  readonly name: string
  readonly transport: McpTransport
  readonly disabled: boolean
  readonly source: McpServerSource
  /**
   * Present when `source` is `agent-user` / `agent-project`. Identifies which
   * agent family the definition belongs to; the UI shows a per-agent badge and
   * the pool filter drops definitions whose affinity does not match the active
   * agent.
   */
  readonly agentAffinity?: McpAgentAffinity
  /**
   * True when the winning definition lives in the workspace `.mcp.json` file
   * (set by the session service when it merges the pool). Surfaced as the
   * source badge in the picker; the default switch is editable for these
   * entries like any other (enablement lives in storage, not in the file).
   */
  readonly fromMcpJson?: boolean
  /**
   * True when a user-level layer (extension contribution, VSCodeUser, User,
   * Memory, or an agent-user layer — anything but the workspace `project`
   * layers) defines this name. Drives the visibility of the user-level default
   * toggle: workspace-only names get just the workspace switch, while names
   * that also exist at user level offer both (workspace wins). Absent
   * (undefined) means false; set by `readMcpServerDefinitionsLayered`, and
   * propagated to `.mcp.json` winners by the session service at merge time.
   * In the union view (no affinity filter) the flag is true when ANY layer —
   * including a mismatched-affinity one — defines the name at user level, so a
   * shadowed same-named entry still offers the user-level default toggle.
   */
  readonly hasUserLevelDefinition?: boolean
  /**
   * Union-view only: other agents that also define this name, besides the
   * agent whose layer owns the row's `agentAffinity`. The union shows one row
   * per name, so a same-named definition from a second agent would otherwise
   * be invisible in that agent's picker even though its own layers do wire
   * the server; `filterPoolForSession` keeps a row when the session's agent
   * appears here, and the picker's hint explains the contents come from a
   * shared higher-priority layer.
   */
  readonly sharedWith?: readonly McpAgentAffinity[]
}

/**
 * Read the user-facing pool (name / transport / disabled) from a raw config
 * value. Shares `buildServer` with `normalizeMcpServers` so an entry that would
 * be skipped on the wire is also hidden from the picker — never offer a toggle
 * for a server the agent would silently drop.
 */
export function readMcpServerDefinitions(
  raw: unknown,
  source: McpServerSource,
  onWarn?: WarnFn,
  isDisabled?: (name: string) => boolean,
): McpServerDefinition[] {
  const out: McpServerDefinition[] = []
  const seen = new Set<string>()
  const push = (name: string, cfg: unknown): void => {
    const server = buildServer(name, cfg, onWarn)
    if (!server || seen.has(server.name)) return
    seen.add(server.name)
    const disabled = isDisabled?.(server.name) ?? false
    out.push({ name: server.name, transport: mcpServerTransport(server), disabled, source })
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item == null || typeof item !== 'object') continue
      const name = (item as { name?: unknown }).name
      if (typeof name === 'string') push(name, item)
    }
    return out
  }
  if (raw != null && typeof raw === 'object') {
    for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) push(name, cfg)
  }
  return out
}

/**
 * Parse `.mcp.json` text into the Record form consumable by
 * `normalizeMcpServers` / `readMcpServerDefinitions`. Accepts both the
 * Claude-Code envelope (`{ "mcpServers": { … } }`) and a bare top-level record.
 * Unparseable / wrong-shaped input degrades to an empty record with a warning.
 */
export function parseMcpJson(text: string, onWarn?: WarnFn): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    onWarn?.(`.mcp.json: invalid JSON (${(err as Error).message}), ignored`)
    return {}
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    onWarn?.('.mcp.json: top level must be an object, ignored')
    return {}
  }
  const inner = (parsed as Record<string, unknown>)['mcpServers']
  if (inner != null && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>
  }
  return parsed as Record<string, unknown>
}

/** Merge two pools; `project` rows override `global` rows with the same name. */
export function mergeMcpServerDefinitions(
  globalDefs: readonly McpServerDefinition[],
  projectDefs: readonly McpServerDefinition[],
): McpServerDefinition[] {
  const byName = new Map<string, McpServerDefinition>()
  for (const d of globalDefs) byName.set(d.name, d)
  for (const d of projectDefs) byName.set(d.name, d)
  return [...byName.values()]
}

/** Merge two wire arrays the same way (`project` wins by name). */
export function mergeWireMcpServers(
  globalServers: readonly McpServer[],
  projectServers: readonly McpServer[],
): McpServer[] {
  const byName = new Map<string, McpServer>()
  for (const s of globalServers) byName.set(s.name, s)
  for (const s of projectServers) byName.set(s.name, s)
  return [...byName.values()]
}

/** Result of resolving a session-level whitelist against the definition pool. */
export interface McpServerSelectionResolution {
  /** Enabled server names, in pool order. Feed to {@link filterWireByNames}. */
  readonly enabledNames: readonly string[]
  /**
   * Whitelist entries that no longer exist in the pool (server removed from
   * config after the session pinned it). Callers should surface these once —
   * a name silently going missing is confusing when the user explicitly
   * enabled it.
   */
  readonly staleNames: readonly string[]
}

/**
 * Resolve which servers a session should run with.
 *  - `selection === null` (inherit): every pool entry that is not `disabled`.
 *  - `selection` whitelist: exactly those names, intersected with the pool;
 *    a whitelisted `disabled` server IS enabled (that is the on-demand path —
 *    globally off by default, explicitly on for this session).
 */
export function resolveMcpServerSelection(
  pool: readonly McpServerDefinition[],
  selection: readonly string[] | null,
): McpServerSelectionResolution {
  if (selection === null) {
    return { enabledNames: pool.filter((d) => !d.disabled).map((d) => d.name), staleNames: [] }
  }
  const wanted = new Set(selection)
  const enabledNames = pool.filter((d) => wanted.has(d.name)).map((d) => d.name)
  const inPool = new Set(pool.map((d) => d.name))
  const staleNames = selection.filter((n) => !inPool.has(n))
  return { enabledNames, staleNames }
}

/** Keep only wire servers whose name is in `names`. */
export function filterWireByNames(
  servers: readonly McpServer[],
  names: ReadonlySet<string>,
): McpServer[] {
  return servers.filter((s) => names.has(s.name))
}

/** Structural set equality over string arrays (order-insensitive). */
export function sameNameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((n) => set.has(n))
}

/** Outcome of validating one raw `acp.mcpServers` entry (settings UI surface). */
export type McpServerEntryValidation =
  | { readonly valid: true; readonly transport: McpTransport }
  | { readonly valid: false; readonly reason: string }

/**
 * Validate a single raw entry the way the wire path would. Entries that fail
 * are skipped silently at session creation — the settings panel uses this to
 * surface them with the exact reason instead.
 */
export function validateMcpServerEntry(name: string, cfg: unknown): McpServerEntryValidation {
  let reason: string | undefined
  const server = buildServer(name, cfg, (m) => {
    reason = m
  })
  if (!server) return { valid: false, reason: reason ?? 'invalid entry' }
  return { valid: true, transport: mcpServerTransport(server) }
}

/**
 * Return a new `acp.mcpServers` Record with one entry added / replaced /
 * removed (`entry === undefined`). Legacy array-form input is normalized to
 * the Record form on write. Pure — the caller writes the result back through
 * `IConfigurationService.update`.
 */
export function writeMcpServerEntry(
  raw: unknown,
  name: string,
  entry: unknown | undefined,
): Record<string, unknown> {
  const record = { ...mcpServerRawToRecord(raw) }
  if (entry === undefined) delete record[name]
  else record[name] = entry
  return record
}

/**
 * Parse a Claude SDK tool name of the form `mcp__<server>__<tool>` into its
 * parts. Returns `undefined` for non-MCP tools or malformed names so callers
 * degrade safely (no attribution badge). The server segment itself never
 * contains `__`; the tool segment may, so we only split on the first two.
 */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const rest = toolName.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return undefined
  const server = rest.slice(0, sep)
  const tool = rest.slice(sep + 2)
  if (!server || !tool) return undefined
  return { server, tool }
}

/**
 * Drop servers whose transport the agent does not advertise. stdio is the
 * baseline transport and is always kept; only http/sse are gated by
 * `agentCapabilities.mcpCapabilities`.
 */
export function filterMcpServersByCapabilities(
  servers: readonly McpServer[],
  caps: McpCapabilities | undefined,
): { kept: McpServer[]; dropped: Array<{ name: string; transport: 'http' | 'sse' }> } {
  const kept: McpServer[] = []
  const dropped: Array<{ name: string; transport: 'http' | 'sse' }> = []
  for (const s of servers) {
    const transport = 'type' in s ? s.type : undefined
    if (transport === 'http' || transport === 'sse') {
      if (caps?.[transport] === true) kept.push(s)
      else dropped.push({ name: s.name, transport })
    } else {
      kept.push(s)
    }
  }
  return { kept, dropped }
}
