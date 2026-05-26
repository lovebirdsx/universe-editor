/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpProtocolTracer.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { LogLevel, NullLogger } from '@universe-editor/platform'
import { OutputChannel } from '../../output/OutputService.js'
import { AcpProtocolTracer } from '../acpProtocolTracer.js'

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
})
