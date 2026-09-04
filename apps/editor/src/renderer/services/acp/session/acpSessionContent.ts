/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Content-block helpers for AcpSession — pure functions that turn ACP
 *  ContentBlock[] / ToolCallContent[] into the plain-text and structured shapes
 *  the view model and clipboard need. Split out of acpSession.ts; re-exported
 *  there so existing import paths keep working.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock, ToolCallContent, ToolCallLocation } from '@agentclientprotocol/sdk'
import {
  MESSAGE_TEXT_REBUILD_AT,
  capContentBlock,
  capMessageBlocksTail,
  truncateDiffSideText,
} from './acpContentLimits.js'
import type {
  AcpToolCall,
  AcpToolCallDiff,
  AcpToolCallLocation,
  AcpChildItem,
  TimelineItem,
} from './acpSessionModel.js'

/** A text block whose content is empty or only whitespace carries nothing. */
export function isBlankContentBlock(block: ContentBlock): boolean {
  return block.type === 'text' && block.text.trim().length === 0
}

/** True when at least one block would render visible content. */
export function hasVisibleMessageContent(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((b) => (b.type === 'text' ? b.text.trim().length > 0 : true))
}

/** First non-empty line of a message, trimmed and clamped, for the collapsed
 *  single-line summary. Matches the sticky-scroll overlay's header clamp. */
