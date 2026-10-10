/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/mcp/mcpDebugModel.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  buildConfirmDetail,
  buildParamsSkeleton,
  describeCallError,
  describeTarget,
  parseParamsText,
  prettyJson,
  summarizeParamsForDialog,
} from '../mcpDebugModel.js'

describe('prettyJson', () => {
  it('indents objects and keeps scalars', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(prettyJson('x')).toBe('"x"')
    expect(prettyJson(3)).toBe('3')
  })

  it('names the two shapes JSON.stringify returns undefined for', () => {
    expect(prettyJson(undefined)).toBe('undefined')
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(prettyJson(cyclic)).toBe('<unserializable>')
  })
})

describe('summarizeParamsForDialog masking', () => {
  it.each([
    ['apiKey'],
    ['api_key'],
    ['apikey'],
    ['password'],
    ['passphrase'],
    ['secret'],
    ['token'],
    ['authorization'],
    ['Authorization'],
    ['cookie'],
    ['credential'],
    ['bearer'],
    ['auth'],
  ])('masks the value beside a %s key', (key) => {
    expect(summarizeParamsForDialog({ [key]: 'super-secret-value' })).toContain('••••')
    expect(summarizeParamsForDialog({ [key]: 'super-secret-value' })).not.toContain(
      'super-secret-value',
    )
  })

  it('masks nested keys, including inside arrays', () => {
    const text = summarizeParamsForDialog({
      headers: { authorization: 'Bearer sk-live' },
      servers: [{ name: 'ok', token: 'nope' }],
    })
    expect(text).not.toContain('sk-live')
    expect(text).not.toContain('nope')
    expect(text).toContain('"name": "ok"')
  })

  it('over-matches on purpose: a key merely containing a secret word is masked too', () => {
    // Mirroring the main-side rule matters more than precision — a debugger that
    // masked different things than the log redactor could not be reasoned about.
    // `author` is collateral from the bare `auth` alternative, and that is the deal:
    // an over-masked summary is recoverable, a leaked token is not.
    const text = summarizeParamsForDialog({ tokens: 'a', apiVersion: 'v1', author: 'me' })
    expect(text).toContain('"tokens": "••••"')
    expect(text).toContain('"apiVersion": "v1"')
    expect(text).toContain('"author": "••••"')
  })

  it('keeps non-string values as-is', () => {
    const text = summarizeParamsForDialog({ n: 1, b: true, nil: null, arr: [1, 2] })
    expect(text).toContain('"n": 1')
    expect(text).toContain('"b": true')
    expect(text).toContain('"nil": null')
    expect(text).toContain('"arr": [')
  })

  it('replaces long strings with their length so a pasted blob cannot flood the dialog', () => {
    const text = summarizeParamsForDialog({ body: 'x'.repeat(500) })
    expect(text).toContain('"<string 500 chars>"')
  })

  it('caps depth rather than recursing forever', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 20; i++) deep = { child: deep }
    expect(summarizeParamsForDialog(deep)).toContain('<max depth>')
  })

  it('truncates the rendered text and says how much is missing', () => {
    // Many short values: a single long one would be elided to `<string N chars>`
    // first and never reach the truncation branch.
    const params: Record<string, string> = {}
    for (let i = 0; i < 40; i++) params[`k${i}`] = 'value'
    const text = summarizeParamsForDialog(params, 40)
    expect(text).toMatch(/\n… \(\d+ more characters\)$/)
    expect(text.split('\n')[0]?.length).toBeLessThanOrEqual(40)
    expect(summarizeParamsForDialog({ k: 'v' }, 40)).not.toContain('more characters')
  })
})

describe('buildConfirmDetail', () => {
  it('names the server, the transport, the tool and the masked params', () => {
    const detail = buildConfirmDetail({
      serverName: 'fs',
      transport: 'stdio',
      tool: 'read_file',
      params: { path: '/tmp/a', apiKey: 'sk-live' },
    })
    expect(detail.split('\n')[0]).toBe('Server:   fs (stdio)')
    expect(detail).toContain('Tool:     read_file')
    expect(detail).toContain('"path": "/tmp/a"')
    expect(detail).not.toContain('sk-live')
  })
})

