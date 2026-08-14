/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  resolveExtensionMcpServerRecord — variable substitution, trust / config
 *  gating, cross-extension name collisions, and bad-entry tolerance.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import { URI } from '@universe-editor/platform'
import {
  resolveExtensionMcpServerRecord,
  type IExtensionMcpResolveContext,
} from '../extensionMcpServers.js'

function makeExt(overrides: Partial<IExtensionDescriptionDto> = {}): IExtensionDescriptionDto {
  return {
    id: 'pub.ext',
    name: 'ext',
    activationEvents: [],
    contributes: {},
    hasMain: false,
    extensionLocation: URI.file('C:\\exts\\bridge'),
    extensionIsBuiltin: false,
    ...overrides,
  }
}

function makeCtx(
  overrides: Partial<IExtensionMcpResolveContext> = {},
): IExtensionMcpResolveContext {
  return {
    execPath: 'C:/app/editor.exe',
    isWorkspaceTrusted: true,
    getConfiguration: () => undefined,
    ...overrides,
  }
}

const BRIDGE_SERVERS = {
  'universe-editor': {
    command: '${execPath}',
    args: ['${extensionPath}/resources/bridge/bridge.mjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  },
}

describe('resolveExtensionMcpServerRecord', () => {
  it('substitutes ${execPath} / ${extensionPath} and normalizes backslashes', () => {
    const record = resolveExtensionMcpServerRecord(
      [makeExt({ contributes: { mcpServers: BRIDGE_SERVERS } })],
      makeCtx(),
    )
    expect(record['universe-editor']).toEqual({
      command: 'C:/app/editor.exe',
      args: ['C:/exts/bridge/resources/bridge/bridge.mjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('substitutes variables inside env values', () => {
    const record = resolveExtensionMcpServerRecord(
      [
        makeExt({
          contributes: {
            mcpServers: { s: { command: 'node', env: { ROOT: '${extensionPath}' } } },
          },
        }),
      ],
      makeCtx(),
    )
    expect(record.s).toMatchObject({ env: { ROOT: 'C:/exts/bridge' } })
  })

  it('keeps unknown ${...} variables verbatim and warns', () => {
    const warnings: string[] = []
    const record = resolveExtensionMcpServerRecord(
      [makeExt({ contributes: { mcpServers: { s: { command: '${mystery}/bin' } } } })],
      makeCtx(),
      (m) => warnings.push(m),
    )
    expect(record.s).toMatchObject({ command: '${mystery}/bin' })
    expect(warnings.some((w) => w.includes('${mystery}'))).toBe(true)
  })

  it('never emits type or whenConfiguration on the output entry', () => {
    const record = resolveExtensionMcpServerRecord(
      [
        makeExt({
          contributes: {
            mcpServers: { s: { command: 'node', whenConfiguration: 'my.flag' } },
          },
        }),
      ],
      makeCtx({ getConfiguration: () => true }),
    )
    expect(Object.keys(record.s as object)).toEqual(['command'])
  })

  describe('workspace trust gating', () => {
    const servers = { s: { command: 'node' } }

    it('skips a non-builtin extension whose support resolves to false when untrusted', () => {
      const record = resolveExtensionMcpServerRecord(
        [
          makeExt({
            contributes: { mcpServers: servers },
            untrustedWorkspaces: { supported: false, description: 'needs trust' },
          }),
        ],
        makeCtx({ isWorkspaceTrusted: false }),
      )
      expect(record).toEqual({})
    })

    it('a main extension declaring nothing defaults to false → skipped when untrusted', () => {
      const record = resolveExtensionMcpServerRecord(
        [makeExt({ contributes: { mcpServers: servers }, hasMain: true })],
        makeCtx({ isWorkspaceTrusted: false }),
      )
      expect(record).toEqual({})
    })

    it('injects limited-support extensions even when untrusted', () => {
      const record = resolveExtensionMcpServerRecord(
        [
          makeExt({
            contributes: { mcpServers: servers },
            untrustedWorkspaces: { supported: 'limited', description: 'partial' },
          }),
        ],
        makeCtx({ isWorkspaceTrusted: false }),
      )
      expect(Object.keys(record)).toEqual(['s'])
    })

    it('builtin extensions are exempt from the trust gate', () => {
      const record = resolveExtensionMcpServerRecord(
        [
          makeExt({
            contributes: { mcpServers: servers },
            untrustedWorkspaces: { supported: false, description: 'needs trust' },
            extensionIsBuiltin: true,
          }),
        ],
        makeCtx({ isWorkspaceTrusted: false }),
      )
      expect(Object.keys(record)).toEqual(['s'])
    })
  })

  describe('whenConfiguration gating', () => {
    const withGate = { s: { command: 'node', whenConfiguration: 'my.flag' } }

    it('skips the entry when the gate key resolves to false', () => {
      const record = resolveExtensionMcpServerRecord(
        [makeExt({ contributes: { mcpServers: withGate } })],
        makeCtx({ getConfiguration: (key) => (key === 'my.flag' ? false : undefined) }),
      )
      expect(record).toEqual({})
    })

    it.each([undefined, true, 'yes'])('injects when the gate key resolves to %s', (value) => {
      const record = resolveExtensionMcpServerRecord(
        [makeExt({ contributes: { mcpServers: withGate } })],
        makeCtx({ getConfiguration: () => value }),
      )
      expect(Object.keys(record)).toEqual(['s'])
    })
  })

  it('later extension wins a name collision, with a warning', () => {
    const warnings: string[] = []
    const record = resolveExtensionMcpServerRecord(
      [
        makeExt({ id: 'a.first', contributes: { mcpServers: { s: { command: 'first' } } } }),
        makeExt({ id: 'b.second', contributes: { mcpServers: { s: { command: 'second' } } } }),
      ],
      makeCtx(),
      (m) => warnings.push(m),
    )
    expect(record.s).toMatchObject({ command: 'second' })
    expect(warnings.some((w) => w.includes('a.first') && w.includes('b.second'))).toBe(true)
  })

  it('skips entries carrying a type (non-stdio) with a warning', () => {
    const warnings: string[] = []
    const record = resolveExtensionMcpServerRecord(
      [
        makeExt({
          contributes: {
            mcpServers: {
              remote: { type: 'http', url: 'https://x' } as never,
              ok: { command: 'node' },
            },
          },
        }),
      ],
      makeCtx(),
      (m) => warnings.push(m),
    )
    expect(Object.keys(record)).toEqual(['ok'])
    expect(warnings.some((w) => w.includes('non-stdio'))).toBe(true)
  })

  it('skips entries without a command, keeps valid siblings', () => {
    const warnings: string[] = []
    const record = resolveExtensionMcpServerRecord(
      [
        makeExt({
          contributes: {
            mcpServers: { broken: {} as never, ok: { command: 'node' } },
          },
        }),
      ],
      makeCtx(),
      (m) => warnings.push(m),
    )
    expect(Object.keys(record)).toEqual(['ok'])
    expect(warnings.some((w) => w.includes('requires "command"'))).toBe(true)
  })

  it('filters non-string args', () => {
    const record = resolveExtensionMcpServerRecord(
      [
        makeExt({
          contributes: {
            mcpServers: {
              a: { command: 'node', args: ['ok', 42, null] as never },
              b: { command: 'node' },
            },
          },
        }),
      ],
      makeCtx(),
    )
    expect(record.a).toEqual({ command: 'node', args: ['ok'] })
    expect(record.b).toEqual({ command: 'node' })
  })
})
