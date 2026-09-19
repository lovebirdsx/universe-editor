/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Timeline context-menu slot resolution — the *write* side of "which card was
 *  right-clicked". Both menu hosts (ChatBody's scroll container and the sticky
 *  user-message bar) go through here, so the DOM key lookup and the card shape
 *  the menu `when` clauses read can never drift between them.
 *
 *  The read side (menu arg validation) lives in chatContextTarget.ts.
 *--------------------------------------------------------------------------------------------*/

import type { AcpChatSlot } from '../../services/acp/chatContextTarget.js'
import type { AcpChildItem, TimelineItem } from '../../services/acp/session/acpSession.js'
import { isPreviewablePath } from '../../services/resourcePreview/resourcePreviewSupport.js'
import { createdFilePath } from './toolCallDisplay.js'

/**
 * The deepest card under the pointer. `data-sticky-key` wins over
 * `data-timeline-key`: a sub-agent child carries only the former, while a
 * top-level slot carries both with the same value. The returned key may be
 * composite (`t:parent/t:child`) — every consumer resolves it through
 * `findByStickyKey`, which walks the segments.
 */
export function slotKeyFromEvent(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined
  const el = target.closest('[data-sticky-key], [data-timeline-key]')
  if (!el) return undefined
  return el.getAttribute('data-sticky-key') ?? el.getAttribute('data-timeline-key') ?? undefined
}

/**
 * Describe the card behind `slotKey` in the shape the timeline menu's `when`
 * clauses gate on. `undefined` when the key resolves to nothing — a stale key
 * (the card was trimmed out mid-stream) or the plan bar's pseudo key — and the
 * caller must then treat the click as "not on a card".
 *
 * Takes the resolved item rather than the timeline because the sticky bar only
 * holds its own message, not the whole timeline; the caller resolves the item
 * with `findByStickyKey` (ChatBody) or already has it (the bar).
 *
 * `collapsed` is passed in by the caller so both hosts read the one shared
 * override store (the widget's `isSlotCollapsed`) instead of a local fallback.
 */
export function describeAcpChatSlot(
  item: TimelineItem | AcpChildItem | undefined,
  slotKey: string,
  collapsed: boolean,
): AcpChatSlot | undefined {
  if (item === undefined) return undefined
  // A message or tool call folds; compaction / resurrection are single-line
  // status cards with no body to fold.
  const card = item.kind === 'message' || item.kind === 'toolCall'
  const message = item.kind === 'message' ? item.message : undefined
  const call = item.kind === 'toolCall' ? item.call : undefined
  const messageId =
    message !== undefined && message.role === 'user' && message.autoRetry !== true
      ? message.messageId
      : undefined
  // Only a whole-file write (Write / add file) has a read affordance of its own.
  // Same rule as the card header's inline button, reached from the path instead
  // of the resolved URI: only the basename decides, so the two agree even when a
  // remote workspace would resolve the path to another scheme.
  const createdPath = call !== undefined ? createdFilePath(call) : undefined
  return {
    slotKey,
    messageId,
    card,
    collapsed: card ? collapsed : false,
    userMessage: messageId !== undefined,
    subAgent: call !== undefined && (call.children?.length ?? 0) > 0,
    nested: slotKey.includes('/'),
    createdFile:
      createdPath === undefined ? undefined : isPreviewablePath(createdPath) ? 'preview' : 'open',
  }
}
