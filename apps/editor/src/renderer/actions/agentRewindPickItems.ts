/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Quick-pick item builder for the rewind / fork message pickers. Only user
 *  turns carrying an agent-side `messageId` can be used as anchors; auto-retry
 *  "continue" turns are deliberately excluded (they have no user-authored text
 *  to edit-and-retry), and a fork may not target the first user turn because
 *  there is no predecessor to slice at.
 *--------------------------------------------------------------------------------------------*/

import { localize, type IQuickPickItem } from '@universe-editor/platform'
import type { AcpMessage } from '../services/acp/session/acpSessionService.js'

export interface RewindPickItem extends IQuickPickItem {
  readonly messageId?: string
  readonly fromTip?: true
}

export const FORK_TIP_ITEM_ID = 'acp.fork.picker.tip'

const MAX_LABEL_CODE_POINTS = 120

/** Collapse a user turn into one line so a multi-line prompt cannot inflate the picker row. */
export function summarizeMessageText(text: string): string {
  const normalized = text.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim()
  if (normalized.length === 0) {
    return localize('agent.rewind.picker.emptyMessage', '(empty message)')
  }
  const codePoints = Array.from(normalized)
  if (codePoints.length <= MAX_LABEL_CODE_POINTS) return normalized
  return `${codePoints.slice(0, MAX_LABEL_CODE_POINTS).join('')}…`
}

/**
 * Build the picker rows for a session's timeline.
 *
 * Rewind lists every usable user turn (rewinding to the first turn is valid —
 * it truncates the whole conversation). Fork adds a leading "from the end" row
 * and omits the first user turn: `session/fork` slices before the anchor, so
 * the first turn has no predecessor and the agent must refuse it.
 */
export function buildRewindPickItems(
  messages: readonly AcpMessage[],
  mode: 'rewind' | 'fork',
): RewindPickItem[] {
  const entries: RewindPickItem[] = []
  if (mode === 'fork') {
    entries.push({
      id: FORK_TIP_ITEM_ID,
      label: localize('agent.fork.picker.tip', 'From the end of the conversation (full history)'),
      description: localize(
        'agent.fork.picker.tipDescription',
        'Keeps every message, including the last turn',
      ),
      fromTip: true,
    })
  }

  const firstUserId = messages.find((message) => message.role === 'user')?.id
  let ordinal = 0
  for (const message of messages) {
    if (message.role !== 'user' || message.autoRetry === true) continue
    const messageId = message.messageId
    if (messageId === undefined || messageId.length === 0) continue
    if (mode === 'fork' && message.id === firstUserId) continue
    ordinal++
    entries.push({
      id: `msg:${messageId}`,
      leadingLabel: String(ordinal),
      label: summarizeMessageText(message.text),
      messageId,
    })
  }
  return entries
}
