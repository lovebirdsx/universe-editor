/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpProtocolTracer.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { LogLevel, NullLogger } from '@universe-editor/platform'
import { OutputChannel } from '../../output/OutputService.js'
import { AcpProtocolTracer, redactForTrace } from '../acpProtocolTracer.js'

const enc = (msg: unknown): string => JSON.stringify(msg) + '\n'

class CapturingLogger extends NullLogger {
  readonly infoLines: string[] = []
  constructor() {
    super(LogLevel.Info)
  }
  override info(message: string): void {
    this.infoLines.push(message)
  }
}

describe('AcpProtocolTracer', () => {
  let channel: OutputChannel
  let logger: CapturingLogger
  let tracer: AcpProtocolTracer

  beforeEach(() => {
    channel = new OutputChannel('acp/protocol')
    logger = new CapturingLogger()
    tracer = new AcpProtocolTracer(channel, logger, 'zed#abc123')
  })

  it('formats an outbound request', () => {
    tracer.traceOutboundChunk(
      enc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }),
    )
    const out = channel.content.get()
    expect(out).toMatch(
      /\[Trace - \d{2}:\d{2}:\d{2}\.\d{3}\] \[zed#abc123\] → Request 'initialize' \(1\)/,
    )
    expect(out).toContain('Params: {\n  "protocolVersion": 1\n}')
    expect(logger.infoLines).toEqual([
      `[zed#abc123] → Request 'initialize' (1) params={"protocolVersion":1}`,
    ])
  })

  it('formats an inbound notification with sessionId tag', () => {
    tracer.traceInboundChunk(
      enc({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sess_abcdef1234567890', update: { type: 'tick' } },
      }),
    )
    const out = channel.content.get()
    expect(out).toContain("← Notification 'session/update' [session=sess_abcdef12]")
    expect(logger.infoLines).toHaveLength(1)
    expect(logger.infoLines[0]).toBe(
      `[zed#abc123] ← Notification 'session/update' [session=sess_abcdef12] params={"sessionId":"sess_abcdef1234567890","update":{"type":"tick"}}`,
    )
  })

  it('correlates a response with its outbound request', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    tracer.traceOutboundChunk(enc({ jsonrpc: '2.0', id: 42, method: 'session/prompt', params: {} }))
    vi.advanceTimersByTime(1500)
    tracer.traceInboundChunk(enc({ jsonrpc: '2.0', id: 42, result: { stopReason: 'end_turn' } }))
    const out = channel.content.get()
    expect(out).toContain("← Response 'session/prompt' (42) in 1500ms")
    expect(out).toContain('Result: {\n  "stopReason": "end_turn"\n}')
    expect(logger.infoLines[1]).toBe(
      `[zed#abc123] ← Response 'session/prompt' (42) in 1500ms result={"stopReason":"end_turn"}`,
    )
    vi.useRealTimers()
  })

  it('marks error responses', () => {
    tracer.traceOutboundChunk(
      enc({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: {} }),
    )
    tracer.traceInboundChunk(
      enc({ jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'invalid params' } }),
    )
    const out = channel.content.get()
    expect(out).toContain("← Response 'fs/read_text_file' (7) in")
    expect(out).toContain('ERROR')
    expect(out).toContain('Error: {\n  "code": -32602')
    expect(logger.infoLines[1]).toMatch(
      /^\[zed#abc123\] ← Response 'fs\/read_text_file' \(7\) in \d+ms ERROR error=\{"code":-32602,"message":"invalid params"\}$/,
    )
  })

  it('buffers a line split across multiple chunks', () => {
    const full = enc({ jsonrpc: '2.0', method: 'ping', params: { n: 1 } })
    const mid = Math.floor(full.length / 2)
    tracer.traceInboundChunk(full.slice(0, mid))
    expect(channel.content.get()).toBe('')
    expect(logger.infoLines).toHaveLength(0)
    tracer.traceInboundChunk(full.slice(mid))
    expect(channel.content.get()).toContain("← Notification 'ping'")
    expect(logger.infoLines).toHaveLength(1)
  })

  it('handles multiple lines in a single chunk', () => {
    const merged =
      enc({ jsonrpc: '2.0', method: 'a', params: null }) +
      enc({ jsonrpc: '2.0', method: 'b', params: null })
    tracer.traceInboundChunk(merged)
    const out = channel.content.get()
    expect(out).toContain("Notification 'a'")
    expect(out).toContain("Notification 'b'")
    expect(logger.infoLines).toEqual([
      `[zed#abc123] ← Notification 'a' params=null`,
      `[zed#abc123] ← Notification 'b' params=null`,
    ])
  })

  it('elides an oversized line (multi-MB base64 frame) instead of parsing it', () => {
    const bigData = 'A'.repeat(4 * 1024 * 1024)
    const line = enc({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { content: { type: 'image', data: bigData } } },
    })
    // Arrives as ~64KB chunks, the way stdout is delivered over IPC on resume.
    const CHUNK = 64 * 1024
    for (let i = 0; i < line.length; i += CHUNK) {
      tracer.traceInboundChunk(line.slice(i, i + CHUNK))
    }
    const out = channel.content.get()
    expect(out).not.toContain(bigData)
    expect(out).toMatch(/← <large frame \d+ bytes elided>/)
    expect(out.length).toBeLessThan(2000)
    expect(logger.infoLines).toHaveLength(1)
    expect(logger.infoLines[0]).toMatch(/← <large frame \d+ bytes elided>$/)
  })

  it('does not rescan the whole buffer on every chunk (scan offset advances)', () => {
    // A large partial line split across many chunks must not accumulate past the
    // cap; once it does, it is dropped and the next real line still parses.
    const CHUNK = 64 * 1024
    const partial = 'x'.repeat(2 * 1024 * 1024)
    for (let i = 0; i < partial.length; i += CHUNK) {
      tracer.traceInboundChunk(partial.slice(i, i + CHUNK))
    }
    // No newline seen yet → nothing emitted, buffer was capped (dropped), not held.
    expect(channel.content.get()).toBe('')
    // Close the oversized line, then send a normal one.
    tracer.traceInboundChunk('\n')
    tracer.traceInboundChunk(enc({ jsonrpc: '2.0', method: 'ping', params: { n: 1 } }))
    const out = channel.content.get()
    expect(out).toMatch(/← <large frame \d+ bytes elided>/)
    expect(out).toContain("← Notification 'ping'")
  })

  it('falls back to <unparseable> on bad JSON without throwing', () => {
    expect(() => tracer.traceInboundChunk('not-json{garbage}\n')).not.toThrow()
    expect(channel.content.get()).toContain('<unparseable>')
    expect(logger.infoLines).toHaveLength(1)
    expect(logger.infoLines[0]).toContain('<unparseable>')
  })

  it('keeps pending maps isolated across tracer instances on the same channel', () => {
    const otherTracer = new AcpProtocolTracer(channel, logger, 'claude#xyz789')
    tracer.traceOutboundChunk(enc({ jsonrpc: '2.0', id: 1, method: 'a', params: {} }))
    otherTracer.traceInboundChunk(enc({ jsonrpc: '2.0', id: 1, result: {} }))
    const out = channel.content.get()
    expect(out).toContain("← Response '?' (1)")
    expect(out).toContain('[claude#xyz789]')
    expect(logger.infoLines.some((l) => l.startsWith(`[claude#xyz789] ← Response '?' (1)`))).toBe(
      true,
    )
  })

  it('redacts base64 image payloads instead of serializing them verbatim', () => {
    const bigData = 'A'.repeat(500_000)
    tracer.traceInboundChunk(
      enc({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_img',
          update: {
            type: 'user_message_chunk',
            content: { type: 'image', mimeType: 'image/png', data: bigData },
          },
        },
      }),
    )
    const out = channel.content.get()
    expect(out).not.toContain(bigData)
    expect(out).toContain('<base64 500000 chars>')
    expect(out.length).toBeLessThan(2000)
    expect(logger.infoLines[0]).toContain('<base64 500000 chars>')
    expect(logger.infoLines[0]).not.toContain(bigData)
  })
})