export function firstLineSummary(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  const MAX = 120
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX)}…` : firstLine
}

export function blocksToText(blocks: readonly ContentBlock[] | undefined): string {
  if (!blocks) return ''
  return blocks
    .map((b) =>
      b.type === 'text'
        ? b.text
        : b.type === 'resource'
          ? `[resource: ${b.resource.uri}]`
          : b.type === 'resource_link'
            ? `[resource: ${b.name ?? b.uri}]`
            : b.type === 'audio'
              ? `[audio: ${b.mimeType}]`
              : `[image: ${b.mimeType}]`,
    )
    .join('')
}

/**
 * Serialize a tool call into copyable plain text — title, diffs, output, and any
 * nested sub-agent items — so the right-click "Copy Message" works on tool-call
 * cards, not just plain messages (mirrors VSCode's chat tool-invocation repr).
 */
export function toolCallToText(call: AcpToolCall): string {
  const parts: string[] = []
  parts.push(call.mcpServer !== undefined ? `${call.title} (MCP · ${call.mcpServer})` : call.title)

  for (const d of call.diffs) {
    // A trimmed card keeps its diff paths but not the two sides, so the
    // "new file vs edit" distinction (which reads `oldText`) is no longer
    // knowable — label it neutrally instead of claiming every file is new.
    const label = call.memoryTrimmed
      ? `[file: ${d.path}]`
      : d.oldText.length === 0
        ? `[new file: ${d.path}]`
        : `[diff: ${d.path}]`
    parts.push(call.memoryTrimmed ? label : `${label}\n${d.newText}`)
  }

  const body = call.kind === 'execute' ? call.text : blocksToText(call.blocks)
  if (body.trim().length > 0) parts.push(body)

  for (const child of call.children ?? []) {
    const childText = timelineItemToText(child)
    if (childText.trim().length > 0) {
      parts.push(
        childText
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
      )
    }
  }

  return parts.join('\n\n')
}

/** Plain-text representation of any timeline slot, suitable for clipboard copy. */
export function timelineItemToText(item: TimelineItem | AcpChildItem): string {
  switch (item.kind) {
    case 'message':
      return item.message.text
    case 'toolCall':
      return toolCallToText(item.call)
    case 'compaction':
      return item.compaction.reason
        ? `Compaction ${item.compaction.phase}: ${item.compaction.reason}`
        : `Compaction ${item.compaction.phase}`
    case 'resurrection':
      return item.resurrection.reason
        ? `Session resurrection ${item.resurrection.phase}: ${item.resurrection.reason}`
        : `Session resurrection ${item.resurrection.phase}`
  }
}

/**
 * Split the SDK's ToolCallContent[] (a discriminated union of content / diff /
 * terminal wrappers) into a flat ContentBlock[] plus structured diff entries.
 * - `content` items are unwrapped into the block list.
 * - `diff` items are pulled out into `diffs` (so the UI can render a dedicated
 *   diff preview); they no longer leak into `blocks` as `[diff: path]`.
 * - `terminal` items are dropped here: the codex-acp fork only sends them as a
 *   placeholder, streaming the real output out-of-band via `_meta.terminal_output*`
 *   (folded into the execute card's `text`; see `_accumulateTerminalOutput`).
 */
export function splitToolCallContent(content: readonly ToolCallContent[]): {
  readonly blocks: readonly ContentBlock[]
  readonly diffs: readonly AcpToolCallDiff[]
} {
  const blocks: ContentBlock[] = []
  const diffs: AcpToolCallDiff[] = []
  for (const item of content) {
    switch (item.type) {
      case 'content':
        blocks.push(capContentBlock(item.content))
        break
      case 'diff':
        diffs.push({
          path: item.path,
          oldText: truncateDiffSideText(item.oldText ?? ''),
          newText: truncateDiffSideText(item.newText),
        })
        break
      case 'terminal':
        break
    }
  }
  return { blocks, diffs }
}

/**
 * Normalize the SDK's `ToolCall.locations` into the view-model shape, dropping
 * entries without a usable path and coercing the nullable `line` to an optional.
 * Returns undefined when there is nothing to show, so the caller can omit the
 * field under `exactOptionalPropertyTypes`.
 */
export function readToolCallLocations(
  locations: readonly ToolCallLocation[] | null | undefined,
): readonly AcpToolCallLocation[] | undefined {
  if (locations == null) return undefined
  const out: AcpToolCallLocation[] = []
  for (const loc of locations) {
    if (typeof loc.path !== 'string' || loc.path.length === 0) continue
    out.push(loc.line != null ? { path: loc.path, line: loc.line } : { path: loc.path })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Mutable accumulation slot for a streamed message's blocks. Consecutive text
 * chunks push into an internal string array instead of `last.text + chunk.text`,
 * which V8 compiles into a cons-string rope: each 1-char chunk adds ~60-80B of
 * cons nodes the resident budget's flat 2-bytes-per-char estimate never counts,
 * so a 1MB streamed message peaked at ~75-90MB before any cap fired. The run is
 * joined (a flat SeqString) only when it trips the {@link MESSAGE_TEXT_REBUILD_AT}
 * hysteresis gate — the flattening cadence is unchanged, everything in between
 * costs O(1) per chunk. Non-text chunks close the open run into a flat block and
 * append as-is, so `flatten()` always yields ordinary
 * `{ type: 'text', text: <flat string> }` blocks.
 */
export class StreamingBlocksAccumulator {
  private _blocks: ContentBlock[] = []
  private _chunks: string[] | undefined = undefined
  private _runLength = 0

  constructor(base: readonly ContentBlock[]) {
    const tail = base[base.length - 1]
    if (tail !== undefined && tail.type === 'text') {
      this._blocks = base.slice(0, -1)
      this._chunks = [tail.text]
      this._runLength = tail.text.length
    } else {
      this._blocks = [...base]
    }
  }

  /**
   * Append one streaming chunk in place. Returns true when the append tripped
   * the rebuild threshold — the content was flattened and capped right away and
   * the caller should publish immediately, keeping the cap's publish cadence
   * identical to the pre-accumulator merge path.
   */
  push(chunk: ContentBlock): boolean {
    if (chunk.type !== 'text') {
      this._closeRun()
      this._blocks.push(capContentBlock(chunk))
      return false
    }
    if (this._chunks === undefined) {
      this._chunks = []
      this._runLength = 0
    }
    if (this._runLength > MESSAGE_TEXT_REBUILD_AT) {
      this._chunks.push(chunk.text)
      const flat = this._chunks.join('')
      const capped = capMessageBlocksTail([...this._blocks, { type: 'text', text: flat }])
      const tail = capped[capped.length - 1]
      if (tail !== undefined && tail.type === 'text') {
        this._blocks = capped.slice(0, -1)
        this._chunks = [tail.text]
        this._runLength = tail.text.length
      } else {
        this._blocks = [...capped]
        this._chunks = undefined
        this._runLength = 0
      }
      return true
    }
    this._chunks.push(chunk.text)
    this._runLength += chunk.text.length
    return false
  }

  /** Materialize the final flat blocks and their joined plain text. */
  flatten(): { readonly blocks: readonly ContentBlock[]; readonly text: string } {
    this._closeRun()
    const blocks = [...this._blocks]
    return { blocks, text: blocksToText(blocks) }
  }

  private _closeRun(): void {
    if (this._chunks === undefined) return
    this._blocks.push({ type: 'text', text: this._chunks.join('') })
    this._chunks = undefined
    this._runLength = 0
  }
}
