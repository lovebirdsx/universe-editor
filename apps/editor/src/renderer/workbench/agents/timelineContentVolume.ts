/*---------------------------------------------------------------------------------------------
 *  Cheap render-volume estimate for the chat timeline. The item-count threshold alone
 *  misses sessions with few timeline slots but huge bodies (one tool card with large
 *  output, a handful of long markdown messages): they stay on the plain <ol> and block
 *  the first frame when the whole tree remounts on a tab switch.
 *
 *  Everything here reads already-materialized model fields (`text`, `blocks`, `diffs`)
 *  — never the DOM and never the markdown text itself — so the estimate can run on
 *  every timeline publish. Stable slot objects are memoized in a WeakMap, which makes
 *  a streaming update cost only the changed tail.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { AcpChildItem, TimelineItem } from '../../services/acp/session/acpSessionModel.js'

/**
 * Character-equivalent budget above which the chat virtualizes even below the item
 * threshold. 40K chars is roughly 600–800 wrapped lines / 30–40 screens: short
 * conversations stay on the plain DOM (native find/selection over everything, no
 * measurement churn), while the incident that motivated this — ~106K chars across
 * 86 markdown views — is comfortably over the line.
 */
export const CHAT_VIRTUALIZATION_CONTENT_BUDGET = 40_000

/**
 * Mounting a markdown text block costs a parse plus its own React subtree, which is
 * not proportional to its length. Charge each one like ~500 chars so "many small
 * markdown views" also counts: ~40 one-block messages of 200 chars stay around
 * 28K, i.e. still under the budget, while 80+ blocks tip over on their own.
 */
const MARKDOWN_BLOCK_COST_CHARS = 500

export interface TimelineContentVolume {
  readonly chars: number
  readonly markdownBlocks: number
  /** `chars + markdownBlocks * MARKDOWN_BLOCK_COST_CHARS` — compare with the budget. */
  readonly volume: number
}

export type ChatVirtualizationReason = 'find' | 'items' | 'content' | 'none'

interface SlotVolume {
  readonly chars: number
  readonly markdownBlocks: number
}

const EMPTY_SLOT: SlotVolume = { chars: 0, markdownBlocks: 0 }

// Slots are immutable and only the changed one gets a new object identity, so a
// timeline publish recomputes just that tail slot instead of every body.
const slotVolumeCache = new WeakMap<TimelineItem | AcpChildItem, SlotVolume>()

function countMarkdownBlocks(blocks: readonly ContentBlock[]): number {
  let count = 0
  for (const block of blocks) {
    if (block.type === 'text' && block.text.length > 0) count++
  }
  return count
}

function slotVolume(item: TimelineItem | AcpChildItem): SlotVolume {
  const cached = slotVolumeCache.get(item)
  if (cached !== undefined) return cached
  const computed = computeSlotVolume(item)
  slotVolumeCache.set(item, computed)
  return computed
}

function computeSlotVolume(item: TimelineItem | AcpChildItem): SlotVolume {
  switch (item.kind) {
    case 'message':
      return {
        chars: item.message.text.length,
        markdownBlocks: countMarkdownBlocks(item.message.blocks),
      }
    case 'toolCall': {
      const call = item.call
      let chars = call.text.length
      let markdownBlocks = countMarkdownBlocks(call.blocks)
      for (const diff of call.diffs) {
        chars += diff.oldText.length + diff.newText.length
      }
      for (const child of call.children ?? []) {
        const childVolume = slotVolume(child)
        chars += childVolume.chars
        markdownBlocks += childVolume.markdownBlocks
      }
      return { chars, markdownBlocks }
    }
    case 'compaction':
    case 'resurrection':
      return EMPTY_SLOT
  }
}

/** Render volume of the rows that will actually mount (`displayTimeline`). */
export function estimateTimelineContentVolume(
  items: readonly TimelineItem[],
): TimelineContentVolume {
  let chars = 0
  let markdownBlocks = 0
  for (const item of items) {
    const contribution = slotVolume(item)
    chars += contribution.chars
    markdownBlocks += contribution.markdownBlocks
  }
  return {
    chars,
    markdownBlocks,
    volume: chars + markdownBlocks * MARKDOWN_BLOCK_COST_CHARS,
  }
}

/**
 * Virtualization decision for one render. Find always wins (the whole session must be
 * in the DOM for the TreeWalker); otherwise the item threshold is reported ahead of
 * the content budget purely so the debug log names the reason that was checked first.
 */
export function resolveTimelineVirtualization(input: {
  readonly itemCount: number
  readonly itemThreshold: number
  readonly contentHeavy: boolean
  readonly findOpen: boolean
}): { readonly virtualize: boolean; readonly reason: ChatVirtualizationReason } {
  if (input.findOpen) return { virtualize: false, reason: 'find' }
  if (input.itemCount > input.itemThreshold) return { virtualize: true, reason: 'items' }
  if (input.contentHeavy) return { virtualize: true, reason: 'content' }
  return { virtualize: false, reason: 'none' }
}
