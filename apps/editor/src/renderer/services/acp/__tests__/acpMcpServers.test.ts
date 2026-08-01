/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpMcpServers.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  filterMcpServersByCapabilities,
  filterWireByNames,
  mcpServerRawToRecord,
  mcpServerTransport,
  mergeMcpServerDefinitions,
  mergeMcpServerRawLayers,
  mergeWireMcpServers,
  normalizeMcpServers,
  parseMcpJson,
  parseMcpToolName,
  readMcpServerDefinitions,
  readMcpServerDefinitionsLayered,
  resolveMcpServerSelection,
  validateMcpServerEntry,
  writeMcpServerEntry,
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

describe('readMcpServerDefinitions', () => {
  it('annotates entries with transport / disabled / source', () => {
    const defs = readMcpServerDefinitions(
      {
        fs: { command: 'node', args: [] },
        docs: { type: 'http', url: 'https://x', disabled: true },
      },
      'global',
    )
    expect(defs).toEqual([
      {
        name: 'fs',
        transport: 'stdio',
        disabled: false,
        source: 'global',
      },
      {
        name: 'docs',
        transport: 'http',
        disabled: true,
        source: 'global',
      },
    ])
  })

  it('only treats disabled === true as disabled', () => {
    const defs = readMcpServerDefinitions(
      { fs: { command: 'node', disabled: 1 as unknown as boolean } },
      'project',
    )
    expect(defs[0]!.disabled).toBe(false)
    expect(defs[0]!.source).toBe('project')
  })

  it('skips invalid entries with a warning, like normalizeMcpServers', () => {
    const onWarn = vi.fn()
    const defs = readMcpServerDefinitions({ bad: { url: 5 } }, 'global', onWarn)
    expect(defs).toEqual([])
    expect(onWarn).toHaveBeenCalledOnce()
  })
})

