/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  deriveToolCallDisplay — normalizes a tool call into a user-facing title plus
 *  an optional secondary detail line.
 *
 *  The agent forks map most tools to a friendly title already (`Edit foo.ts`,
 *  `Fetch <url>`, a Task's description, …). The exception is command-style
 *  tools whose title *is* the raw command line (`execute`) or a raw argument
 *  fragment (`search`). For those we promote the human-readable intent to the
 *  title and demote the raw command to a subtitle rendered as a muted code line.
 *
 *  Pure function over {@link AcpToolCall} so it can be unit-tested without React.
 *--------------------------------------------------------------------------------------------*/

import type { AcpToolCall } from '../../services/acp/acpSessionService.js'

export interface ToolCallDisplay {
  /** Human-readable title shown as the card header. */
  readonly title: string
  /** Optional raw detail (command line / argument) demoted below the title. */
  readonly subtitle?: string
}

function readStringField(raw: unknown, key: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = (raw as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * `execute` tools (Bash / codex command) title-ify to the raw command line in
 * the fork. Prefer the agent-provided `description` as the title and keep the
 * command as a subtitle; fall back to the command as the title when no
 * description exists (e.g. codex), avoiding a redundant subtitle.
 */
function deriveExecuteDisplay(call: AcpToolCall): ToolCallDisplay {
  const description = readStringField(call.rawInput, 'description')
  const command = readStringField(call.rawInput, 'command')
  if (description) {
    return command ? { title: description, subtitle: command } : { title: description }
  }
  return { title: call.title }
}

/**
 * `search` tools (Grep) title-ify to a shell-like fragment. Surface the pattern
 * as a friendly title and keep the fork's full fragment as a subtitle.
 */
function deriveSearchDisplay(call: AcpToolCall): ToolCallDisplay {
  const pattern = readStringField(call.rawInput, 'pattern')
  if (pattern && pattern !== call.title) {
    return { title: `搜索 “${pattern}”`, subtitle: call.title }
  }
  return { title: call.title }
}

/**
 * Humanize an MCP tool segment (`mcp__<server>__<tool>`'s `<tool>`) into a
 * friendly Title Case label: `ue_create_session` → `Create Session`,
 * `read_object` → `Read Object`. Server attribution is shown separately as a
 * badge, so it is not repeated here.
 *
 * The leading `ue_`-style vendor prefix (a short lowercase token followed by an
 * underscore) is dropped as noise; we keep it if stripping would empty the
 * label.
 */
export function humanizeMcpTool(tool: string): string {
  const withoutPrefix = tool.replace(/^[a-z]{1,3}_(?=[a-z])/, '')
  const base = withoutPrefix.length > 0 ? withoutPrefix : tool
  const words = base
    .split(/[_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.length > 0 ? words.join(' ') : tool
}

/**
 * MCP tools arrive with the raw tool name as their title (e.g.
 * `mcp_universe-editor_ue_create_session`). Humanize the parsed `mcpTool`
 * segment into a friendly Title Case title; the server is surfaced as a badge.
 */
function deriveMcpDisplay(call: AcpToolCall): ToolCallDisplay {
  if (call.mcpTool && call.mcpTool.length > 0) {
    return { title: humanizeMcpTool(call.mcpTool) }
  }
  return { title: call.title }
}

/**
 * Detect and pretty-print a JSON payload so the UI can syntax-highlight it.
 * Only trigger on text that clearly *is* a JSON object/array (starts with `{`
 * or `[` and parses cleanly) so plain-text / markdown output stays on its
 * original rendering path.
 */
export function tryPrettyJson(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const first = trimmed[0]
  if (first !== '{' && first !== '[') return undefined
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return undefined
  }
}

export function deriveToolCallDisplay(call: AcpToolCall): ToolCallDisplay {
  if (call.mcpServer !== undefined) return deriveMcpDisplay(call)
  switch (call.kind) {
    case 'execute':
      return deriveExecuteDisplay(call)
    case 'search':
      return deriveSearchDisplay(call)
    default:
      return { title: call.title }
  }
}
