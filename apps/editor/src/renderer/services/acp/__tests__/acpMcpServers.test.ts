/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpMcpServers.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  filterMcpServersByCapabilities,
  mcpServerTransport,
  normalizeMcpServers,
  parseMcpToolName,
  withMcpServerEnv,
} from '../acpMcpServers.js'

describe('parseMcpToolName', () => {
  it('parses mcp__<server>__<tool>', () => {
    expect(parseMcpToolName('mcp__sqlite__query')).toEqual({ server: 'sqlite', tool: 'query' })
  })

  it('keeps __ inside the tool segment', () => {
    expect(parseMcpToolName('mcp__fs__read_file__raw')).toEqual({
      server: 'fs',
      tool: 'read_file__raw',
    })
  })

  it('returns undefined for non-MCP tool names', () => {
    expect(parseMcpToolName('Bash')).toBeUndefined()
    expect(parseMcpToolName('Read')).toBeUndefined()
  })

  it('returns undefined for malformed names', () => {
    expect(parseMcpToolName('mcp__')).toBeUndefined()
    expect(parseMcpToolName('mcp__server')).toBeUndefined()
    expect(parseMcpToolName('mcp__server__')).toBeUndefined()
    expect(parseMcpToolName('mcp____tool')).toBeUndefined()
  })
})

describe('mcpServerTransport', () => {
  it('reports stdio for entries without a type field', () => {
    expect(mcpServerTransport({ name: 'fs', command: 'node', args: [], env: [] })).toBe('stdio')
  })

  it('reports http/sse from the type field', () => {
    expect(mcpServerTransport({ type: 'http', name: 'd', url: 'http://x', headers: [] })).toBe(
      'http',
    )
    expect(mcpServerTransport({ type: 'sse', name: 'd', url: 'http://x', headers: [] })).toBe('sse')
  })
})

describe('normalizeMcpServers — Record form', () => {
  it('normalizes a stdio entry without a type field', () => {
    const out = normalizeMcpServers({
      fs: { command: 'npx', args: ['-y', 'server-fs', '.'], env: { TOKEN: 'abc' } },
    })
    expect(out).toEqual([
      {
        name: 'fs',
        command: 'npx',
        args: ['-y', 'server-fs', '.'],
        env: [{ name: 'TOKEN', value: 'abc' }],
      },
    ])
    // stdio MUST NOT carry a `type` field (agent detects stdio via !('type' in server))
    expect('type' in out[0]!).toBe(false)
  })

  it('treats an explicit type:"stdio" as stdio and strips the type field', () => {
    const out = normalizeMcpServers({ fs: { type: 'stdio', command: 'node', args: [] } })
    expect(out).toEqual([{ name: 'fs', command: 'node', args: [], env: [] }])
    expect('type' in out[0]!).toBe(false)
  })

  it('defaults missing args/env to empty arrays', () => {
    const out = normalizeMcpServers({ fs: { command: 'node' } })
    expect(out).toEqual([{ name: 'fs', command: 'node', args: [], env: [] }])
  })

  it('normalizes an http entry with headers Record', () => {
    const out = normalizeMcpServers({
      docs: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer t' } },
    })
    expect(out).toEqual([
      {
        type: 'http',
        name: 'docs',
        url: 'https://x',
        headers: [{ name: 'Authorization', value: 'Bearer t' }],
      },
    ])
  })

  it('normalizes an sse entry', () => {
    const out = normalizeMcpServers({ feed: { type: 'sse', url: 'https://y' } })
    expect(out).toEqual([{ type: 'sse', name: 'feed', url: 'https://y', headers: [] }])
  })

  it('skips a stdio entry missing command, keeps valid siblings', () => {
    const warn = vi.fn()
    const out = normalizeMcpServers({ bad: { args: [] }, good: { command: 'node' } }, warn)
    expect(out).toEqual([{ name: 'good', command: 'node', args: [], env: [] }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"bad"'))
  })

  it('skips an http entry missing url', () => {
    const warn = vi.fn()
    const out = normalizeMcpServers({ docs: { type: 'http' } }, warn)
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('url'))
  })

  it('skips experimental type:"acp" entries', () => {
    const warn = vi.fn()
    const out = normalizeMcpServers({ x: { type: 'acp', id: 'abc' } }, warn)
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('acp'))
  })

  it('skips unknown transport types', () => {
    const warn = vi.fn()
    const out = normalizeMcpServers({ x: { type: 'ftp', url: 'x' } }, warn)
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown transport'))
  })

  it('drops env entries whose value is not a string', () => {
    const out = normalizeMcpServers({ fs: { command: 'node', env: { A: 'ok', B: 5 } } })
    expect(out[0]!).toMatchObject({ env: [{ name: 'A', value: 'ok' }] })
  })

  it('filters non-string args', () => {
    const out = normalizeMcpServers({ fs: { command: 'node', args: ['a', 1, 'b'] } })
    expect(out[0]!).toMatchObject({ args: ['a', 'b'] })
  })
})

