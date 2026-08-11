/*---------------------------------------------------------------------------------------------
 *  Tests for the inbound content caps applied before agent payloads land in
 *  the AcpSession view model — pure functions, no session harness needed.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import {
  RAW_INPUT_CAP,
  TERMINAL_OUTPUT_CAP,
  TERMINAL_OUTPUT_REBUILD_AT,
  TERMINAL_OUTPUT_TRUNCATED_MARKER,
  TOOL_TEXT_BLOCK_CAP,
  TOOL_TEXT_BLOCK_HEAD,
  TOOL_TEXT_BLOCK_TAIL,
  capRawInput,
  capTerminalOutputTail,
  capToolCallBlocks,
  truncateToolTextBlock,
} from '../acpContentLimits.js'

describe('capTerminalOutputTail', () => {
  it('returns text below the cap untouched', () => {
    const text = 'x'.repeat(TERMINAL_OUTPUT_CAP)
    expect(capTerminalOutputTail(text)).toBe(text)
  })

  it('applies hysteresis: text between the cap and the rebuild threshold is kept verbatim', () => {
    const text = 'y'.repeat(TERMINAL_OUTPUT_REBUILD_AT)
    expect(capTerminalOutputTail(text)).toBe(text)
  })

  it('past the threshold keeps the tail capped at the cap with a marker head', () => {
    const tail = 'z'.repeat(TERMINAL_OUTPUT_CAP)
    const text = 'h'.repeat(TERMINAL_OUTPUT_REBUILD_AT) + tail
    const capped = capTerminalOutputTail(text)
    expect(capped.startsWith(TERMINAL_OUTPUT_TRUNCATED_MARKER)).toBe(true)
    expect(capped.length).toBe(TERMINAL_OUTPUT_TRUNCATED_MARKER.length + TERMINAL_OUTPUT_CAP)
    expect(capped.endsWith(tail)).toBe(true)
    expect(capped).not.toContain('h')
  })
})

describe('truncateToolTextBlock', () => {
  it('returns text at or below the cap untouched', () => {
    const text = 'a'.repeat(TOOL_TEXT_BLOCK_CAP)
    expect(truncateToolTextBlock(text)).toBe(text)
  })

  it('caps oversized text to head + omission note + tail', () => {
    const head = 'h'.repeat(TOOL_TEXT_BLOCK_HEAD)
    const middle = 'm'.repeat(TOOL_TEXT_BLOCK_CAP)
    const tail = 't'.repeat(TOOL_TEXT_BLOCK_TAIL)
    const truncated = truncateToolTextBlock(head + middle + tail)
    const omitted = middle.length
    expect(truncated).toBe(`${head}\n[... ${omitted} chars truncated ...]\n${tail}`)
  })

  it('reports the exact omitted character count in the marker', () => {
    const text = 'x'.repeat(TOOL_TEXT_BLOCK_CAP + 1)
    const truncated = truncateToolTextBlock(text)
    const omitted = text.length - TOOL_TEXT_BLOCK_HEAD - TOOL_TEXT_BLOCK_TAIL
    expect(truncated).toContain(`[... ${omitted} chars truncated ...]`)
    expect(truncated.length).toBeLessThan(text.length)
  })
})

describe('capToolCallBlocks', () => {
  it('returns the same array reference when no block needs capping', () => {
    const blocks: readonly ContentBlock[] = [
      { type: 'text', text: 'short' },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
    ]
    expect(capToolCallBlocks(blocks)).toBe(blocks)
  })

  it('caps only the oversized text blocks and passes other blocks through', () => {
    const big = 'b'.repeat(TOOL_TEXT_BLOCK_CAP + 10)
    const image: ContentBlock = { type: 'image', data: 'AAA', mimeType: 'image/png' }
    const blocks: readonly ContentBlock[] = [
      { type: 'text', text: 'short' },
      { type: 'text', text: big },
      image,
    ]
    const capped = capToolCallBlocks(blocks)
    expect(capped).not.toBe(blocks)
    expect(capped).toHaveLength(3)
    expect(capped[0]).toEqual({ type: 'text', text: 'short' })
    expect(capped[2]).toBe(image)
    const cappedText = capped[1]
    if (cappedText?.type !== 'text') throw new Error('expected text block')
    expect(cappedText.text.startsWith('b'.repeat(100))).toBe(true)
    expect(cappedText.text).toContain('chars truncated')
    expect(cappedText.text.length).toBeLessThan(big.length)
  })
})

describe('capRawInput', () => {
  it('passes undefined through', () => {
    expect(capRawInput(undefined)).toBeUndefined()
  })

  it('keeps a small input by reference', () => {
    const input = { command: 'ls', args: ['-la'] }
    expect(capRawInput(input)).toBe(input)
  })

  it('keeps an input right at the cap boundary', () => {
    // { "k": "<pad>" } — pad so the JSON lands exactly on the cap.
    const pad = RAW_INPUT_CAP - '{"k":""}'.length
    const input = { k: 'x'.repeat(pad) }
    expect(capRawInput(input)).toBe(input)
  })

  it('drops an input whose JSON exceeds the cap', () => {
    const input = { k: 'x'.repeat(RAW_INPUT_CAP) }
    expect(capRawInput(input)).toBeUndefined()
  })

  it('drops an unstringifiable (circular) input', () => {
    const input: { self?: unknown } = {}
    input.self = input
    expect(capRawInput(input)).toBeUndefined()
  })
})
