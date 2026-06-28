/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Content-block helpers for AcpSession — pure functions that turn ACP
 *  ContentBlock[] / ToolCallContent[] into the plain-text and structured shapes
 *  the view model and clipboard need. Split out of acpSession.ts; re-exported
 *  there so existing import paths keep working.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk'
import type { AcpToolCall, AcpToolCallDiff, AcpChildItem, TimelineItem } from './acpSessionModel.js'

/** A text block whose content is empty or only whitespace carries nothing. */
export function isBlankContentBlock(block: ContentBlock): boolean {
  return block.type === 'text' && block.text.trim().length === 0
}

/** True when at least one block would render visible content. */
export function hasVisibleMessageContent(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((b) => (b.type === 'text' ? b.text.trim().length > 0 : true))
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
    const label = d.oldText.length === 0 ? `[new file: ${d.path}]` : `[diff: ${d.path}]`
    parts.push(`${label}\n${d.newText}`)
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
  return item.kind === 'message' ? item.message.text : toolCallToText(item.call)
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
        blocks.push(item.content)
        break
      case 'diff':
        diffs.push({
          path: item.path,
          oldText: item.oldText ?? '',
          newText: item.newText,
        })
        break
      case 'terminal':
        break
    }
  }
  return { blocks, diffs }
}

/**
 * Merge an incoming streaming chunk into the existing blocks list. Consecutive
 * `text` blocks collapse into a single block so the markdown parser can see a
 * coherent document; non-text blocks (image / resource / resource_link / audio)
 * are appended as-is.
 */
export function mergeStreamingBlock(
  blocks: readonly ContentBlock[],
  chunk: ContentBlock,
): readonly ContentBlock[] {
  if (chunk.type === 'text') {
    const last = blocks[blocks.length - 1]
    if (last && last.type === 'text') {
      return [...blocks.slice(0, -1), { type: 'text', text: last.text + chunk.text }]
    }
  }
  return [...blocks, chunk]
}