describe('normalizeMcpServers — legacy array form', () => {
  it('accepts the wire array shape and fills defaults', () => {
    const out = normalizeMcpServers([{ name: 'fs', command: 'node' }])
    expect(out).toEqual([{ name: 'fs', command: 'node', args: [], env: [] }])
  })

  it('accepts array env/headers already in pair form', () => {
    const out = normalizeMcpServers([
      { name: 'fs', command: 'node', args: [], env: [{ name: 'A', value: 'b' }] },
    ])
    expect(out[0]!).toMatchObject({ env: [{ name: 'A', value: 'b' }] })
  })

  it('skips array entries without a name', () => {
    const warn = vi.fn()
    const out = normalizeMcpServers([{ command: 'node' }], warn)
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('lets a later duplicate-name entry win', () => {
    const out = normalizeMcpServers([
      { name: 'fs', command: 'a' },
      { name: 'fs', command: 'b' },
    ])
    expect(out).toEqual([{ name: 'fs', command: 'b', args: [], env: [] }])
  })
})

describe('normalizeMcpServers — degenerate inputs', () => {
  it('returns [] for null / undefined', () => {
    expect(normalizeMcpServers(null)).toEqual([])
    expect(normalizeMcpServers(undefined)).toEqual([])
  })

  it('returns [] for primitives', () => {
    expect(normalizeMcpServers('nope')).toEqual([])
    expect(normalizeMcpServers(42)).toEqual([])
  })
})

describe('filterMcpServersByCapabilities', () => {
  const stdio = { name: 'fs', command: 'node', args: [], env: [] }
  const http = { type: 'http' as const, name: 'docs', url: 'https://x', headers: [] }
  const sse = { type: 'sse' as const, name: 'feed', url: 'https://y', headers: [] }

  it('always keeps stdio regardless of capabilities', () => {
    const { kept, dropped } = filterMcpServersByCapabilities([stdio], undefined)
    expect(kept).toEqual([stdio])
    expect(dropped).toEqual([])
  })

  it('drops http/sse when caps are undefined', () => {
    const { kept, dropped } = filterMcpServersByCapabilities([stdio, http, sse], undefined)
    expect(kept).toEqual([stdio])
    expect(dropped).toEqual([
      { name: 'docs', transport: 'http' },
      { name: 'feed', transport: 'sse' },
    ])
  })

  it('keeps http when the agent advertises http', () => {
    const { kept, dropped } = filterMcpServersByCapabilities([http, sse], { http: true })
    expect(kept).toEqual([http])
    expect(dropped).toEqual([{ name: 'feed', transport: 'sse' }])
  })

  it('keeps everything when both http and sse are advertised', () => {
    const { kept, dropped } = filterMcpServersByCapabilities([stdio, http, sse], {
      http: true,
      sse: true,
    })
    expect(kept).toEqual([stdio, http, sse])
    expect(dropped).toEqual([])
  })
})

describe('withMcpServerEnv', () => {
  const stdio = {
    name: 'universe-editor',
    command: 'node',
    args: ['bridge.mjs'],
    env: [{ name: 'EXISTING', value: '1' }],
  }

  it('merges env into the named stdio server without mutating the input', () => {
    const result = withMcpServerEnv([stdio], {
      'universe-editor': { UNIVERSE_EDITOR_MCP_PID: '1234' },
    })
    expect(result[0]).toEqual({
      ...stdio,
      env: [
        { name: 'EXISTING', value: '1' },
        { name: 'UNIVERSE_EDITOR_MCP_PID', value: '1234' },
      ],
    })
    expect(stdio.env).toEqual([{ name: 'EXISTING', value: '1' }])
  })

  it('overrides an existing env var of the same name', () => {
    const result = withMcpServerEnv([stdio], { 'universe-editor': { EXISTING: '2' } })
    expect(result[0]).toEqual({ ...stdio, env: [{ name: 'EXISTING', value: '2' }] })
  })

  it('warns and skips servers that are not configured', () => {
    const onWarn = vi.fn()
    const result = withMcpServerEnv([stdio], { missing: { X: '1' } }, onWarn)
    expect(result).toEqual([stdio])
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('warns and skips non-stdio servers', () => {
    const http = { type: 'http' as const, name: 'docs', url: 'https://x', headers: [] }
    const onWarn = vi.fn()
    const result = withMcpServerEnv([http], { docs: { X: '1' } }, onWarn)
    expect(result).toEqual([http])
    expect(onWarn).toHaveBeenCalledOnce()
  })
})
