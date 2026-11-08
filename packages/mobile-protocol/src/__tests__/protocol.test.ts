import { describe, expect, it } from 'vitest'
import type { ClientFrame, ParseErrorCode, Result, ServerFrame } from '../index.js'
import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_TOKEN_LENGTH,
  MOBILE_CLOSE_CODES,
  MOBILE_PROTOCOL_VERSION,
  isMobileErrorCode,
  parseClientFrame,
  parsePairRequest,
  parseServerFrame,
  serializeFrame,
} from '../index.js'

function errorCode<T>(result: Result<T>): ParseErrorCode | undefined {
  return result.ok ? undefined : result.error.code
}

function helloJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'hello',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    token: 'device-token',
    clientVersion: '0.1.0',
    capabilities: [],
    ...overrides,
  })
}

function helloOkJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'hello_ok',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    serverVersion: '0.1.0',
    deviceId: 'device-1',
    serverTime: 1_700_000_000_000,
    capabilities: [],
    ...overrides,
  })
}

describe('parseClientFrame', () => {
  it('parses hello', () => {
    const payload = {
      type: 'hello',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      token: 'device-token',
      clientVersion: '0.1.0',
      capabilities: ['inbox', 'push'],
    }
    expect(parseClientFrame(JSON.stringify(payload))).toStrictEqual({ ok: true, value: payload })
  })

  it('parses ping', () => {
    expect(parseClientFrame('{"type":"ping","t":42}')).toStrictEqual({
      ok: true,
      value: { type: 'ping', t: 42 },
    })
  })

  it('parses subscribe_inbox with and without afterSeq', () => {
    expect(parseClientFrame('{"type":"subscribe_inbox"}')).toStrictEqual({
      ok: true,
      value: { type: 'subscribe_inbox' },
    })
    expect(parseClientFrame('{"type":"subscribe_inbox","afterSeq":0}')).toStrictEqual({
      ok: true,
      value: { type: 'subscribe_inbox', afterSeq: 0 },
    })
  })

  it('parses unsubscribe_inbox', () => {
    expect(parseClientFrame('{"type":"unsubscribe_inbox"}')).toStrictEqual({
      ok: true,
      value: { type: 'unsubscribe_inbox' },
    })
  })

  it('rejects non-JSON and non-object payloads', () => {
    expect(errorCode(parseClientFrame('not json'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('[]'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('null'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('42'))).toBe('bad_request')
  })

  it('rejects missing and unknown frame types', () => {
    expect(errorCode(parseClientFrame('{}'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('{"type":42}'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('{"type":"unknown"}'))).toBe('bad_request')
  })

  it('reports protocol mismatch separately from malformed fields', () => {
    expect(errorCode(parseClientFrame(helloJson({ protocolVersion: 2 })))).toBe('protocol_mismatch')
    expect(errorCode(parseClientFrame(helloJson({ protocolVersion: '1' })))).toBe('bad_request')
    expect(errorCode(parseClientFrame(helloJson({ protocolVersion: -1 })))).toBe('bad_request')
  })

  it('enforces hello string limits', () => {
    expect(errorCode(parseClientFrame(helloJson({ token: '' })))).toBe('bad_request')
    expect(
      errorCode(parseClientFrame(helloJson({ token: 'x'.repeat(MAX_TOKEN_LENGTH + 1) }))),
    ).toBe('bad_request')
    expect(errorCode(parseClientFrame(helloJson({ clientVersion: 'x'.repeat(65) })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseClientFrame(helloJson({ clientVersion: 1 })))).toBe('bad_request')
  })

  it('enforces hello capabilities', () => {
    expect(errorCode(parseClientFrame(helloJson({ capabilities: 'inbox' })))).toBe('bad_request')
    expect(errorCode(parseClientFrame(helloJson({ capabilities: [1] })))).toBe('bad_request')
    expect(
      errorCode(
        parseClientFrame(helloJson({ capabilities: Array.from({ length: 33 }, () => 'x') })),
      ),
    ).toBe('bad_request')
  })

  it('validates ping and subscribe_inbox fields', () => {
    expect(errorCode(parseClientFrame('{"type":"ping","t":"1"}'))).toBe('bad_request')
    expect(errorCode(parseClientFrame('{"type":"subscribe_inbox","afterSeq":-1}'))).toBe(
      'bad_request',
    )
    expect(errorCode(parseClientFrame('{"type":"subscribe_inbox","afterSeq":1.5}'))).toBe(
      'bad_request',
    )
    expect(errorCode(parseClientFrame('{"type":"subscribe_inbox","afterSeq":"1"}'))).toBe(
      'bad_request',
    )
  })

  it('rejects frames larger than the client limit', () => {
    expect(errorCode(parseClientFrame('x'.repeat(MAX_CLIENT_FRAME_BYTES + 1)))).toBe('bad_request')
  })
})

describe('parseServerFrame', () => {
  it('parses hello_ok', () => {
    const payload = {
      type: 'hello_ok',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      serverVersion: '0.1.0',
      deviceId: 'device-1',
      serverTime: 1_700_000_000_000,
      capabilities: ['inbox'],
    }
    expect(parseServerFrame(JSON.stringify(payload))).toStrictEqual({ ok: true, value: payload })
  })

  it('parses pong and device_revoked', () => {
    expect(parseServerFrame('{"type":"pong","t":42}')).toStrictEqual({
      ok: true,
      value: { type: 'pong', t: 42 },
    })
    expect(parseServerFrame('{"type":"device_revoked"}')).toStrictEqual({
      ok: true,
      value: { type: 'device_revoked' },
    })
  })

  it('parses inbox_snapshot with empty and populated sessions', () => {
    expect(parseServerFrame('{"type":"inbox_snapshot","seq":0,"sessions":[]}')).toStrictEqual({
      ok: true,
      value: { type: 'inbox_snapshot', seq: 0, sessions: [] },
    })

    const withoutDurable = {
      ref: { windowId: 3, localId: 'local-1' },
      agentId: 'claude',
      title: 'Fix the tests',
      bucket: 'input_needed',
      workspaceName: 'universe-editor',
      updatedAt: 1_700_000_000_000,
    }
    const withDurable = {
      ...withoutDurable,
      ref: { windowId: 3, localId: 'local-1', durableId: 'durable-1' },
      bucket: 'in_progress',
    }
    const frame = { type: 'inbox_snapshot', seq: 7, sessions: [withoutDurable, withDurable] }
    expect(parseServerFrame(JSON.stringify(frame))).toStrictEqual({ ok: true, value: frame })
  })

  it('parses server_error', () => {
    const payload = {
      type: 'server_error',
      code: 'stale_request',
      message: 'request is stale',
      retryable: false,
    }
    expect(parseServerFrame(JSON.stringify(payload))).toStrictEqual({ ok: true, value: payload })
  })

  it('reports server protocol mismatch', () => {
    expect(errorCode(parseServerFrame(helloOkJson({ protocolVersion: 2 })))).toBe(
      'protocol_mismatch',
    )
    expect(errorCode(parseServerFrame(helloOkJson({ protocolVersion: '1' })))).toBe('bad_request')
  })

  it('rejects malformed hello_ok fields', () => {
    expect(errorCode(parseServerFrame(helloOkJson({ serverVersion: 'x'.repeat(65) })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(helloOkJson({ deviceId: '' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(helloOkJson({ serverTime: 'now' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(helloOkJson({ capabilities: [1] })))).toBe('bad_request')
  })

  it('rejects malformed pong and snapshots', () => {
    expect(errorCode(parseServerFrame('{"type":"pong","t":"1"}'))).toBe('bad_request')
    expect(errorCode(parseServerFrame('{"type":"inbox_snapshot","seq":-1,"sessions":[]}'))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame('{"type":"inbox_snapshot","seq":0}'))).toBe('bad_request')
    expect(errorCode(parseServerFrame('{"type":"inbox_snapshot","seq":0,"sessions":[1]}'))).toBe(
      'bad_request',
    )
  })

  it('validates session summary fields', () => {
    const summary = {
      ref: { windowId: 3, localId: 'local-1' },
      agentId: 'claude',
      title: 'Fix the tests',
      bucket: 'in_progress',
      workspaceName: 'universe-editor',
      updatedAt: 1_700_000_000_000,
    }
    const withSummary = (overrides: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'inbox_snapshot',
        seq: 1,
        sessions: [{ ...summary, ...overrides }],
      })

    expect(errorCode(parseServerFrame(withSummary({ bucket: 'unknown' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ updatedAt: 'now' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ agentId: '' })))).toBe('bad_request')
    expect(errorCode(parseServerFrame(withSummary({ ref: { windowId: -1, localId: 'x' } })))).toBe(
      'bad_request',
    )
    expect(errorCode(parseServerFrame(withSummary({ ref: { windowId: 1, localId: '' } })))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parseServerFrame(withSummary({ ref: { windowId: 1, localId: 'x', durableId: 5 } })),
      ),
    ).toBe('bad_request')
  })

  it('rejects malformed server_error frames and unknown types', () => {
    expect(
      errorCode(
        parseServerFrame('{"type":"server_error","code":"nope","message":"x","retryable":false}'),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(
        parseServerFrame(
          '{"type":"server_error","code":"internal","message":"x","retryable":"no"}',
        ),
      ),
    ).toBe('bad_request')
    expect(errorCode(parseServerFrame('{"type":"unknown"}'))).toBe('bad_request')
    expect(errorCode(parseServerFrame('[]'))).toBe('bad_request')
  })
})

describe('serializeFrame', () => {
  it('round-trips client and server frames', () => {
    const clientFrame: ClientFrame = { type: 'ping', t: 42 }
    expect(parseClientFrame(serializeFrame(clientFrame))).toStrictEqual({
      ok: true,
      value: clientFrame,
    })
    const serverFrame: ServerFrame = { type: 'pong', t: 42 }
    expect(parseServerFrame(serializeFrame(serverFrame))).toStrictEqual({
      ok: true,
      value: serverFrame,
    })
  })
})

describe('parsePairRequest', () => {
  it('normalizes the code and accepts known platforms', () => {
    expect(
      parsePairRequest({ code: ' abcd-2345 ', deviceName: 'Pixel', platform: 'android' }),
    ).toStrictEqual({
      ok: true,
      value: { code: 'ABCD2345', deviceName: 'Pixel', platform: 'android' },
    })
    expect(
      parsePairRequest({ code: 'ABCD2345', deviceName: 'iPhone', platform: 'ios' }),
    ).toStrictEqual({
      ok: true,
      value: { code: 'ABCD2345', deviceName: 'iPhone', platform: 'ios' },
    })
  })

  it('rejects non-objects and malformed fields', () => {
    expect(errorCode(parsePairRequest(null))).toBe('bad_request')
    expect(errorCode(parsePairRequest([]))).toBe('bad_request')
    expect(errorCode(parsePairRequest('pair'))).toBe('bad_request')
    expect(errorCode(parsePairRequest({}))).toBe('bad_request')
    expect(errorCode(parsePairRequest({ code: 42, deviceName: 'Pixel', platform: 'ios' }))).toBe(
      'bad_request',
    )
    expect(
      errorCode(parsePairRequest({ code: 'ABCD234', deviceName: 'Pixel', platform: 'ios' })),
    ).toBe('bad_request')
    expect(
      errorCode(parsePairRequest({ code: 'ABCD23O5', deviceName: 'Pixel', platform: 'ios' })),
    ).toBe('bad_request')
  })

  it('enforces deviceName and platform limits', () => {
    expect(errorCode(parsePairRequest({ code: 'ABCD2345', deviceName: '', platform: 'ios' }))).toBe(
      'bad_request',
    )
    expect(
      errorCode(
        parsePairRequest({
          code: 'ABCD2345',
          deviceName: 'x'.repeat(65),
          platform: 'ios',
        }),
      ),
    ).toBe('bad_request')
    expect(
      errorCode(parsePairRequest({ code: 'ABCD2345', deviceName: 'Pixel', platform: 'windows' })),
    ).toBe('bad_request')
    expect(
      errorCode(parsePairRequest({ code: 'ABCD2345', deviceName: 'Pixel', platform: 1 })),
    ).toBe('bad_request')
  })
})

describe('errors and close codes', () => {
  it('recognizes known error codes', () => {
    expect(isMobileErrorCode('unauthorized')).toBe(true)
    expect(isMobileErrorCode('protocol_mismatch')).toBe(true)
    expect(isMobileErrorCode('nope')).toBe(false)
    expect(isMobileErrorCode(1)).toBe(false)
  })

  it('uses private WebSocket close codes', () => {
    expect(MOBILE_CLOSE_CODES).toStrictEqual({
      PROTOCOL_MISMATCH: 4400,
      UNAUTHORIZED: 4401,
      REVOKED: 4403,
      HELLO_TIMEOUT: 4408,
    })
  })
})
