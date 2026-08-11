/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the pure content-block helpers — locations normalization, plus the
 *  inbound caps applied inside splitToolCallContent / mergeStreamingBlock so
 *  oversized agent payloads never land in the view model whole.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import {
  DIFF_SIDE_CAP,
  DIFF_SIDE_HEAD,
  DIFF_SIDE_TAIL,
  MEDIA_DATA_CAP,
} from '../acpContentLimits.js'
import {
  mergeStreamingBlock,
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

describe('mergeStreamingBlock', () => {
  it('merges consecutive text chunks into one block', () => {
    const merged = mergeStreamingBlock([{ type: 'text', text: 'he' }], {
      type: 'text',
      text: 'llo',
    })
    expect(merged).toStrictEqual([{ type: 'text', text: 'hello' }])
  })

  it('empties the data of an oversized incoming media chunk', () => {
    const merged = mergeStreamingBlock([{ type: 'text', text: 'msg' }], {
      type: 'image',
      data: 'A'.repeat(MEDIA_DATA_CAP + 1),
      mimeType: 'image/png',
    })
    const image = merged[1]
    if (image?.type !== 'image') throw new Error('expected image block')
    expect(image.data).toBe('')
    expect(image.mimeType).toBe('image/png')
  })

  it('passes a small media chunk through by reference', () => {
    const small: ContentBlock = { type: 'audio', data: 'AAA', mimeType: 'audio/wav' }
    const merged = mergeStreamingBlock([{ type: 'text', text: 'msg' }], small)
    expect(merged[1]).toBe(small)
  })
})
