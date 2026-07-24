/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/shared/deepLink.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  deepLinkFilePath,
  deepLinkToOpenerTarget,
  isDeepLink,
  parseAgentPromptOpenerTarget,
  parseDeepLink,
  resolveAgentDeepLinkCwd,
} from '../deepLink.js'

describe('isDeepLink', () => {
  it('matches the app protocol case-insensitively', () => {
    expect(isDeepLink('universe-editor://file/x')).toBe(true)
    expect(isDeepLink('Universe-Editor://file/x')).toBe(true)
  })

  it('rejects other schemes', () => {
    expect(isDeepLink('https://example.com')).toBe(false)
    expect(isDeepLink('/plain/path')).toBe(false)
  })
})

describe('parseDeepLink — file links', () => {
  it('parses a POSIX file path', () => {
    expect(parseDeepLink('universe-editor://file/home/u/a.ts')).toEqual({
      kind: 'file',
      path: '/home/u/a.ts',
    })
  })

  it('parses a Windows drive path (strips the leading slash URI.parse adds)', () => {
    expect(parseDeepLink('universe-editor://file/D:/repo/a.ts')).toEqual({
      kind: 'file',
      path: 'D:/repo/a.ts',
    })
  })

  it('parses a line and column suffix', () => {
    expect(parseDeepLink('universe-editor://file/D:/repo/a.ts:10:5')).toEqual({
      kind: 'file',
      path: 'D:/repo/a.ts',
      line: 10,
      col: 5,
    })
  })

  it('parses a line-only suffix', () => {
    expect(parseDeepLink('universe-editor://file/home/u/a.ts:42')).toEqual({
      kind: 'file',
      path: '/home/u/a.ts',
      line: 42,
    })
  })
})

describe('parseDeepLink — command links', () => {
  it('parses a command id and query', () => {
    expect(parseDeepLink('universe-editor://command/workbench.action.openSettings?%5B%5D')).toEqual(
      {
        kind: 'command',
        id: 'workbench.action.openSettings',
        query: '[]',
      },
    )
  })

  it('returns undefined for a non-app scheme or malformed link', () => {
    expect(parseDeepLink('https://example.com')).toBeUndefined()
    expect(parseDeepLink('universe-editor://unknown/x')).toBeUndefined()
    expect(parseDeepLink('universe-editor://command/')).toBeUndefined()
  })
})

describe('parseDeepLink — agent links', () => {
  it('parses an agent prompt link with auto-submit enabled by default', () => {
    expect(
      parseDeepLink('universe-editor://agent/new?prompt=Fix%20the%20selected%20quest'),
    ).toEqual({
      kind: 'agentPrompt',
      prompt: 'Fix the selected quest',
      autoSubmit: true,
    })
  })

  it('allows disabling auto-submit and selecting an agent', () => {
    expect(
      parseDeepLink(
        'universe-editor://agent/new?prompt=Review%20this&autoSubmit=false&agent=codex',
      ),
    ).toEqual({
      kind: 'agentPrompt',
      prompt: 'Review this',
      autoSubmit: false,
      agent: 'codex',
    })
  })

  it('parses an optional UE process pid', () => {
    expect(parseDeepLink('universe-editor://agent/new?prompt=Review%20this&pid=52352')).toEqual({
      kind: 'agentPrompt',
      prompt: 'Review this',
      autoSubmit: true,
      pid: 52352,
    })
  })

  it('parses an explicit session working directory', () => {
    expect(
      parseDeepLink(
        'universe-editor://agent/new?prompt=Review%20this&cwd=D%3A%2Frepo%2Fquest%20zone',
      ),
    ).toEqual({
      kind: 'agentPrompt',
      prompt: 'Review this',
      autoSubmit: true,
      cwd: 'D:/repo/quest zone',
    })
  })

  it('drops a blank cwd (treated as absent)', () => {
    expect(parseDeepLink('universe-editor://agent/new?prompt=Review%20this&cwd=%20%20')).toEqual({
      kind: 'agentPrompt',
      prompt: 'Review this',
      autoSubmit: true,
    })
  })

  it('rejects malformed agent links', () => {
    expect(parseDeepLink('universe-editor://agent/run?prompt=hi')).toBeUndefined()
    expect(parseDeepLink('universe-editor://agent/new')).toBeUndefined()
    expect(parseDeepLink('universe-editor://agent/new?prompt=%20%20')).toBeUndefined()
    expect(parseDeepLink('universe-editor://agent/new?prompt=hi&pid=abc')).toBeUndefined()
  })
})

describe('parseDeepLink — swarm links', () => {
  it('maps a swarm review link to the swarm.openReview command', () => {
    const target = parseDeepLink('universe-editor://swarm/review/1234')
    expect(target).toEqual({
      kind: 'command',
      id: 'swarm.openReview',
      query: encodeURIComponent(JSON.stringify('1234')),
    })
    // Round-trips into a command opener target carrying the id as a JSON arg.
    expect(deepLinkToOpenerTarget(target!)).toBe(
      `command:swarm.openReview?${encodeURIComponent('"1234"')}`,
    )
  })

  it('returns undefined for a malformed swarm link', () => {
    expect(parseDeepLink('universe-editor://swarm/review/')).toBeUndefined()
    expect(parseDeepLink('universe-editor://swarm/unknown/1')).toBeUndefined()
  })
})

