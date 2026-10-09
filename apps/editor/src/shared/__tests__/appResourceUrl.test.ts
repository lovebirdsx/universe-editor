/*---------------------------------------------------------------------------------------------
 *  Tests for the `universe-app://root/_resource_/…` URL codec — both directions must
 *  be exact inverses, because a preview/webview URL that round-trips lossily becomes
 *  a URI pointing at a file that doesn't exist.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { resourceUrlToFsPath, toResourceUrl } from '../appResourceUrl.js'

describe('toResourceUrl', () => {
  it('encodes a windows drive path with a raw colon (URI.toString form)', () => {
    expect(toResourceUrl('F:\\test\\md\\a.svg')).toBe(
      'universe-app://root/_resource_/F%3A/test/md/a.svg',
    )
  })

  it('encodes a posix absolute path without doubling the slash', () => {
    expect(toResourceUrl('/proj/docs/a.png')).toBe('universe-app://root/_resource_/proj/docs/a.png')
  })

  it('percent-encodes spaces and unicode per segment', () => {
    expect(toResourceUrl('F:/my pics/图.png')).toBe(
      'universe-app://root/_resource_/F%3A/my%20pics/%E5%9B%BE.png',
    )
  })
})

describe('resourceUrlToFsPath', () => {
  it('restores a forward-slash fs path from a windows drive url', () => {
    expect(
      resourceUrlToFsPath('universe-app://root/_resource_/F%3A/test/test/md/folder-context.svg'),
    ).toBe('F:/test/test/md/folder-context.svg')
  })

  // A parsed URI re-serializes `%3A` as a bare `:` (see URI.toString), so both forms
  // reach the drop handler depending on who produced the payload.
  it('accepts a bare colon in the encoded path', () => {
    expect(
      resourceUrlToFsPath('universe-app://root/_resource_/F:/test/test/md/folder-context.svg'),
    ).toBe('F:/test/test/md/folder-context.svg')
  })

  it('restores the leading slash of a posix absolute path', () => {
    expect(resourceUrlToFsPath('universe-app://root/_resource_/home/u/a.png')).toBe('/home/u/a.png')
  })

  it('round-trips every path shape through toResourceUrl', () => {
    const cases = [
      'F:/test/test/md/folder-context.svg',
      'F:/my pics/图 100%.png',
      '/home/u/proj/a.png',
      '//server/share/a.png',
      'C:\\work\\project\\a.md',
    ]
    for (const fsPath of cases) {
      const expected = fsPath.replace(/\\/g, '/')
      expect(resourceUrlToFsPath(toResourceUrl(fsPath))).toBe(expected)
    }
  })

  it('ignores a query/fragment, like the main-side handler does', () => {
    expect(resourceUrlToFsPath('universe-app://root/_resource_/proj/a.html?t=17#x')).toBe(
      '/proj/a.html',
    )
  })

  it('returns undefined for anything that is not a resource url', () => {
    const notResources = [
      'universe-app://root/index.html', // app shell
      'universe-app://root/_webview_blank_',
      'universe-app://elsewhere/_resource_/proj/a.png', // not the shell origin
      'universe-app:/_resource_/proj/a.png', // no authority
      'universe-app://root/_resource_/',
      'file:///F:/test/a.svg',
      'remote-ssh://box/E:/ws/a.ts',
      'https://example.com/a.png',
      'markdown-preview://a/b.md',
      'not a url at all',
      'universe-app://root/_resource_/proj/%ZZ.png', // malformed escape
    ]
    for (const url of notResources) {
      expect(resourceUrlToFsPath(url), url).toBeUndefined()
    }
  })
})
