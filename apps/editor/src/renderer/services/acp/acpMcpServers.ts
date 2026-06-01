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
function toPairs(input: unknown): Array<{ name: string; value: string }> {
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
    const headers: HttpHeader[] = toPairs(o.headers)
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
    const env: EnvVariable[] = toPairs(o.env)
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
