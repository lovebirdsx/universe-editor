/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/shared/deepLink.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { deepLinkFilePath, deepLinkToOpenerTarget, isDeepLink, parseDeepLink } from '../deepLink.js'

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

describe('deepLinkFilePath', () => {
  it('returns the path for a file link', () => {
    expect(deepLinkFilePath({ kind: 'file', path: '/a.ts' })).toBe('/a.ts')
  })

  it('returns undefined for a command link', () => {
    expect(deepLinkFilePath({ kind: 'command', id: 'x', query: '' })).toBeUndefined()
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
})
