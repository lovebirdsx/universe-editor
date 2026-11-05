/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  buildRewindPickItems tests — anchor eligibility, the fork-only tip row and
 *  first-turn exclusion, ordinal labels, and single-line summaries.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AcpMessage } from '../../services/acp/session/acpSessionService.js'
import {
  buildRewindPickItems,
  FORK_TIP_ITEM_ID,
  summarizeMessageText,
  type RewindPickItem,
} from '../agentRewindPickItems.js'

function message(overrides: Partial<AcpMessage> & { id: string }): AcpMessage {
  return {
    role: 'user',
    text: `text-${overrides.id}`,
    blocks: [],
    streaming: false,
    ...overrides,
  }
}

function items(...args: Parameters<typeof buildRewindPickItems>): RewindPickItem[] {
  return buildRewindPickItems(...args)
}

describe('buildRewindPickItems', () => {
  it('lists only user turns that carry a messageId and are not auto-retries', () => {
    const picked = items(
      [
        message({ id: 'm0', role: 'agent', messageId: 'agent-id' }),
        message({ id: 'm1', messageId: 'u1' }),
        message({ id: 'm2' }),
        message({ id: 'm3', messageId: 'u3', autoRetry: true }),
        message({ id: 'm4', messageId: 'u4' }),
      ],
      'rewind',
    )
    expect(picked.map((item) => item.messageId)).toEqual(['u1', 'u4'])
    expect(picked.map((item) => item.leadingLabel)).toEqual(['1', '2'])
    expect(picked.map((item) => item.label)).toEqual(['text-m1', 'text-m4'])
  })

  it('keeps the first user turn for rewind', () => {
    const picked = items([message({ id: 'm1', messageId: 'u1' })], 'rewind')
    expect(picked.map((item) => item.messageId)).toEqual(['u1'])
  })

  it('prefixes the fork list with the tip row and skips the first user turn', () => {
    const picked = items(
      [
        message({ id: 'm1', messageId: 'u1' }),
        message({ id: 'm2', messageId: 'u2' }),
        message({ id: 'm3', messageId: 'u3' }),
      ],
      'fork',
    )
    expect(picked[0]?.id).toBe(FORK_TIP_ITEM_ID)
    expect(picked[0]?.fromTip).toBe(true)
    expect(picked.map((item) => item.messageId)).toEqual([undefined, 'u2', 'u3'])
    expect(picked.slice(1).map((item) => item.leadingLabel)).toEqual(['1', '2'])
  })

  it('does not skip a later turn when the first user turn is not eligible', () => {
    const picked = items([message({ id: 'm1' }), message({ id: 'm2', messageId: 'u2' })], 'fork')
    expect(picked.map((item) => item.messageId)).toEqual([undefined, 'u2'])
  })

  it('returns an empty list when there is nothing to rewind to', () => {
    expect(items([message({ id: 'm1' })], 'rewind')).toEqual([])
  })
})

describe('summarizeMessageText', () => {
  it('collapses whitespace and control characters into one line', () => {
    expect(summarizeMessageText('  first\n\nsecond\t\tthird  ')).toBe('first second third')
  })

  it('falls back to a placeholder for empty text', () => {
    expect(summarizeMessageText(' \n\t ')).toBe('(empty message)')
  })

  it('truncates by code point and appends an ellipsis', () => {
    const summary = summarizeMessageText('😀'.repeat(121))
    expect(Array.from(summary)).toHaveLength(121)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('leaves a 120-code-point summary untouched', () => {
    const text = 'a'.repeat(120)
    expect(summarizeMessageText(text)).toBe(text)
  })
})
