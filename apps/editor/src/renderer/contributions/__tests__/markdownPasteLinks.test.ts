/*---------------------------------------------------------------------------------------------
 *  Tests for the markdown paste-to-link shaping: uri-list → image/link with a
 *  path relative to the target document's own directory, and URL-over-selection
 *  → escaped snippet.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { markdownLinkFromUrl, markdownLinksFromUriList } from '../markdownPasteLinks.js'

const TARGET_DIR = 'C:/work/project'

describe('markdownLinksFromUriList', () => {
  it('makes a relative link snippet for a file under the target directory', () => {
    const out = markdownLinksFromUriList('file:///C:/work/project/docs/a.md', TARGET_DIR, 'win32')
    expect(out).toBe('[${1:text}](docs/a.md)')
  })

  it('emits an image embed snippet for image extensions', () => {
    const out = markdownLinksFromUriList('file:///C:/work/project/img/p.PNG', TARGET_DIR, 'win32')
    expect(out).toBe('![${1:alt text}](img/p.PNG)')
  })

  it('joins multiple uris with a space, incrementing the placeholder index', () => {
    const raw = [
      '# comment',
      'file:///C:/work/project/a.md',
      '',
      'file:///C:/work/project/b.png',
    ].join('\r\n')
    expect(markdownLinksFromUriList(raw, TARGET_DIR, 'win32')).toBe(
      '[${1:text}](a.md) ![${2:alt text}](b.png)',
    )
  })

  it('angle-wraps a target containing spaces', () => {
    const out = markdownLinksFromUriList('file:///C:/work/project/my%20doc.md', TARGET_DIR, 'win32')
    expect(out).toBe('[${1:text}](<my doc.md>)')
  })

  it('climbs with ../ when the source lives outside the target directory', () => {
    const out = markdownLinksFromUriList(
      'file:///C:/work/project/sibling/a.md',
      `${TARGET_DIR}/docs/sub`,
      'win32',
    )
    expect(out).toBe('[${1:text}](../../sibling/a.md)')
  })

  it('falls back to the normalized absolute path across different Windows drives', () => {
    const out = markdownLinksFromUriList('file:///D:/other/a.md', TARGET_DIR, 'win32')
    expect(out).toBe('[${1:text}](D:/other/a.md)')
  })

  it('ignores non-file uris and returns undefined when nothing parses', () => {
    expect(markdownLinksFromUriList('https://example.com', TARGET_DIR, 'win32')).toBeUndefined()
  })

  it('handles a posix target directory', () => {
    const out = markdownLinksFromUriList('file:///home/u/proj/a.md', '/home/u/proj', 'linux')
    expect(out).toBe('[${1:text}](a.md)')
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
