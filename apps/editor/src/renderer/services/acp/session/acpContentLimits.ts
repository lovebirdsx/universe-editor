/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inbound size caps applied before agent-reported payloads land in the
 *  AcpSession view model. A restored or long-running session can stream
 *  arbitrarily large tool output (terminal deltas, command stdout forwarded
 *  as text blocks, raw tool inputs) and keep it all resident — these pure
 *  functions bound what the renderer retains. Sizes are in UTF-16 code units
 *  (string.length), a cheap proxy for bytes. Markers are plain ASCII: they
 *  are embedded in content, never localized.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk'

export const TERMINAL_OUTPUT_CAP = 1024 * 1024

/**
 * Hysteresis for the terminal accumulator: let the text grow past the cap up
 * to this threshold before rebuilding, so per-chunk appends stay amortized
 * instead of re-slicing the whole string on every delta.
 */
export const TERMINAL_OUTPUT_REBUILD_AT = Math.floor(TERMINAL_OUTPUT_CAP * 1.25)

export const TERMINAL_OUTPUT_TRUNCATED_MARKER = '[... earlier output truncated ...]\n'

/**
 * Bound accumulated terminal output to the cap, keeping the tail — the newest
 * output matters most for terminal semantics — and replacing the dropped head
 * with a marker line. Returns the input untouched below the rebuild threshold.
 */
export function capTerminalOutputTail(text: string): string {
  if (text.length <= TERMINAL_OUTPUT_REBUILD_AT) return text
  return TERMINAL_OUTPUT_TRUNCATED_MARKER + text.slice(text.length - TERMINAL_OUTPUT_CAP)
}

export const TOOL_TEXT_BLOCK_CAP = 256 * 1024
export const TOOL_TEXT_BLOCK_HEAD = 192 * 1024
export const TOOL_TEXT_BLOCK_TAIL = 32 * 1024

/** Bound a single tool-call text block to head + omission note + tail. */
export function truncateToolTextBlock(text: string): string {
  if (text.length <= TOOL_TEXT_BLOCK_CAP) return text
  const omitted = text.length - TOOL_TEXT_BLOCK_HEAD - TOOL_TEXT_BLOCK_TAIL
  return `${text.slice(0, TOOL_TEXT_BLOCK_HEAD)}\n[... ${omitted} chars truncated ...]\n${text.slice(-TOOL_TEXT_BLOCK_TAIL)}`
}

/**
 * Apply {@link truncateToolTextBlock} to the text blocks of a tool call's
 * content; every other block type passes through untouched (diff entries are
 * already split out upstream by splitToolCallContent and never pass through
 * here). Returns the input array itself when no block needed capping.
 */
export function capToolCallBlocks(blocks: readonly ContentBlock[]): readonly ContentBlock[] {
  if (!blocks.some((b) => b.type === 'text' && b.text.length > TOOL_TEXT_BLOCK_CAP)) {
    return blocks
  }
  return blocks.map((b) =>
    b.type === 'text' ? { type: 'text', text: truncateToolTextBlock(b.text) } : b,
  )
}

export const RAW_INPUT_CAP = 64 * 1024

/**
 * Drop an oversized raw tool input (kept only for UI inspection). A value that
 * fails JSON.stringify (circular, BigInt, ...) counts as over the cap. A drop
 * returns undefined outright — callers must not fall back to a previously
 * stored value.
 */
export function capRawInput(rawInput: unknown): unknown {
  if (rawInput === undefined) return undefined
  try {
    const json = JSON.stringify(rawInput)
    if (json === undefined || json.length <= RAW_INPUT_CAP) return rawInput
  } catch {
    // Unstringifiable — treat as over the cap.
  }
  return undefined
}