describe('describeTarget', () => {
  it('describes a stdio target by command and arg count only', () => {
    expect(describeTarget({ kind: 'stdio', command: 'node', args: ['server.js', '--x'] })).toBe(
      'stdio: node (2 args)',
    )
    expect(describeTarget({ kind: 'stdio', command: 'node', args: [] })).toBe(
      'stdio: node (0 args)',
    )
    expect(describeTarget({ kind: 'stdio', command: 'node', args: ['a'] })).toBe(
      'stdio: node (1 arg)',
    )
  })

  it('describes an http target by origin, dropping path and query', () => {
    expect(describeTarget({ kind: 'http', url: 'https://mcp.example.com/rpc?api_key=k' })).toBe(
      'http: https://mcp.example.com',
    )
    expect(describeTarget({ kind: 'sse', url: 'https://mcp.example.com/events' })).toBe(
      'sse: https://mcp.example.com',
    )
  })

  it('does not throw on an unparsable url', () => {
    expect(describeTarget({ kind: 'http', url: 'not a url' })).toBe('http: <unparsable-url>')
  })
})

describe('parseParamsText', () => {
  it('treats blank input as no arguments', () => {
    expect(parseParamsText('')).toEqual({ ok: true, value: {} })
    expect(parseParamsText('   \n ')).toEqual({ ok: true, value: {} })
  })

  it('parses an object', () => {
    expect(parseParamsText('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('reports the JSON error message verbatim', () => {
    const result = parseParamsText('{')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
  })

  it.each(['[]', '[1]', 'null', '3', '"text"', 'true'])(
    'rejects %s — arguments are always an object',
    (text) => {
      const result = parseParamsText(text)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain('JSON object')
    },
  )
})

describe('buildParamsSkeleton', () => {
  it('seeds each declared property with a placeholder of its type', () => {
    const skeleton = JSON.parse(
      buildParamsSkeleton({
        type: 'object',
        properties: {
          text: { type: 'string' },
          count: { type: 'integer' },
          ratio: { type: 'number' },
          verbose: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
          nested: { type: 'object', properties: { inner: { type: 'string' } } },
        },
      }),
    )
    expect(skeleton).toEqual({
      text: '',
      count: 0,
      ratio: 0,
      verbose: false,
      tags: [],
      nested: { inner: '' },
    })
  })

  it('prefers the first enum entry, then anyOf / oneOf branches', () => {
    expect(JSON.parse(buildParamsSkeleton({ type: 'string', enum: ['a', 'b'] }))).toBe('a')
    expect(JSON.parse(buildParamsSkeleton({ anyOf: [{ type: 'number' }] }))).toBe(0)
    expect(JSON.parse(buildParamsSkeleton({ oneOf: [{ type: 'boolean' }] }))).toBe(false)
  })

  it('falls back to null for a schema it cannot read', () => {
    expect(buildParamsSkeleton(undefined)).toBe('null')
    expect(buildParamsSkeleton({})).toBe('null')
    expect(buildParamsSkeleton('nonsense')).toBe('null')
  })

  it('does not blow up on a self-referential schema', () => {
    const schema: Record<string, unknown> = { type: 'object', properties: {} }
    ;(schema['properties'] as Record<string, unknown>)['self'] = schema
    expect(() => buildParamsSkeleton(schema)).not.toThrow()
  })
})

describe('describeCallError', () => {
  it('explains the auth code instead of leaking it', () => {
    expect(describeCallError({ code: 'MCP_NEEDS_AUTH', message: 'raw' })).not.toContain('raw')
    expect(describeCallError({ code: 'MCP_NEEDS_AUTH' })).toContain('login')
  })

  it('prefixes protocol errors', () => {
    expect(describeCallError({ code: 'MCP_PROTOCOL_ERROR', message: 'bad frame' })).toContain(
      'bad frame',
    )
  })

  it('reports a server refusal as the server’s own words, not a protocol violation', () => {
    const text = describeCallError({
      code: 'MCP_SERVER_ERROR',
      message: 'MCP error -32602: Unknown tool: read_file',
    })
    expect(text).toContain('Unknown tool: read_file')
    expect(text).toContain('rejected')
    expect(text).not.toContain('protocol')
  })

  it('passes transport failures through, and survives a bare throw', () => {
    expect(describeCallError({ code: 'MCP_SPAWN_FAILED', message: 'ENOENT' })).toBe('ENOENT')
    expect(describeCallError(new Error('socket closed'))).toBe('socket closed')
    expect(describeCallError(undefined)).toContain('unknown')
  })
})
