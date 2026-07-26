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

/**
 * Merge extra env vars into the named stdio servers, returning a new array.
 * Used for one-shot, in-memory-only injections (e.g. a deep link pinning the
 * target editor pid for the session it creates) that must NOT be persisted
 * into `acp.mcpServers`. Servers that are missing or non-stdio are reported
 * and left untouched.
 */
export function withMcpServerEnv(
  servers: readonly McpServer[],
  envByServer: Readonly<Record<string, Record<string, string>>>,
  onWarn?: WarnFn,
): McpServer[] {
  const result = servers.slice()
  for (const [name, extraEnv] of Object.entries(envByServer)) {
    const entries = Object.entries(extraEnv)
    if (entries.length === 0) continue
    const index = result.findIndex((s) => s.name === name)
    const server = index >= 0 ? result[index] : undefined
    if (!server) {
      onWarn?.(`mcp server "${name}": not configured, env injection skipped`)
      continue
    }
    if ('type' in server) {
      onWarn?.(`mcp server "${name}": not a stdio server, env injection skipped`)
      continue
    }
    const merged = new Map(server.env.map((e) => [e.name, e.value]))
    for (const [key, value] of entries) merged.set(key, value)
    result[index] = {
      ...server,
      env: [...merged.entries()].map(([envName, value]) => ({ name: envName, value })),
    }
  }
  return result
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

/** Where an MCP server definition came from. `project` rows override `global` ones with the same name. */
export type McpServerSource = 'global' | 'project'

/**
 * One settings layer contributing to `acp.mcpServers`, lowest priority first.
 * `source` is the pool attribution a server gets when THIS layer wins its name.
 */
export interface McpServerRawLayer {
  readonly source: McpServerSource
  readonly raw: unknown
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
 * (transport / disabled are also read from the winning entry). An invalid
 * winning entry drops the name entirely — a broken workspace override must not
 * silently fall back to the global definition it shadows.
 */
export function readMcpServerDefinitionsLayered(
  layers: readonly McpServerRawLayer[],
  onWarn?: WarnFn,
): McpServerDefinition[] {
  const sourceByName = new Map<string, McpServerSource>()
  for (const layer of layers) {
    for (const name of Object.keys(mcpServerRawToRecord(layer.raw)))
      sourceByName.set(name, layer.source)
  }
  const defs = readMcpServerDefinitions(mergeMcpServerRawLayers(layers), 'global', onWarn)
  return defs.map((d) => ({ ...d, source: sourceByName.get(d.name) ?? d.source }))
}

/**
 * One entry of the MCP definition pool shown in the session picker. `disabled`
 * is the global default switch (`acp.mcpServers` entry flag): a disabled server
 * is not forwarded on session/new unless a session-level whitelist explicitly
 * re-enables it.
 */
export interface McpServerDefinition {
  readonly name: string
  readonly transport: McpTransport
  readonly disabled: boolean
  readonly source: McpServerSource
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
): McpServerDefinition[] {
  const out: McpServerDefinition[] = []
  const seen = new Set<string>()
  const push = (name: string, cfg: unknown): void => {
    const server = buildServer(name, cfg, onWarn)
    if (!server || seen.has(server.name)) return
    seen.add(server.name)
    const disabled =
      cfg != null && typeof cfg === 'object' && (cfg as Record<string, unknown>).disabled === true
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
