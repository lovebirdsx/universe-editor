/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the pure content-block helpers — locations normalization, plus the
 *  inbound caps applied inside splitToolCallContent / StreamingBlocksAccumulator
 *  so oversized agent payloads never land in the view model whole.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import {
  DIFF_SIDE_CAP,
  DIFF_SIDE_HEAD,
  DIFF_SIDE_TAIL,
  MEDIA_DATA_CAP,
  MESSAGE_TEXT_CAP,
  MESSAGE_TEXT_REBUILD_AT,
  MESSAGE_TEXT_TRUNCATED_MARKER,
} from '../acpContentLimits.js'
import {
  StreamingBlocksAccumulator,
  blocksToText,
  readToolCallLocations,
  splitToolCallContent,
} from '../acpSessionContent.js'

describe('readToolCallLocations', () => {
  it('returns undefined for null / undefined / empty', () => {
    expect(readToolCallLocations(null)).toBeUndefined()
    expect(readToolCallLocations(undefined)).toBeUndefined()
    expect(readToolCallLocations([])).toBeUndefined()
  })

  it('keeps path and line, coercing a null line to omitted', () => {
    expect(
      readToolCallLocations([
        { path: '/a/b.ts', line: 10 },
        { path: '/c/d.ts', line: null },
      ]),
    ).toStrictEqual([{ path: '/a/b.ts', line: 10 }, { path: '/c/d.ts' }])
  })

  it('drops entries with an empty or missing path', () => {
    expect(readToolCallLocations([{ path: '', line: 1 }, { path: '/keep.ts' }])).toStrictEqual([
      { path: '/keep.ts' },
    ])
  })
})

describe('splitToolCallContent', () => {
  it('empties the data of oversized media content blocks', () => {
    const { blocks } = splitToolCallContent([
      {
        type: 'content',
        content: {
          type: 'image',
          data: 'A'.repeat(MEDIA_DATA_CAP + 1),
          mimeType: 'image/png',
        },
      },
    ])
    const image = blocks[0]
    if (image?.type !== 'image') throw new Error('expected image block')
    expect(image.data).toBe('')
    expect(image.mimeType).toBe('image/png')
  })

  it('passes small media blocks through by reference', () => {
    const small: ContentBlock = { type: 'image', data: 'AAA', mimeType: 'image/png' }
    const { blocks } = splitToolCallContent([{ type: 'content', content: small }])
    expect(blocks[0]).toBe(small)
  })

  it('truncates oversized diff sides to head + omission note + tail', () => {
    const big = 'd'.repeat(DIFF_SIDE_CAP + 1)
    const { diffs } = splitToolCallContent([
      { type: 'diff', path: '/a.ts', oldText: big, newText: big },
    ])
    const diff = diffs[0]
    if (!diff) throw new Error('expected a diff entry')
    const omitted = big.length - DIFF_SIDE_HEAD - DIFF_SIDE_TAIL
    expect(diff.oldText).toContain(`[... ${omitted} chars truncated ...]`)
    expect(diff.newText.startsWith('d'.repeat(100))).toBe(true)
    expect(diff.newText.length).toBeLessThan(big.length)
  })

  it('keeps small diff sides untouched', () => {
    const { diffs } = splitToolCallContent([
      { type: 'diff', path: '/a.ts', oldText: 'before', newText: 'after' },
    ])
    expect(diffs).toStrictEqual([{ path: '/a.ts', oldText: 'before', newText: 'after' }])
  })
})

