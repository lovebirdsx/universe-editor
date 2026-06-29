/*---------------------------------------------------------------------------------------------
 *  Tests for the markdown paste-to-link shaping: uri-list → image/link with a
 *  workspace-relative path, and URL-over-selection → escaped snippet.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { markdownLinkFromUrl, markdownLinksFromUriList } from '../markdownPasteLinks.js'

const ROOT = 'C:/work/project'

describe('markdownLinksFromUriList', () => {
  it('makes a relative link for a file under the workspace root', () => {
    const out = markdownLinksFromUriList('file:///C:/work/project/docs/a.md', ROOT, 'win32')
    expect(out).toBe('[](docs/a.md)')
  })

  it('emits an image embed for image extensions', () => {
    const out = markdownLinksFromUriList('file:///C:/work/project/img/p.PNG', ROOT, 'win32')
    expect(out).toBe('![](img/p.PNG)')
  })

  it('joins multiple uris with a space and skips blank / comment lines', () => {
    const raw = [
      '# comment',
      'file:///C:/work/project/a.md',
      '',
      'file:///C:/work/project/b.png',
    ].join('\r\n')
    expect(markdownLinksFromUriList(raw, ROOT, 'win32')).toBe('[](a.md) ![](b.png)')
  })

  it('angle-wraps a target containing spaces', () => {
    const out = markdownLinksFromUriList('file:///C:/work/project/my%20doc.md', ROOT, 'win32')
    expect(out).toBe('[](<my doc.md>)')
  })

  it('falls back to the absolute forward-slashed path when outside the root', () => {
    const out = markdownLinksFromUriList('file:///D:/other/a.md', ROOT, 'win32')
    expect(out).toBe('[](D:/other/a.md)')
  })

  it('ignores non-file uris and returns undefined when nothing parses', () => {
    expect(markdownLinksFromUriList('https://example.com', ROOT, 'win32')).toBeUndefined()
  })

  it('handles a posix root', () => {
    const out = markdownLinksFromUriList('file:///home/u/proj/a.md', '/home/u/proj', 'linux')
    expect(out).toBe('[](a.md)')
  })
})

describe('markdownLinkFromUrl', () => {
  it('wraps a selection around a bare URL', () => {
    expect(markdownLinkFromUrl('docs', 'https://example.com')).toEqual({
      snippet: '[docs](https://example.com)',
    })
  })

  it('escapes snippet metacharacters in selection and url', () => {
    expect(markdownLinkFromUrl('a$b', 'https://x/$1')).toEqual({
      snippet: '[a\\$b](https://x/\\$1)',
    })
  })

  it('returns undefined for non-url text', () => {
    expect(markdownLinkFromUrl('docs', 'just words')).toBeUndefined()
  })

  it('returns undefined when the url has whitespace', () => {
    expect(markdownLinkFromUrl('docs', 'https://x y')).toBeUndefined()
  })

  it('returns undefined when nothing is selected', () => {
    expect(markdownLinkFromUrl('', 'https://example.com')).toBeUndefined()
  })

  it('accepts mailto and ftp schemes', () => {
    expect(markdownLinkFromUrl('mail', 'mailto:a@b.com')).toEqual({
      snippet: '[mail](mailto:a@b.com)',
    })
  })
})
