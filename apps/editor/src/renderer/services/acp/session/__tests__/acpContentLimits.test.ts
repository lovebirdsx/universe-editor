/*---------------------------------------------------------------------------------------------
 *  Tests for the inbound content caps applied before agent payloads land in
 *  the AcpSession view model — pure functions, no session harness needed.
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
  RAW_INPUT_CAP,
  TERMINAL_OUTPUT_CAP,
  TERMINAL_OUTPUT_REBUILD_AT,
  TERMINAL_OUTPUT_TRUNCATED_MARKER,
  TOOL_TEXT_BLOCK_CAP,
  TOOL_TEXT_BLOCK_HEAD,
  TOOL_TEXT_BLOCK_TAIL,
  capContentBlock,
  capMessageBlocksTail,
  capRawInput,
  capTerminalOutputTail,
  capToolCallBlocks,
  estimateUpdateResidentBytes,
  truncateDiffSideText,
  truncateToolTextBlock,
} from '../acpContentLimits.js'
import { blocksToText } from '../acpSessionContent.js'

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

describe('capContentBlock', () => {
  it('passes a small media block through by reference', () => {
    const block: ContentBlock = { type: 'image', data: 'AAA', mimeType: 'image/png' }
    expect(capContentBlock(block)).toBe(block)
  })

  it('empties the data of an oversized image block and stamps a truncation marker', () => {
    const block: ContentBlock = {
      type: 'image',
      data: 'A'.repeat(MEDIA_DATA_CAP + 1),
      mimeType: 'image/png',
    }
    const capped = capContentBlock(block)
    expect(capped).not.toBe(block)
    if (capped.type !== 'image') throw new Error('expected image block')
    expect(capped.data).toBe('')
    expect(capped.mimeType).toBe('image/png')
    expect(capped._meta?.['universe-editor/truncated']).toBe(true)
  })

  it('empties the data of an oversized audio block', () => {
    const capped = capContentBlock({
      type: 'audio',
      data: 'B'.repeat(MEDIA_DATA_CAP + 1),
      mimeType: 'audio/wav',
    })
    if (capped.type !== 'audio') throw new Error('expected audio block')
    expect(capped.data).toBe('')
    expect(capped._meta?.['universe-editor/truncated']).toBe(true)
  })

  it('keeps a media block right at the cap boundary', () => {
    const block: ContentBlock = {
      type: 'image',
      data: 'A'.repeat(MEDIA_DATA_CAP),
      mimeType: 'image/png',
    }
    expect(capContentBlock(block)).toBe(block)
  })

  it('does not touch text / resource blocks', () => {
    const text: ContentBlock = { type: 'text', text: 'hello' }
    expect(capContentBlock(text)).toBe(text)
  })

  it('preserves a pre-existing _meta while stamping the marker', () => {
    const block: ContentBlock = {
      type: 'image',
      data: 'A'.repeat(MEDIA_DATA_CAP + 1),
      mimeType: 'image/png',
      _meta: { origin: 'agent-x' },
    }
    const capped = capContentBlock(block)
    if (capped.type !== 'image') throw new Error('expected image block')
    expect(capped._meta?.origin).toBe('agent-x')
    expect(capped._meta?.['universe-editor/truncated']).toBe(true)
  })
})

describe('capToolCallBlocks — media', () => {
  it('caps oversized media blocks while passing small ones through by reference', () => {
    const small: ContentBlock = { type: 'image', data: 'AAA', mimeType: 'image/png' }
    const big: ContentBlock = {
      type: 'audio',
      data: 'B'.repeat(MEDIA_DATA_CAP + 1),
      mimeType: 'audio/wav',
    }
    const capped = capToolCallBlocks([small, big])
    expect(capped[0]).toBe(small)
    const cappedBig = capped[1]
    if (cappedBig?.type !== 'audio') throw new Error('expected audio block')
    expect(cappedBig.data).toBe('')
  })
})

describe('capMessageBlocksTail', () => {
  it('returns the blocks untouched below the rebuild threshold', () => {
    const blocks: readonly ContentBlock[] = [{ type: 'text', text: 'short' }]
    expect(capMessageBlocksTail(blocks)).toBe(blocks)
  })

  it('applies hysteresis: text between the cap and the rebuild threshold is kept verbatim', () => {
    const blocks: readonly ContentBlock[] = [
      { type: 'text', text: 'x'.repeat(MESSAGE_TEXT_REBUILD_AT) },
    ]
    expect(capMessageBlocksTail(blocks)).toBe(blocks)
  })

  it('past the threshold keeps a capped tail whose blocksToText is marker + tail', () => {
    const tail = 'z'.repeat(MESSAGE_TEXT_CAP)
    const blocks: readonly ContentBlock[] = [
      { type: 'text', text: 'h'.repeat(MESSAGE_TEXT_REBUILD_AT) + tail },
    ]
    const capped = capMessageBlocksTail(blocks)
    expect(capped).not.toBe(blocks)
    const text = blocksToText(capped)
    expect(text.startsWith(MESSAGE_TEXT_TRUNCATED_MARKER)).toBe(true)
    expect(text.endsWith(tail)).toBe(true)
    expect(text).not.toContain('h')
    expect(text.length).toBe(MESSAGE_TEXT_TRUNCATED_MARKER.length + MESSAGE_TEXT_CAP)
  })

  it('drops leading non-text blocks (they carry no searchable text)', () => {
    const image: ContentBlock = {
      type: 'image',
      data: 'AAA',
      mimeType: 'image/png',
    }
    const blocks: readonly ContentBlock[] = [
      image,
      { type: 'text', text: 'q'.repeat(MESSAGE_TEXT_REBUILD_AT + 10) },
    ]
    const capped = capMessageBlocksTail(blocks)
    expect(capped.some((b) => b.type === 'image')).toBe(false)
    expect(blocksToText(capped).startsWith(MESSAGE_TEXT_TRUNCATED_MARKER)).toBe(true)
  })

  it('keeps the newest text spread over several trailing text blocks', () => {
    const half = Math.floor(MESSAGE_TEXT_CAP / 2)
    const blocks: readonly ContentBlock[] = [
      { type: 'text', text: 'old'.repeat(400_000) },
      { type: 'text', text: 'm'.repeat(half) },
      { type: 'text', text: 'n'.repeat(half) },
    ]
    expect(blocksToText(blocks).length).toBeGreaterThan(MESSAGE_TEXT_REBUILD_AT)
    const capped = capMessageBlocksTail(blocks)
    const text = blocksToText(capped)
    expect(text.startsWith(MESSAGE_TEXT_TRUNCATED_MARKER)).toBe(true)
    expect(text.endsWith('n'.repeat(half))).toBe(true)
    expect(text).toContain('m'.repeat(half))
    expect(text).not.toContain('old')
    expect(text.length).toBeLessThanOrEqual(MESSAGE_TEXT_TRUNCATED_MARKER.length + MESSAGE_TEXT_CAP)
  })

  it('keeps the surviving media blocks that fall inside the retained tail window', () => {
    // A media block interleaved inside the retained tail stays (it renders);
    // only text beyond the cap window is cut.
    const blocks: readonly ContentBlock[] = [
      { type: 'text', text: 'h'.repeat(MESSAGE_TEXT_REBUILD_AT) },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
      { type: 'text', text: 'tail' },
    ]
    const capped = capMessageBlocksTail(blocks)
    expect(capped.some((b) => b.type === 'image')).toBe(true)
    expect(blocksToText(capped).endsWith('tail')).toBe(true)
    expect(blocksToText(capped).startsWith(MESSAGE_TEXT_TRUNCATED_MARKER)).toBe(true)
  })
})

describe('truncateDiffSideText', () => {
  it('returns text at or below the cap untouched', () => {
    const text = 'd'.repeat(DIFF_SIDE_CAP)
    expect(truncateDiffSideText(text)).toBe(text)
  })

  it('caps oversized text to head + omission note + tail', () => {
    const head = 'h'.repeat(DIFF_SIDE_HEAD)
    const middle = 'm'.repeat(DIFF_SIDE_CAP)
    const tail = 't'.repeat(DIFF_SIDE_TAIL)
    const truncated = truncateDiffSideText(head + middle + tail)
    const omitted = middle.length
    expect(truncated).toBe(`${head}\n[... ${omitted} chars truncated ...]\n${tail}`)
  })

  it('reports the exact omitted character count in the marker', () => {
    const text = 'x'.repeat(DIFF_SIDE_CAP + 1)
    const truncated = truncateDiffSideText(text)
    const omitted = text.length - DIFF_SIDE_HEAD - DIFF_SIDE_TAIL
    expect(truncated).toContain(`[... ${omitted} chars truncated ...]`)
    expect(truncated.length).toBeLessThan(text.length)
  })
})

describe('estimateUpdateResidentBytes', () => {
  it('sums text chunk content plus its derived text copy (UTF-16 bytes)', () => {
    expect(
      estimateUpdateResidentBytes({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
    ).toBe(5 * 2 * 2)
  })

  it('sums media data in chunk content (no text copy for media)', () => {
    expect(
      estimateUpdateResidentBytes({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'AAA', mimeType: 'image/png' },
      }),
    ).toBe(3 * 2)
  })

  it('sums tool call content blocks, diff sides, and the text copy', () => {
    expect(
      estimateUpdateResidentBytes({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc',
        title: 't',
        content: [
          { type: 'content', content: { type: 'text', text: 'aaaa' } },
          { type: 'content', content: { type: 'image', data: 'bb', mimeType: 'image/png' } },
          { type: 'diff', path: '/a.ts', oldText: 'ccc', newText: 'ddddd' },
          { type: 'terminal', terminalId: 't1' },
        ],
      }),
    ).toBe((4 + 2) * 2 + (3 + 5) * 2 + 4 * 2)
  })

  it('counts out-of-band terminal output carried in _meta', () => {
    expect(
      estimateUpdateResidentBytes({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc',
        title: 'execute',
        kind: 'execute',
        status: 'in_progress',
        content: [],
        _meta: { terminal_output: { data: 'xyz' } },
      } as never),
    ).toBe(3 * 2)
  })

  it('counts a terminal delta as its incremental size', () => {
    expect(
      estimateUpdateResidentBytes({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc',
        title: 'execute',
        kind: 'execute',
        status: 'in_progress',
        content: [],
        _meta: { terminal_output_delta: { data: 'abcd' } },
      } as never),
    ).toBe(4 * 2)
  })

  it('counts raw tool input by its JSON size', () => {
    expect(
      estimateUpdateResidentBytes({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc',
        title: 't',
        content: [],
        rawInput: { command: 'ls' },
      } as never),
    ).toBe('{"command":"ls"}'.length * 2)
  })

  it('costs an oversized raw input 0 (it is dropped downstream)', () => {
    expect(
      estimateUpdateResidentBytes({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc',
        title: 't',
        content: [],
        rawInput: { blob: 'x'.repeat(RAW_INPUT_CAP) },
      } as never),
    ).toBe(0)
  })

  it('returns 0 for metadata-only updates', () => {
    expect(
      estimateUpdateResidentBytes({
        sessionUpdate: 'usage_update',
        usage: { used: 1, size: 2 },
      } as never),
    ).toBe(0)
    expect(
      estimateUpdateResidentBytes({
        sessionUpdate: 'plan',
        entries: [],
      }),
    ).toBe(0)
  })
})