describe('deepLinkFilePath', () => {
  it('returns the path for a file link', () => {
    expect(deepLinkFilePath({ kind: 'file', path: '/a.ts' })).toBe('/a.ts')
  })

  it('returns undefined for a command link', () => {
    expect(deepLinkFilePath({ kind: 'command', id: 'x', query: '' })).toBeUndefined()
  })

  it('returns undefined for an agent link', () => {
    expect(
      deepLinkFilePath({ kind: 'agentPrompt', prompt: 'hello', autoSubmit: true }),
    ).toBeUndefined()
  })
})

describe('deepLinkToOpenerTarget', () => {
  it('renders a file target with a location suffix', () => {
    expect(deepLinkToOpenerTarget({ kind: 'file', path: 'D:/a.ts', line: 3, col: 7 })).toBe(
      'D:/a.ts:3:7',
    )
  })

  it('renders a file target with a line-only suffix', () => {
    expect(deepLinkToOpenerTarget({ kind: 'file', path: '/a.ts', line: 3 })).toBe('/a.ts:3')
  })

  it('renders a bare file target', () => {
    expect(deepLinkToOpenerTarget({ kind: 'file', path: '/a.ts' })).toBe('/a.ts')
  })

  it('renders a command target', () => {
    expect(deepLinkToOpenerTarget({ kind: 'command', id: 'foo', query: '%5B1%5D' })).toBe(
      'command:foo?%5B1%5D',
    )
    expect(deepLinkToOpenerTarget({ kind: 'command', id: 'foo', query: '' })).toBe('command:foo')
  })

  it('renders an agent prompt target', () => {
    expect(
      deepLinkToOpenerTarget({
        kind: 'agentPrompt',
        prompt: 'Review this',
        autoSubmit: false,
        agent: 'codex',
        pid: 52352,
      }),
    ).toBe('agent:new?prompt=Review+this&autoSubmit=false&agent=codex&pid=52352')
  })

  it('round-trips an agent prompt target with a cwd', () => {
    const rendered = deepLinkToOpenerTarget({
      kind: 'agentPrompt',
      prompt: 'Review this',
      autoSubmit: true,
      cwd: 'D:/repo/quest zone',
    })
    expect(rendered).toBe(
      `agent:new?prompt=Review+this&cwd=${encodeURIComponent('D:/repo/quest zone').replace(/%20/g, '+')}`,
    )
    expect(parseAgentPromptOpenerTarget(rendered)).toEqual({
      kind: 'agentPrompt',
      prompt: 'Review this',
      autoSubmit: true,
      cwd: 'D:/repo/quest zone',
    })
  })
})

describe('parseAgentPromptOpenerTarget', () => {
  it('parses the renderer-facing agent opener target', () => {
    expect(parseAgentPromptOpenerTarget('agent:new?prompt=Review+this&agent=codex')).toEqual({
      kind: 'agentPrompt',
      prompt: 'Review this',
      autoSubmit: true,
      agent: 'codex',
    })
  })

  it('allows disabling auto-submit in the renderer-facing target', () => {
    expect(parseAgentPromptOpenerTarget('agent:new?prompt=Review+this&autoSubmit=false')).toEqual({
      kind: 'agentPrompt',
      prompt: 'Review this',
      autoSubmit: false,
    })
  })

  it('parses a renderer-facing pid', () => {
    expect(parseAgentPromptOpenerTarget('agent:new?prompt=Review+this&pid=52352')).toEqual({
      kind: 'agentPrompt',
      prompt: 'Review this',
      autoSubmit: true,
      pid: 52352,
    })
  })

  it('rejects non-agent or malformed opener targets', () => {
    expect(parseAgentPromptOpenerTarget('command:foo')).toBeUndefined()
    expect(parseAgentPromptOpenerTarget('agent:new')).toBeUndefined()
    expect(parseAgentPromptOpenerTarget('agent:new?prompt=%20')).toBeUndefined()
    expect(parseAgentPromptOpenerTarget('agent:new?prompt=hi&pid=abc')).toBeUndefined()
  })
})

describe('resolveAgentDeepLinkCwd', () => {
  it('falls back to the home directory when cwd is absent or blank', () => {
    expect(resolveAgentDeepLinkCwd(undefined, '/home/u')).toBe('/home/u')
    expect(resolveAgentDeepLinkCwd('   ', '/home/u')).toBe('/home/u')
  })

  it('keeps an explicit cwd verbatim', () => {
    expect(resolveAgentDeepLinkCwd('D:/repo/quest zone', '/home/u')).toBe('D:/repo/quest zone')
  })
})
