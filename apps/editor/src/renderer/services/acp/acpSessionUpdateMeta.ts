/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionUpdate `_meta` parsing for AcpSession — pure readers that pull the
 *  vendor-specific extras our agent forks stamp onto the wire (sub-agent
 *  attribution, MCP attribution, out-of-band terminal output, per-model cost
 *  breakdown, and Edit/Write file-change descriptors). Kept apart from the
 *  session class so the brittle `as`-cast shape probing lives in one auditable
 *  place; re-exported from acpSession.ts where still referenced.
 *--------------------------------------------------------------------------------------------*/

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { parseMcpToolName } from './acpMcpServers.js'
import type { DiffHunk } from './diff/reconstructBaseline.js'
import type { AcpModelCost, AcpSubagentStats } from './acpSessionModel.js'

/**
 * Read the per-model cost breakdown our agent fork stamps onto `usage_update`
 * via `_meta._universe/modelBreakdown`. Values are session-cumulative and
 * already fold in sub-agent (Task) work. Returns [] when absent or malformed.
 */
export function extractModelBreakdown(update: {
  _meta?: Record<string, unknown> | null | undefined
}): readonly AcpModelCost[] {
  const raw = update._meta?.['_universe/modelBreakdown']
  if (!Array.isArray(raw)) return []
  const out: AcpModelCost[] = []
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r['model'] !== 'string') continue
    out.push({
      model: r['model'],
      inputTokens: numberOr(r['inputTokens']),
      outputTokens: numberOr(r['outputTokens']),
      cacheReadTokens: numberOr(r['cacheReadTokens']),
      cacheCreateTokens: numberOr(r['cacheCreateTokens']),
      costUSD: numberOr(r['costUSD']),
    })
  }
  return out
}

