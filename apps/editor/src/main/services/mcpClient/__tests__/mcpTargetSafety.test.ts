/*---------------------------------------------------------------------------------------------
 *  Tests for the MCP client's log/diagnostic redaction.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  DiagnosticTail,
  MAX_DIAGNOSTIC_LINE_CHARS,
  redactTargetForLog,
  stripSecretLike,
} from '../mcpTargetSafety.js'

describe('redactTargetForLog', () => {
  it('keeps the stdio command but only the count of args', () => {
    expect(
      redactTargetForLog({ kind: 'stdio', command: 'npx', args: ['-y', 'srv', '--token=abc'] }),
    ).toEqual({ kind: 'stdio', command: 'npx', argCount: 3 })
  })

  it('keeps only the origin for http / sse — path and query are dropped', () => {
    expect(
      redactTargetForLog({ kind: 'http', url: 'https://gallery.example.com/mcp?api_key=ak-1' }),
    ).toEqual({ kind: 'http', origin: 'https://gallery.example.com' })
    expect(redactTargetForLog({ kind: 'sse', url: 'https://swarm.example.com/sse' })).toEqual({
      kind: 'sse',
      origin: 'https://swarm.example.com',
    })
  })

  it('never throws on an unparsable url', () => {
    expect(redactTargetForLog({ kind: 'http', url: 'not a url' })).toEqual({
      kind: 'http',
      origin: '<unparsable-url>',
    })
  })

  it('never carries an env key or value', () => {
    const redacted = JSON.stringify(
      redactTargetForLog({ kind: 'stdio', command: 'node', args: [], env: { TOKEN: 'ak-1' } }),
    )
    expect(redacted).not.toContain('ak-1')
    expect(redacted).not.toContain('TOKEN')
  })
})

describe('stripSecretLike', () => {
  it('masks values assigned to credential-ish keys', () => {
    expect(stripSecretLike('API_KEY=ak-1')).toBe('API_KEY=••••')
    expect(stripSecretLike('api-key: ak-1')).toBe('api-key: ••••')
    expect(stripSecretLike('password = hunter2')).toBe('password = ••••')
    expect(stripSecretLike('cookie=session%3Dabc')).toBe('cookie=••••')
    expect(stripSecretLike('credential: abc')).toBe('credential: ••••')
    // The renderer masks the same names via the shared list; `auth` alone used to
    // be masked here but not there, which is exactly the drift the shared list kills.
    expect(stripSecretLike('auth=ak-1')).toBe('auth=••••')
  })

  it('swallows the auth scheme word so "Bearer <token>" leaves nothing behind', () => {
    expect(stripSecretLike('Authorization: Bearer abc123')).toBe('Authorization: ••••')
    expect(stripSecretLike('authorization: basic dXNlcg==')).toBe('authorization: ••••')
  })

  it('masks credentials inside a JSON config dump', () => {
    expect(stripSecretLike('config: {"token":"super-secret-value","mode":"debug"}')).toBe(
      'config: {"token":••••,"mode":"debug"}',
    )
  })

  it('masks query-string credentials on a url line', () => {
    expect(stripSecretLike('GET https://gallery.example.com/mcp?api_key=ak-1&page=2')).toBe(
      'GET https://gallery.example.com/mcp?api_key=••••&page=2',
    )
  })

  it('masks a bare bearer token with no key in front of it', () => {
    expect(stripSecretLike('sent Bearer abc123 to server')).toBe('sent Bearer •••• to server')
  })

  it('leaves innocent lines untouched', () => {
    const line = 'mcp-debug-fixture starting (pid 42)'
    expect(stripSecretLike(line)).toBe(line)
  })
})

describe('DiagnosticTail', () => {
  it('keeps only the newest lines up to the cap', () => {
    const tail = new DiagnosticTail(3)
    tail.push('one\ntwo\n')
    tail.push('three\nfour')
    expect(tail.toString()).toBe('two\nthree\nfour')
    expect(tail.size).toBe(3)
  })

  it('masks on the way in and handles CRLF + blank lines', () => {
    const tail = new DiagnosticTail(5)
    tail.push('token=ak-1\r\n\r\nready\r\n')
    expect(tail.toString()).toBe('token=••••\nready')
  })

  it('reports emptiness instead of a stray newline', () => {
    expect(new DiagnosticTail(3).toString()).toBe('')
  })

  it('clips a single huge line instead of keeping it whole', () => {
    const tail = new DiagnosticTail(3)
    tail.push(`${'x'.repeat(MAX_DIAGNOSTIC_LINE_CHARS * 3)}token=ak-1`)
    expect(tail.toString()).toHaveLength(MAX_DIAGNOSTIC_LINE_CHARS + 1)
    expect(tail.toString().endsWith('…')).toBe(true)
  })
})