describe('redactForTrace', () => {
  it('replaces image data with a byte-count placeholder', () => {
    const redacted = redactForTrace({
      type: 'image',
      mimeType: 'image/png',
      data: 'x'.repeat(9000),
    }) as Record<string, unknown>
    expect(redacted.data).toBe('<base64 9000 chars>')
    expect(redacted.mimeType).toBe('image/png')
  })

  it('replaces audio data too', () => {
    const redacted = redactForTrace({ type: 'audio', data: 'y'.repeat(5000) }) as Record<
      string,
      unknown
    >
    expect(redacted.data).toBe('<base64 5000 chars>')
  })

  it('truncates oversized non-media strings', () => {
    expect(redactForTrace('z'.repeat(3000))).toBe('<string 3000 chars>')
    expect(redactForTrace('short')).toBe('short')
  })

  it('leaves small text content untouched', () => {
    const redacted = redactForTrace({ type: 'text', text: 'hello' }) as Record<string, unknown>
    expect(redacted.text).toBe('hello')
  })

  it('recurses through arrays and nested objects', () => {
    const redacted = redactForTrace({
      content: [
        { type: 'image', data: 'q'.repeat(4000) },
        { type: 'text', text: 'ok' },
      ],
    }) as { content: Array<Record<string, unknown>> }
    expect(redacted.content[0]!.data).toBe('<base64 4000 chars>')
    expect(redacted.content[1]!.text).toBe('ok')
  })

  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { name: 'root' }
    obj.self = obj
    expect(() => redactForTrace(obj)).not.toThrow()
    const redacted = redactForTrace(obj) as Record<string, unknown>
    expect(redacted.self).toBe('<circular>')
  })
})