describe('parseMcpJson', () => {
  it('accepts the { mcpServers: {...} } envelope', () => {
    const raw = parseMcpJson('{"mcpServers":{"fs":{"command":"node"}}}')
    expect(raw).toEqual({ fs: { command: 'node' } })
  })

  it('accepts a bare server record', () => {
    const raw = parseMcpJson('{"fs":{"command":"node"}}')
    expect(raw).toEqual({ fs: { command: 'node' } })
  })

  it('returns {} and warns on broken JSON', () => {
    const onWarn = vi.fn()
    expect(parseMcpJson('{nope', onWarn)).toEqual({})
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('returns {} for non-record payloads', () => {
    expect(parseMcpJson('[]')).toEqual({})
    expect(parseMcpJson('"str"')).toEqual({})
  })
})

describe('mergeMcpServerDefinitions', () => {
  it('lets project entries override global ones by name', () => {
    const merged = mergeMcpServerDefinitions(
      [
        { name: 'fs', transport: 'stdio', disabled: false, source: 'global' as const },
        { name: 'docs', transport: 'http', disabled: false, source: 'global' as const },
      ],
      [{ name: 'fs', transport: 'stdio', disabled: true, source: 'project' as const }],
    )
    expect(merged).toEqual([
      { name: 'fs', transport: 'stdio', disabled: true, source: 'project' },
      { name: 'docs', transport: 'http', disabled: false, source: 'global' },
    ])
  })
})

describe('mergeWireMcpServers', () => {
  it('lets project wire entries replace global ones by name', () => {
    const globalFs = { name: 'fs', command: 'node', args: ['global'], env: [] }
    const projectFs = { name: 'fs', command: 'bun', args: ['project'], env: [] }
    const docs = { type: 'http' as const, name: 'docs', url: 'https://x', headers: [] }
    const merged = mergeWireMcpServers([globalFs, docs], [projectFs])
    expect(merged).toEqual([projectFs, docs])
  })
})

describe('resolveMcpServerSelection', () => {
  const pool = [
    { name: 'a', transport: 'stdio' as const, disabled: false, source: 'global' as const },
    { name: 'b', transport: 'stdio' as const, disabled: true, source: 'global' as const },
    { name: 'c', transport: 'http' as const, disabled: false, source: 'project' as const },
  ]

  it('null inherits every non-disabled pool entry', () => {
    const { enabledNames, staleNames } = resolveMcpServerSelection(pool, null)
    expect(enabledNames).toEqual(['a', 'c'])
    expect(staleNames).toEqual([])
  })

  it('an explicit list intersects the pool and may enable disabled entries', () => {
    const { enabledNames, staleNames } = resolveMcpServerSelection(pool, ['b', 'c'])
    expect(enabledNames).toEqual(['b', 'c'])
    expect(staleNames).toEqual([])
  })

  it('reports whitelisted names missing from the pool as stale', () => {
    const { enabledNames, staleNames } = resolveMcpServerSelection(pool, ['a', 'gone'])
    expect(enabledNames).toEqual(['a'])
    expect(staleNames).toEqual(['gone'])
  })

  it('an empty list disables everything', () => {
    const { enabledNames } = resolveMcpServerSelection(pool, [])
    expect(enabledNames).toEqual([])
  })
})

describe('filterWireByNames', () => {
  it('keeps only the named wire servers, preserving order', () => {
    const fs = { name: 'fs', command: 'node', args: [], env: [] }
    const docs = { type: 'http' as const, name: 'docs', url: 'https://x', headers: [] }
    const out = filterWireByNames([fs, docs], new Set(['docs']))
    expect(out).toEqual([docs])
  })
})

describe('mcpServerRawToRecord', () => {
  it('passes Record form through and converts the legacy array form', () => {
    expect(mcpServerRawToRecord({ fs: { command: 'node' } })).toEqual({ fs: { command: 'node' } })
    expect(mcpServerRawToRecord([{ name: 'fs', command: 'node' }, { command: 'x' }])).toEqual({
      fs: { name: 'fs', command: 'node' },
    })
  })

  it('degrades non-object input to an empty record', () => {
    expect(mcpServerRawToRecord(undefined)).toEqual({})
    expect(mcpServerRawToRecord('nope')).toEqual({})
  })
})

describe('mergeMcpServerRawLayers / readMcpServerDefinitionsLayered', () => {
  it('merges layers per server name, later layers winning same-named entries', () => {
    const merged = mergeMcpServerRawLayers([
      { source: 'global', raw: { fs: { command: 'user-fs' }, docs: { command: 'user-docs' } } },
      { source: 'project', raw: { fs: { command: 'ws-fs' } } },
    ])
    expect(merged).toEqual({
      fs: { command: 'ws-fs' },
      docs: { command: 'user-docs' },
    })
  })

  it('attributes each definition to the layer that won its name', () => {
    const defs = readMcpServerDefinitionsLayered([
      { source: 'global', raw: { fs: { command: 'user-fs' }, docs: { command: 'user-docs' } } },
      { source: 'project', raw: { fs: { command: 'ws-fs', disabled: true } } },
    ])
    expect(defs).toEqual([
      { name: 'fs', transport: 'stdio', disabled: true, source: 'project' },
      { name: 'docs', transport: 'stdio', disabled: false, source: 'global' },
    ])
  })

  it('a broken winning entry drops the name instead of falling back to the shadowed entry', () => {
    const warns: string[] = []
    const defs = readMcpServerDefinitionsLayered(
      [
        { source: 'global', raw: { fs: { command: 'user-fs' } } },
        { source: 'project', raw: { fs: { url: 'http://x', type: 'weird' } } },
      ],
      (m) => warns.push(m),
    )
    expect(defs).toEqual([])
    expect(warns.some((m) => m.includes('fs'))).toBe(true)
  })

  it('extension layer is lowest priority: a same-named user entry overrides it', () => {
    const defs = readMcpServerDefinitionsLayered([
      {
        source: 'extension',
        raw: { bridge: { command: '/app/editor' }, extra: { command: 'ext-extra' } },
      },
      { source: 'global', raw: { bridge: { command: 'user-bridge', disabled: true } } },
    ])
    expect(defs).toEqual([
      { name: 'bridge', transport: 'stdio', disabled: true, source: 'global' },
      { name: 'extra', transport: 'stdio', disabled: false, source: 'extension' },
    ])
  })
})

describe('validateMcpServerEntry', () => {
  it('reports valid entries with their transport', () => {
    expect(validateMcpServerEntry('fs', { command: 'node' })).toEqual({
      valid: true,
      transport: 'stdio',
    })
    expect(validateMcpServerEntry('d', { type: 'http', url: 'http://x' })).toEqual({
      valid: true,
      transport: 'http',
    })
  })

  it('reports the skip reason for invalid entries', () => {
    const out = validateMcpServerEntry('fs', { args: [] })
    expect(out.valid).toBe(false)
    if (!out.valid) expect(out.reason).toContain('command')
  })
})

describe('writeMcpServerEntry', () => {
  it('adds, replaces and removes entries without mutating the input', () => {
    const original = { fs: { command: 'node' } }
    const added = writeMcpServerEntry(original, 'docs', { type: 'http', url: 'http://x' })
    expect(added).toEqual({
      fs: { command: 'node' },
      docs: { type: 'http', url: 'http://x' },
    })
    expect(original).toEqual({ fs: { command: 'node' } })
    expect(writeMcpServerEntry(added, 'docs', undefined)).toEqual({ fs: { command: 'node' } })
  })

  it('normalizes the legacy array form to the Record form on write', () => {
    const out = writeMcpServerEntry([{ name: 'fs', command: 'node' }], 'fs', undefined)
    expect(out).toEqual({})
  })
})
