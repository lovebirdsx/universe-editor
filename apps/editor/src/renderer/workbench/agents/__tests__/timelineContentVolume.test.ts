/*---------------------------------------------------------------------------------------------
 *  Unit tests for the cheap timeline render-volume estimate and the resulting
 *  virtualization decision (pure model math — no DOM).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type {
  AcpChildItem,
  AcpMessage,
  AcpToolCall,
  AcpToolCallDiff,
  TimelineItem,
} from '../../../services/acp/session/acpSessionModel.js'
import {
  CHAT_VIRTUALIZATION_CONTENT_BUDGET,
  estimateTimelineContentVolume,
  resolveTimelineVirtualization,
} from '../timelineContentVolume.js'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeMessage(id: string, text: string, blocks?: readonly ContentBlock[]): TimelineItem {
  const message: AcpMessage = {
    id,
    role: 'agent',
    text,
    blocks: blocks ?? (text.length > 0 ? [textBlock(text)] : []),
    streaming: false,
  }
  return { kind: 'message', id, message }
}

function makeToolCall(
  id: string,
  overrides: {
    text: string
    blocks?: readonly ContentBlock[]
    diffs?: readonly AcpToolCallDiff[]
    children?: readonly AcpChildItem[]
  },
): TimelineItem {
  const call: AcpToolCall = {
    id,
    title: id,
    kind: 'other',
    status: 'completed',
    text: overrides.text,
    blocks: overrides.blocks ?? (overrides.text.length > 0 ? [textBlock(overrides.text)] : []),
    diffs: overrides.diffs ?? [],
    ...(overrides.children !== undefined ? { children: overrides.children } : {}),
  }
  return { kind: 'toolCall', id, call }
}

function makeChildMessage(id: string, text: string): AcpChildItem {
  return makeMessage(id, text) as AcpChildItem
}

function makeChildToolCall(id: string, text: string): AcpChildItem {
  return {
    kind: 'toolCall',
    id,
    call: { id, title: id, kind: 'other', status: 'completed', text, blocks: [], diffs: [] },
  }
}

describe('estimateTimelineContentVolume', () => {
  it('sums message characters and weights every markdown text block', () => {
    const volume = estimateTimelineContentVolume([
      makeMessage('a', 'abcd'),
      makeMessage('b', 'ef', [textBlock('ef'), textBlock('extra')]),
    ])
    expect(volume.chars).toBe(6)
    expect(volume.markdownBlocks).toBe(3)
    expect(volume.volume).toBe(6 + 3 * 500)
  })

  it('counts tool output, diff bodies and one level of sub-agent children', () => {
    const call = makeToolCall('t', {
      text: 'x'.repeat(10),
      blocks: [textBlock('x'.repeat(10))],
      diffs: [{ path: 'a.ts', oldText: '', newText: 'y'.repeat(20) }],
      children: [
        makeChildMessage('child-m', 'z'.repeat(30)),
        makeChildToolCall('child-t', 'abcde'),
      ],
    })
    const volume = estimateTimelineContentVolume([call])
    expect(volume.chars).toBe(10 + 20 + 30 + 5)
    expect(volume.markdownBlocks).toBe(2)
  })

  it('ignores empty text blocks (they never mount a markdown view)', () => {
    const volume = estimateTimelineContentVolume([
      makeMessage('a', '', [textBlock(''), { type: 'image', mimeType: 'image/png', data: '' }]),
    ])
    expect(volume.chars).toBe(0)
    expect(volume.markdownBlocks).toBe(0)
    expect(volume.volume).toBe(0)
  })

  it('treats equal-looking but distinct slot objects as separate rows', () => {
    const a = makeMessage('a', 'same')
    const b = makeMessage('b', 'same')
    const volume = estimateTimelineContentVolume([a, b])
    expect(volume.chars).toBe(8)
    expect(volume.markdownBlocks).toBe(2)
  })

  it('crosses the budget on a single large message', () => {
    const volume = estimateTimelineContentVolume([makeMessage('a', 'x'.repeat(50_000))])
    expect(volume.volume).toBeGreaterThan(CHAT_VIRTUALIZATION_CONTENT_BUDGET)
  })

  it('crosses the budget on many markdown blocks alone', () => {
    const items = Array.from({ length: 41 }, (_, i) =>
      makeMessage(`m${i}`, 'ab', [textBlock('a'), textBlock('b')]),
    )
    const volume = estimateTimelineContentVolume(items)
    expect(volume.chars).toBe(82)
    expect(volume.markdownBlocks).toBe(82)
    expect(volume.volume).toBeGreaterThan(CHAT_VIRTUALIZATION_CONTENT_BUDGET)
  })

  it('stays under the budget for a short ordinary conversation', () => {
    const items = Array.from({ length: 10 }, (_, i) => makeMessage(`m${i}`, 'y'.repeat(500)))
    expect(estimateTimelineContentVolume(items).volume).toBeLessThan(
      CHAT_VIRTUALIZATION_CONTENT_BUDGET,
    )
  })
})

describe('resolveTimelineVirtualization', () => {
  it('virtualizes past the item threshold', () => {
    expect(
      resolveTimelineVirtualization({
        itemCount: 51,
        itemThreshold: 50,
        contentHeavy: false,
        findOpen: false,
      }),
    ).toEqual({ virtualize: true, reason: 'items' })
  })

  it('is inclusive at the item threshold (matching the existing > comparison)', () => {
    expect(
      resolveTimelineVirtualization({
        itemCount: 50,
        itemThreshold: 50,
        contentHeavy: false,
        findOpen: false,
      }),
    ).toEqual({ virtualize: false, reason: 'none' })
  })

  it('virtualizes a short timeline when the content budget is exceeded', () => {
    expect(
      resolveTimelineVirtualization({
        itemCount: 10,
        itemThreshold: 50,
        contentHeavy: true,
        findOpen: false,
      }),
    ).toEqual({ virtualize: true, reason: 'content' })
  })

  it('lets an open find bar force the plain list, even when both limits are exceeded', () => {
    expect(
      resolveTimelineVirtualization({
        itemCount: 200,
        itemThreshold: 50,
        contentHeavy: true,
        findOpen: true,
      }),
    ).toEqual({ virtualize: false, reason: 'find' })
  })
})
