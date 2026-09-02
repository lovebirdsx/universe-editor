/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inbound size caps applied before agent-reported payloads land in the
 *  AcpSession view model. A restored or long-running session can stream
 *  arbitrarily large tool output (terminal deltas, command stdout forwarded
 *  as text blocks, raw tool inputs) and keep it all resident — these pure
 *  functions bound what the renderer retains. Resident-cost estimates are in
 *  UTF-16 bytes (`string.length` code units × 2), the true cost of a JS string's
 *  backing store. Markers are plain ASCII: they are embedded in content, never
 *  localized.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import { readTerminalOutput } from './acpSessionUpdateMeta.js'

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

/**
 * Multiplier applied to the retained-content estimate to approximate what the
 * update really costs the V8 heap. The wire estimate only sums the strings that
 * arrived; each one is then retained several times over — the view-model card
 * object, the derived `text` copy, the parsed markdown AST, the rendered React
 * element tree and the virtual list's measurement cache all hold onto slices of
 * it. Budgets that counted only the wire bytes therefore under-charged by
 * roughly this factor, which is how a renderer with "256MB per session" ended up
 * with 3.4GiB resident in lo_space.
 *
 * Derived from that crash rather than from a microbenchmark: it is a deliberate
 * over-estimate, because over-charging trims a few cards early while
 * under-charging loses the window. Transient bytes are NOT multiplied — nothing
 * downstream ever copies them.
 */
export const VIEW_MODEL_OVERHEAD_FACTOR = 3

/** Charge wire bytes at their real view-model cost. See {@link VIEW_MODEL_OVERHEAD_FACTOR}. */
export function withViewModelOverhead(wireBytes: number): number {
  return wireBytes * VIEW_MODEL_OVERHEAD_FACTOR
}

/**
 * All budgets below are in **overhead-adjusted** bytes (wire bytes ×
 * {@link VIEW_MODEL_OVERHEAD_FACTOR}), so 256MB here allows roughly 85MB of
 * wire content per session.
 */
export const REPLAY_INGESTION_BUDGET = 256 * 1024 * 1024

/**
 * Live-run resident budget (non-replay). A running turn has no replay gate, so
 * a single long Grep/Read session can accumulate hundreds of tool cards each
 * retaining up to 1MB of terminal output — enough to OOM the renderer. Once the
 * live view model's retained content passes this, the oldest heavy tool-call /
 * message content is trimmed in place (see `AcpSession._trimLiveResidentContent`).
 */
export const LIVE_INGESTION_BUDGET = 256 * 1024 * 1024

/** UTF-16 byte size of a string: `length` counts code units, each 2 bytes. */
function utf16Bytes(s: string): number {
  return s.length * 2
}

/** Resident bytes of one content block (text / media data) in UTF-16. */
function contentBlockBytes(block: ContentBlock): number {
  if (block.type === 'text') return utf16Bytes(block.text)
  if (block.type === 'image' || block.type === 'audio') return utf16Bytes(block.data)
  return 0
}

/** Resident bytes of a raw tool input kept for UI inspection: the JSON form is
 * what `capRawInput` measures, and an oversized / unstringifiable input is
 * dropped outright downstream, so it costs 0 here too. */
export function estimateRawInputBytes(rawInput: unknown): number {
  if (rawInput === undefined) return 0
  try {
    const json = JSON.stringify(rawInput)
    if (json === undefined || json.length > RAW_INPUT_CAP) return 0
    return utf16Bytes(json)
  } catch {
    return 0
  }
}

/**
 * Transient bytes of a payload the view model never retains. codex ships a
 * command's whole output twice — once as `_meta.terminal_output*` (which the
 * card keeps) and again as `rawOutput.formatted_output` (which nothing reads).
 * The second copy still has to be decoded and held until GC, so charging it
 * keeps the replay gate honest about what a burst actually costs to ingest;
 * without it a build-heavy session is undercounted by roughly half.
 */
function transientJsonBytes(value: unknown): number {
  if (value === undefined || value === null) return 0
  try {
    const json = JSON.stringify(value)
    return json === undefined ? 0 : utf16Bytes(json)
  } catch {
    return 0
  }
}

/**
 * What one SessionUpdate costs, split by whether the view model keeps it.
 * The two halves answer different questions and must not be summed blindly —
 * see {@link estimateUpdateCost}.
 */
export interface UpdateCostBytes {
  /**
   * Wire bytes the card retains: exactly what `trimToolCall` / `trimMessage`
   * later release, so the per-session resident tally can only ever charge this
   * half. Charging anything else would leave phantom bytes no trim can work
   * off — the loop would strip every card and still report over budget, and the
   * shared budget would go take the difference out of other sessions.
   */
  readonly retained: number
  /**
   * Wire bytes decoded on arrival and dropped (`rawOutput`, `locations`): real
   * during the burst, gone by the next GC. Counted by the replay gate — which
   * bounds a peak — and by nothing else.
   */
  readonly transient: number
}

/**
 * Rough cost of one SessionUpdate in UTF-16 bytes. `retained` sums the strings
 * that land on the card and stay there — chunk text / media data / tool content
 * blocks / diff sides / out-of-band terminal output / raw tool input — plus the
 * derived `text` copy (`blocksToText`) that duplicates text blocks on the card.
 * `transient` sums the payloads that are decoded but never kept. Metadata-only
 * updates (usage / plan / commands / config) cost 0 on both counts.
 */
export function estimateUpdateCost(update: SessionUpdate): UpdateCostBytes {
  let retained = 0
  let transient = 0
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      retained += contentBlockBytes(update.content)
      if (update.content.type === 'text') retained += utf16Bytes(update.content.text)
      break
    case 'tool_call':
    case 'tool_call_update': {
      let blockTextBytes = 0
      if (update.content != null) {
        for (const item of update.content) {
          if (item.type === 'content') {
            retained += contentBlockBytes(item.content)
            if (item.content.type === 'text') blockTextBytes += utf16Bytes(item.content.text)
          } else if (item.type === 'diff') {
            retained += utf16Bytes(item.oldText ?? '') + utf16Bytes(item.newText)
          }
        }
      }
      // The card's `text` copy: the terminal accumulator when present (it shares
      // the `_terminalOutput` map entry), else the joined text blocks.
      const terminal = readTerminalOutput(update)
      retained += terminal !== undefined ? utf16Bytes(terminal.data) : blockTextBytes
      retained += estimateRawInputBytes(update.rawInput)
      // `locations` survives a trim (the card's affordances read it) but is a
      // handful of paths — measuring it on the release side would cost more than
      // it can ever release, so it rides with the transient half.
      transient += transientJsonBytes(update.rawOutput) + transientJsonBytes(update.locations)
      break
    }
    default:
      break
  }
  return { retained, transient }
}
