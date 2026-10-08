/**
 * Guards the extension's single URI spelling. The language service computes
 * relative links with a case-sensitive `path.posix.relative`, so whichever
 * drive-letter case and `:` encoding we feed it decides whether a rewritten link
 * stays `./c.md` or degrades into `../../../../E:/…/c.md`. That failure needs a
 * Windows drive to show up end-to-end, which CI's ubuntu leg never has — these
 * cases are the portable guard.
 */
import { describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { uriString } from '../uriString.js'

describe('uriString', () => {
  it('keeps the Windows drive letter upper-case and the `:` unencoded', () => {
    expect(uriString(URI.parse('file:///E:/ws/a.md'))).toBe('file:///E:/ws/a.md')
  })

  it('folds a lower-cased, percent-encoded spelling onto the canonical one', () => {
    expect(uriString(URI.parse('file:///e%3A/ws/a.md'))).toBe('file:///E:/ws/a.md')
  })

  it('applies the same fold to component objects', () => {
    expect(uriString({ scheme: 'file', path: '/e:/ws/a.md' })).toBe('file:///E:/ws/a.md')
  })

  it('encodes spaces and non-ASCII exactly like vscode-uri does', () => {
    expect(uriString({ scheme: 'file', path: '/E:/ws/a b/中文.md' })).toBe(
      'file:///E:/ws/a%20b/%E4%B8%AD%E6%96%87.md',
    )
  })

  it('leaves drive-less paths byte-identical to vscode-uri', () => {
    for (const path of ['/ws/a.md', '/home/u/文件 名.md']) {
      expect(uriString({ scheme: 'file', path })).toBe(
        URI.from({ scheme: 'file', path }).toString(),
      )
    }
  })

  it('leaves non-file schemes alone', () => {
    expect(uriString(URI.parse('remote-ssh://wsl%2Bubuntu2004/home/a.md'))).toBe(
      'remote-ssh://wsl+ubuntu2004/home/a.md',
    )
  })
})