describe('StreamingBlocksAccumulator', () => {
  it('merges consecutive 1-char chunks and flattens to one flat text block', () => {
    const acc = new StreamingBlocksAccumulator([{ type: 'text', text: 'a' }])
    for (const c of ['b', 'c', 'd', 'e']) {
      expect(acc.push({ type: 'text', text: c })).toBe(false)
    }
    const { blocks, text } = acc.flatten()
    expect(blocks).toStrictEqual([{ type: 'text', text: 'abcde' }])
    expect(text).toBe('abcde')
    // The flattened blocks are ordinary ContentBlocks the rest of the pipeline
    // reads — the intermediate accumulation form never reaches blocksToText.
    expect(blocksToText(blocks)).toBe(text)
  })

  it('starts from an empty base and joins chunks at flatten', () => {
    const acc = new StreamingBlocksAccumulator([])
    acc.push({ type: 'text', text: 'x' })
    acc.push({ type: 'text', text: 'y' })
    expect(acc.flatten()).toStrictEqual({ blocks: [{ type: 'text', text: 'xy' }], text: 'xy' })
  })

  it('preserves blank chunks so inter-word spacing survives', () => {
    const acc = new StreamingBlocksAccumulator([{ type: 'text', text: 'a' }])
    acc.push({ type: 'text', text: '' })
    acc.push({ type: 'text', text: ' b' })
    expect(acc.flatten().text).toBe('a b')
  })

  it('closes the text run when a media chunk interleaves, then reopens on text', () => {
    const acc = new StreamingBlocksAccumulator([{ type: 'text', text: 'msg' }])
    acc.push({ type: 'text', text: ' body' })
    const small: ContentBlock = { type: 'audio', data: 'AAA', mimeType: 'audio/wav' }
    acc.push(small)
    acc.push({ type: 'text', text: ' tail' })
    const { blocks, text } = acc.flatten()
    expect(blocks[0]).toStrictEqual({ type: 'text', text: 'msg body' })
    expect(blocks[1]).toBe(small)
    expect(blocks[2]).toStrictEqual({ type: 'text', text: ' tail' })
    expect(text).toBe('msg body[audio: audio/wav] tail')
  })

  it('empties the data of an oversized incoming media chunk', () => {
    const acc = new StreamingBlocksAccumulator([{ type: 'text', text: 'msg' }])
    acc.push({ type: 'image', data: 'A'.repeat(MEDIA_DATA_CAP + 1), mimeType: 'image/png' })
    const { blocks } = acc.flatten()
    const image = blocks[1]
    if (image?.type !== 'image') throw new Error('expected image block')
    expect(image.data).toBe('')
    expect(image.mimeType).toBe('image/png')
  })

  it('caps at the MESSAGE_TEXT_REBUILD_AT hysteresis point like the old merge path', () => {
    const acc = new StreamingBlocksAccumulator([
      { type: 'text', text: 'a'.repeat(MESSAGE_TEXT_REBUILD_AT + 100) },
    ])
    expect(acc.push({ type: 'text', text: 'END' })).toBe(true)
    const { blocks, text } = acc.flatten()
    expect(text.startsWith(MESSAGE_TEXT_TRUNCATED_MARKER)).toBe(true)
    expect(text.endsWith('END')).toBe(true)
    expect(text.length).toBe(MESSAGE_TEXT_TRUNCATED_MARKER.length + MESSAGE_TEXT_CAP)
    expect(blocksToText(blocks)).toBe(text)
  })

  it('keeps accumulating from the capped flat tail after a hysteresis rebuild', () => {
    const acc = new StreamingBlocksAccumulator([
      { type: 'text', text: 'a'.repeat(MESSAGE_TEXT_REBUILD_AT + 100) },
    ])
    expect(acc.push({ type: 'text', text: 'END' })).toBe(true)
    // Below the threshold again: the next chunks just accumulate.
    expect(acc.push({ type: 'text', text: '!' })).toBe(false)
    const { text } = acc.flatten()
    expect(text.endsWith('END!')).toBe(true)
  })

  it('the flattened view is a detached snapshot — later pushes do not mutate it', () => {
    const acc = new StreamingBlocksAccumulator([{ type: 'text', text: 'x' }])
    const first = acc.flatten()
    acc.push({ type: 'text', text: 'y' })
    const second = acc.flatten()
    expect(first.text).toBe('x')
    expect(first.blocks).toStrictEqual([{ type: 'text', text: 'x' }])
    expect(second.text).toBe('xy')
  })
})