function numberOr(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Read the per-sub-agent token/model tally our claude fork stamps onto a Task
 * card's `tool_call_update` via `_meta._universe/subagentStats`. Values are the
 * running total for that one sub-agent (all its assistant messages folded). The
 * fork never reports a per-sub-agent cost, so `costUSD` is estimated downstream.
 * Returns undefined when absent or malformed.
 */
export function readSubagentStats(update: {
  _meta?: Record<string, unknown> | null | undefined
}): AcpSubagentStats | undefined {
  const raw = update._meta?.['_universe/subagentStats']
  if (raw == null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const stats: AcpSubagentStats = {
    inputTokens: numberOr(r['inputTokens']),
    outputTokens: numberOr(r['outputTokens']),
    cacheReadTokens: numberOr(r['cacheReadTokens']),
    cacheCreateTokens: numberOr(r['cacheCreateTokens']),
    ...(typeof r['model'] === 'string' && r['model'].length > 0 ? { model: r['model'] } : {}),
    ...(typeof r['subagentType'] === 'string' && r['subagentType'].length > 0
      ? { subagentType: r['subagentType'] }
      : {}),
  }
  return stats
}

/**
 * Read the vendor-specific sub-agent attribution our agent fork stamps onto each
 * SessionUpdate (`_meta.claudeCode.parentToolUseId`). Returns the id of the
 * parent tool call when this update belongs to a sub-agent, else undefined.
 */
export function readParentToolUseId(update: SessionUpdate): string | undefined {
  const meta = (update as { _meta?: { claudeCode?: { parentToolUseId?: unknown } } | null })._meta
  const pid = meta?.claudeCode?.parentToolUseId
  return typeof pid === 'string' && pid.length > 0 ? pid : undefined
}

/**
 * Read the client-generated messageId our agent fork stamps back onto message
 * chunks (`agent_message_chunk` / `user_message_chunk` / `agent_thought_chunk`)
 * during live streaming and history replay. Anchors a rendered message to a
 * rewind/fork target. Returns undefined when absent (e.g. codex, or turns that
 * predate the anchor).
 */
export function readMessageId(update: SessionUpdate): string | undefined {
  const id = (update as { messageId?: unknown }).messageId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Read the config ids our claude fork declares as actually changed on a
 * `config_option_update` (`_meta['universe-editor/changedConfigIds']`). The
 * resume-time model reconciliation broadcasts the whole bag after correcting
 * only the model — the other entries are still the recreated session's seeds,
 * and applying them verbatim would override the user's restored values.
 * Returns undefined when absent, meaning the full bag is authoritative.
 */
export function readChangedConfigIds(update: {
  _meta?: Record<string, unknown> | null | undefined
}): readonly string[] | undefined {
  const raw = update._meta?.['universe-editor/changedConfigIds']
  if (!Array.isArray(raw)) return undefined
  return raw.filter((v): v is string => typeof v === 'string')
}

function readMcpToolName(update: SessionUpdate): { server: string; tool: string } | undefined {
  const meta = (update as { _meta?: { claudeCode?: { toolName?: unknown } } | null })._meta
  const toolName = meta?.claudeCode?.toolName
  if (typeof toolName !== 'string' || toolName.length === 0) return undefined
  return parseMcpToolName(toolName)
}

/**
 * Resolve the source MCP server for a tool_call(_update) from the agent fork's
 * `_meta.claudeCode.toolName` (`mcp__<server>__<tool>`). Returns undefined for
 * built-in tools or malformed names.
 */
export function readMcpServer(update: SessionUpdate): string | undefined {
  return readMcpToolName(update)?.server
}

/**
 * Resolve the MCP tool segment (the `<tool>` in `mcp__<server>__<tool>`) so the
 * UI can humanize it into a friendly card title. Returns undefined for built-in
 * tools or malformed names.
 */
export function readMcpTool(update: SessionUpdate): string | undefined {
  return readMcpToolName(update)?.tool
}

/**
 * Read the codex-acp fork's out-of-band terminal output from a tool_call(_update).
 * The fork streams command output via `_meta.terminal_output_delta` (append-only
 * chunks) or `_meta.terminal_output` (a full snapshot), rather than as `content`
 * blocks. Returns the chunk plus whether it appends to or replaces the accumulator,
 * or undefined when this update carries no terminal output.
 */
export function readTerminalOutput(
  update: SessionUpdate,
): { readonly data: string; readonly mode: 'append' | 'replace' } | undefined {
  const meta = (
    update as {
      _meta?: {
        terminal_output_delta?: { data?: unknown } | null
        terminal_output?: { data?: unknown } | null
      } | null
    }
  )._meta
  if (!meta) return undefined
  const delta = meta.terminal_output_delta?.data
  if (typeof delta === 'string') return { data: delta, mode: 'append' }
  const full = meta.terminal_output?.data
  if (typeof full === 'string') return { data: full, mode: 'replace' }
  return undefined
}

/**
 * Extract a whole-file change descriptor from the agent fork's PostToolUse hook
 * payload: `_meta.claudeCode.toolResponse.{filePath, structuredPatch, type,
 * originalFile}`, present only for `Edit`/`Write` tools. Returns undefined for
 * any other tool / shape.
 *
 * `isCreate` is derived from the authoritative SDK signals (`type: 'create'` or
 * `originalFile: null`); when set we keep the descriptor even with zero hunks,
 * because an empty-content Write reports an empty `structuredPatch` yet still
 * created a file the tracker must surface.
 */
export interface FileChangeDescriptor {
  readonly path: string
  readonly hunks: readonly DiffHunk[]
  readonly isCreate: boolean
}

export function readFileChanges(update: SessionUpdate): readonly FileChangeDescriptor[] {
  const structured = readStructuredPatch(update)
  if (structured) return [structured]
  return readDiffContentChanges(update)
}

function readStructuredPatch(update: SessionUpdate): FileChangeDescriptor | undefined {
  const meta = (
    update as {
      _meta?: {
        claudeCode?: {
          toolName?: unknown
          toolResponse?: {
            filePath?: unknown
            structuredPatch?: unknown
            type?: unknown
            originalFile?: unknown
          }
        }
      } | null
    }
  )._meta
  const cc = meta?.claudeCode
  if (cc?.toolName !== 'Edit' && cc?.toolName !== 'Write') return undefined
  const resp = cc?.toolResponse
  const path = resp?.filePath
  const patch = resp?.structuredPatch
  if (typeof path !== 'string' || path.length === 0 || !Array.isArray(patch)) return undefined
  const isCreate = resp?.type === 'create' || resp?.originalFile === null
  const hunks: DiffHunk[] = []
  for (const h of patch) {
    if (
      h &&
      typeof h.newStart === 'number' &&
      typeof h.newLines === 'number' &&
      typeof h.oldStart === 'number' &&
      typeof h.oldLines === 'number' &&
      Array.isArray(h.lines)
    ) {
      hunks.push({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines.filter((l: unknown): l is string => typeof l === 'string'),
      })
    }
  }
  if (hunks.length === 0 && !isCreate) return undefined
  return { path, hunks, isCreate }
}

function readDiffContentChanges(update: SessionUpdate): readonly FileChangeDescriptor[] {
  const content = (update as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  const changes: FileChangeDescriptor[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const diff = item as { type?: unknown; path?: unknown; oldText?: unknown; newText?: unknown }
    if (diff.type !== 'diff') continue
    if (typeof diff.path !== 'string' || diff.path.length === 0) continue
    if (typeof diff.newText !== 'string') continue
    const isCreate = diff.oldText == null
    const oldText = typeof diff.oldText === 'string' ? diff.oldText : ''
    const hunks = wholeFileDiffHunks(oldText, diff.newText, isCreate)
    if (hunks.length === 0 && !isCreate) continue
    changes.push({ path: diff.path, hunks, isCreate })
  }
  return changes
}

function wholeFileDiffHunks(
  oldText: string,
  newText: string,
  isCreate: boolean,
): readonly DiffHunk[] {
  if (oldText === newText) return []
  const oldLines = isCreate ? [] : diffLines(oldText)
  const newLines = newText.length === 0 && isCreate ? [] : diffLines(newText)
  return [
    {
      oldStart: 1,
      oldLines: oldLines.length,
      newStart: 1,
      newLines: newLines.length,
      lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
    },
  ]
}

function diffLines(text: string): readonly string[] {
  return text.length === 0 ? [''] : text.split('\n')
}
