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

import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'

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

function needsToolCallBlockCapping(b: ContentBlock): boolean {
  if (b.type === 'text') return b.text.length > TOOL_TEXT_BLOCK_CAP
  if (b.type === 'image' || b.type === 'audio') return b.data.length > MEDIA_DATA_CAP
  return false
}

/**
 * Apply {@link truncateToolTextBlock} to the text blocks and
 * {@link capContentBlock} to the media blocks of a tool call's content;
 * every other block type passes through untouched (diff entries are already
 * split out upstream by splitToolCallContent and never pass through here).
 * Returns the input array itself when no block needed capping.
 */
export function capToolCallBlocks(blocks: readonly ContentBlock[]): readonly ContentBlock[] {
  if (!blocks.some(needsToolCallBlockCapping)) return blocks
  return blocks.map((b) => {
    if (b.type === 'text' && b.text.length > TOOL_TEXT_BLOCK_CAP) {
      return { type: 'text', text: truncateToolTextBlock(b.text) }
    }
    return capContentBlock(b)
  })
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

export const MEDIA_DATA_CAP = 2 * 1024 * 1024

export const MEDIA_TRUNCATED_META_KEY = 'universe-editor/truncated'

/**
 * Empty the base64 payload of an oversized image/audio block, keeping the
 * mimeType so the card can still render a placeholder, and stamping a `_meta`
 * marker so downstream consumers can tell the data was dropped on purpose.
 * Multi-MB base64 strings are the single largest payload in a replayed
 * session history. Every other block type passes through by reference.
 */
export function capContentBlock(block: ContentBlock): ContentBlock {
  if (block.type !== 'image' && block.type !== 'audio') return block
  if (block.data.length <= MEDIA_DATA_CAP) return block
  return {
    ...block,
    data: '',
    _meta: { ...block._meta, [MEDIA_TRUNCATED_META_KEY]: true },
  }
}

export const MESSAGE_TEXT_CAP = 1024 * 1024

/**
 * Hysteresis for the message accumulator, same rationale as
 * {@link TERMINAL_OUTPUT_REBUILD_AT}: a streamed message grows chunk by chunk
 * and must not be re-sliced on every append.
 */
export const MESSAGE_TEXT_REBUILD_AT = Math.floor(MESSAGE_TEXT_CAP * 1.25)

export const MESSAGE_TEXT_TRUNCATED_MARKER = '[... earlier message truncated ...]\n'

/**
 * Bound the searchable text a single message keeps resident to the cap,
 * keeping the tail. The blocks array is rebuilt alongside so the derived
 * `text = blocksToText(blocks)` stays consistent with the retained blocks —
 * both copies of the content shrink together. Leading non-text blocks outside
 * the retained window are dropped (they contribute no searchable text);
 * blocks inside the window survive untouched. Returns the input untouched
 * below the rebuild threshold.
 */
export function capMessageBlocksTail(blocks: readonly ContentBlock[]): readonly ContentBlock[] {
  const total = blocks.reduce((sum, b) => sum + (b.type === 'text' ? b.text.length : 0), 0)
  if (total <= MESSAGE_TEXT_REBUILD_AT) return blocks
  let budget = MESSAGE_TEXT_CAP
  const kept: ContentBlock[] = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (!block) continue
    if (block.type !== 'text') {
      if (budget > 0 && kept.length > 0) kept.unshift(block)
      continue
    }
    if (budget <= 0) continue
    if (block.text.length <= budget) {
      budget -= block.text.length
      kept.unshift(block)
    } else {
      kept.unshift({ type: 'text', text: block.text.slice(block.text.length - budget) })
      budget = 0
    }
  }
  return [{ type: 'text', text: MESSAGE_TEXT_TRUNCATED_MARKER }, ...kept]
}

export const DIFF_SIDE_CAP = 512 * 1024
export const DIFF_SIDE_HEAD = 384 * 1024
export const DIFF_SIDE_TAIL = 64 * 1024

/** Bound one side of a tool-call diff to head + omission note + tail. */
export function truncateDiffSideText(text: string): string {
  if (text.length <= DIFF_SIDE_CAP) return text
  const omitted = text.length - DIFF_SIDE_HEAD - DIFF_SIDE_TAIL
  return `${text.slice(0, DIFF_SIDE_HEAD)}\n[... ${omitted} chars truncated ...]\n${text.slice(-DIFF_SIDE_TAIL)}`
}

export const REPLAY_INGESTION_BUDGET = 256 * 1024 * 1024

/**
 * Rough resident cost of one SessionUpdate in UTF-16 code units: sums the
 * string fields that actually land in the view model (chunk text / media
 * data / tool content blocks / diff sides) without JSON-stringifying the
 * whole update. Metadata-only updates (usage / plan / commands / config)
 * cost 0.
 */
export function estimateUpdateResidentBytes(update: SessionUpdate): number {
  let total = 0
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      total += contentBlockSize(update.content)
      break
    case 'tool_call':
    case 'tool_call_update':
      if (update.content != null) {
        for (const item of update.content) {
          if (item.type === 'content') total += contentBlockSize(item.content)
          else if (item.type === 'diff') total += (item.oldText?.length ?? 0) + item.newText.length
        }
      }
      break
    default:
      break
  }
  return total
}

function contentBlockSize(block: ContentBlock): number {
  if (block.type === 'text') return block.text.length
  if (block.type === 'image' || block.type === 'audio') return block.data.length
  return 0
}
