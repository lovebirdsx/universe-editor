import { describe, expect, it, vi } from 'vitest'
import type { Terminal, ILink } from '@xterm/xterm'
import { URI } from '@universe-editor/platform'
import { createFileLinkProvider } from '../terminalLinkProvider.js'
import { makeBufferFromLines, makeTerminalBuffer, type FakeBuffer } from './terminalFakeBuffer.js'

function fakeTerm(buffer: FakeBuffer): Terminal {
  return { buffer: { active: buffer } } as unknown as Terminal
}

function provideLinks(
  term: Terminal,
  line: number,
  resolveFile: (p: string) => Promise<URI | null>,
  openFile: (uri: URI, line?: number, col?: number, endLine?: number) => void,
  cwd = '/workspace',
  home: string | undefined = undefined,
): ILink[] {
  let links: ILink[] = []
  const provider = createFileLinkProvider(
    term,
    resolveFile,
    openFile,
    () => cwd,
    () => home,
  )
  provider.provideLinks(line, (l) => {
    links = l ?? []
  })
  return links
}

describe('terminal file-link provider (wrapped lines)', () => {
  it('recognizes a path wrapped across two lines as one spanning link', () => {
    const term = fakeTerm(makeTerminalBuffer('/src/foo/bar.ts', 6))
    const links = provideLinks(
      term,
      1,
      vi.fn(async () => null),
      () => {},
    )

    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('/src/foo/bar.ts')
    expect(links[0]!.range.start).toEqual({ x: 1, y: 1 })
    expect(links[0]!.range.end).toEqual({ x: 3, y: 3 })
    expect(links[0]!.range.start.y).not.toBe(links[0]!.range.end.y)
  })

  it('activates with the full absolute path, not the wrapped tail joined to cwd', async () => {
    const term = fakeTerm(makeTerminalBuffer('src/components/button/style.tsx', 16))
    const uri = URI.file('/workspace/src/components/button/style.tsx')
    const resolveFile = vi.fn(async () => uri)
    const openFile = vi.fn()

    const links = provideLinks(term, 1, resolveFile, openFile)
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('src/components/button/style.tsx')
    expect(resolveFile).toHaveBeenCalledTimes(1)
    expect(resolveFile).toHaveBeenCalledWith('/workspace/src/components/button/style.tsx')

    links[0]!.activate({ button: 0 } as MouseEvent, '')
    await vi.waitFor(() => {
      expect(openFile).toHaveBeenCalledWith(uri, undefined, undefined, undefined)
    })
  })

  it('returns the same link when hovering either wrapped line', () => {
    const term = fakeTerm(makeTerminalBuffer('/src/foo/bar.ts', 6))
    const resolveFile = vi.fn(async () => null)
    const top = provideLinks(term, 1, resolveFile, () => {})
    const bottom = provideLinks(term, 2, resolveFile, () => {})

    expect(top).toHaveLength(1)
    expect(bottom).toHaveLength(1)
    expect(top[0]!.text).toBe(bottom[0]!.text)
    expect(top[0]!.range).toEqual(bottom[0]!.range)
  })

  it('maps CJK wide chars to cell columns, not string indices', () => {
    const term = fakeTerm(makeTerminalBuffer('/项目/a.ts', 20))
    const links = provideLinks(
      term,
      1,
      vi.fn(async () => null),
      () => {},
    )

    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('/项目/a.ts')
    expect(links[0]!.range.start).toEqual({ x: 1, y: 1 })
    // 8 string chars occupy 10 cells: two CJK glyphs each take 2 columns.
    expect(links[0]!.range.end).toEqual({ x: 10, y: 1 })
  })

  it('keeps the old single-line range for a plain ASCII path', () => {
    const term = fakeTerm(makeTerminalBuffer('src/a.ts', 20))
    const links = provideLinks(
      term,
      1,
      vi.fn(async () => null),
      () => {},
    )

    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('src/a.ts')
    // Old behavior: start.x = m.index + 1, end.x = m.index + full.length.
    expect(links[0]!.range.start).toEqual({ x: 1, y: 1 })
    expect(links[0]!.range.end).toEqual({ x: 8, y: 1 })
  })

  it('forwards line/col from a location suffix that wraps', async () => {
    const term = fakeTerm(makeTerminalBuffer('src/app.ts:1724:5', 10))
    const uri = URI.file('/workspace/src/app.ts')
    const resolveFile = vi.fn(async () => uri)
    const openFile = vi.fn()

    const links = provideLinks(term, 1, resolveFile, openFile)
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('src/app.ts:1724:5')
    expect(resolveFile).toHaveBeenCalledWith('/workspace/src/app.ts')

    links[0]!.activate({ button: 0 } as MouseEvent, '')
    await vi.waitFor(() => {
      expect(openFile).toHaveBeenCalledWith(uri, 1724, 5, undefined)
    })
  })

  it('corrects the column for a wide char early-wrapped to the next line', () => {
    const term = fakeTerm(makeTerminalBuffer('/ab中.ts', 4))
    const links = provideLinks(
      term,
      1,
      vi.fn(async () => null),
      () => {},
    )

    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('/ab中.ts')
    // '中' is early-wrapped ('/ab' on line 0, '中.ts' over lines 1-2), so the
    // trailing empty cell on line 0 must not shift the following columns.
    expect(links[0]!.range.end).toEqual({ x: 1, y: 3 })
  })

  // The match no longer starts at the window origin, so the m.index prefix has
  // to be walked cell-by-cell — the old `m.index + 1` shortcut broke here as
  // soon as the prefix contained a wide char.
  it('offsets the range by a prefix containing wide chars', () => {
    const term = fakeTerm(makeTerminalBuffer('运行 src/a.ts', 40))
    const links = provideLinks(
      term,
      1,
      vi.fn(async () => null),
      () => {},
    )

    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('src/a.ts')
    // '运行' occupies cells 0..3, the space cell 4, so the path starts at cell 5
    // (1-based column 6) — not at string index 3 (column 4).
    expect(links[0]!.range.start).toEqual({ x: 6, y: 1 })
    expect(links[0]!.range.end).toEqual({ x: 13, y: 1 })
  })

  it('reports no links for an empty buffer', () => {
    const links = provideLinks(
      fakeTerm(makeTerminalBuffer('', 10)),
      99,
      vi.fn(async () => null),
      () => {},
    )
    expect(links).toEqual([])
  })
})

// `provideLinks(y)` must answer only with links that intersect row `y`. The
// wrapped window spans several rows, so a naive "return every match in the
// window" reply also hands back links that live entirely on other rows — and
// xterm does not ignore those. Linkifier._removeIntersectingLinks projects each
// link onto the hovered row (start.y < y becomes x=0, end.y > y becomes x=cols)
// and drops any link whose projected span collides with an already-claimed
// column. An off-row link therefore squats on the low columns and evicts the
// genuinely wrapped link from the cached reply, so hovering the continuation row
// yields no link at all — the wrapped path silently stops being clickable.
// The window string is joined from `translateToString(true)` — trimRight — but
// the coordinate mapping walks the full cell grid. A row that is flagged wrapped
// yet still has NULL cells at its end therefore feeds the mapping cells that
// contributed nothing to the string, and each one silently eats one string
// character. The range slides left and collapses onto a single row.
//
// `makeTerminalBuffer` packs text so every wrapped row is exactly full, which is
// structurally unable to reproduce this; `makeBufferFromLines` pads to `cols` and
// lets the caller flag isWrapped, which is exactly the shape conpty produces once
// the Windows wrapping heuristic decides isWrapped by "last cell non-blank"
// rather than by the row actually being full.
describe('terminal file-link provider (wrapped rows with trailing blank cells)', () => {
  it('spans rows when the head row is flagged wrapped but not full', () => {
    const term = fakeTerm(
      makeBufferFromLines(
        [
          { text: 'a b f:/te', isWrapped: false },
          { text: 'st/x.ts', isWrapped: true },
        ],
        20,
      ),
    )

    const links = provideLinks(
      term,
      1,
      vi.fn(async () => null),
      () => {},
    )

    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('f:/test/x.ts')
    // 'f:/te' occupies cells 4..8 on row 1; the tail 'st/x.ts' lands on row 2.
    expect(links[0]!.range.start).toEqual({ x: 5, y: 1 })
    expect(links[0]!.range.end).toEqual({ x: 7, y: 2 })
  })

  it('spans rows when the trailing blank cells are on a middle row', () => {
    const term = fakeTerm(
      makeBufferFromLines(
        [
          { text: 'x /aaa/bb', isWrapped: false },
          { text: 'bccc', isWrapped: true },
          { text: 'ddd/e.ts', isWrapped: true },
        ],
        12,
      ),
    )

    const links = provideLinks(
      term,
      2,
      vi.fn(async () => null),
      () => {},
    )

    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('/aaa/bbbcccddd/e.ts')
    expect(links[0]!.range.start).toEqual({ x: 3, y: 1 })
    expect(links[0]!.range.end).toEqual({ x: 8, y: 3 })
  })

  // The exclusive end lands exactly on a padded row's content boundary while a
  // wrapped row still follows. Falling through to that row would report the end
  // at its column 0, which xterm renders as an underline running to the head
  // row's edge across all the padding cells — the very symptom being fixed.
  // Only the START of a match may fall through here: its target is a real
  // character, which does live at the next row's column 0.
  it('ends on the head row when the row is padded but a wrapped row follows', () => {
    const term = fakeTerm(
      makeBufferFromLines(
        [
          { text: 'x /a.ts', isWrapped: false },
          // Leading space: joined into the window, but it ends the path match.
          { text: ' y', isWrapped: true },
        ],
        12,
      ),
    )

    const links = provideLinks(
      term,
      1,
      vi.fn(async () => null),
      () => {},
    )

    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('/a.ts')
    expect(links[0]!.range.start).toEqual({ x: 3, y: 1 })
    // '/a.ts' occupies cells 2..6, so the exclusive end is cell 7 on row 1.
    expect(links[0]!.range.end).toEqual({ x: 7, y: 1 })
  })
})

describe('terminal file-link provider (only links intersecting the queried row)', () => {
  const texts = (links: ILink[]): string[] => links.map((l) => l.text)

  it('omits a single-row link when the continuation row is queried', () => {
    // row1 "/a/one.ts /src/foo/b" | row2 "arbaz/qux.ts"
    const term = fakeTerm(makeTerminalBuffer('/a/one.ts /src/foo/barbaz/qux.ts', 20))
    const noop = vi.fn(async () => null)

    expect(texts(provideLinks(term, 1, noop, () => {}))).toEqual([
      '/a/one.ts',
      '/src/foo/barbaz/qux.ts',
    ])
    // '/a/one.ts' ends on row 1, so it must not be part of the row-2 reply.
    expect(texts(provideLinks(term, 2, noop, () => {}))).toEqual(['/src/foo/barbaz/qux.ts'])
  })

  it('omits the head-row sibling when a middle row of a 3-row path is queried', () => {
    // row1 "/x/y.ts /aaa" | row2 "/bbb/ccc/ddd" | row3 "/eee.ts"
    const term = fakeTerm(makeTerminalBuffer('/x/y.ts /aaa/bbb/ccc/ddd/eee.ts', 12))
    const noop = vi.fn(async () => null)
    const wrapped = '/aaa/bbb/ccc/ddd/eee.ts'

    expect(texts(provideLinks(term, 1, noop, () => {}))).toEqual(['/x/y.ts', wrapped])
    expect(texts(provideLinks(term, 2, noop, () => {}))).toEqual([wrapped])
    expect(texts(provideLinks(term, 3, noop, () => {}))).toEqual([wrapped])
  })

  it('omits the sibling for a wrapped CJK path', () => {
    // row1 "/a.ts /项目" | row2 "文档/报告/b." | row3 "ts"
    const term = fakeTerm(makeTerminalBuffer('/a.ts /项目文档/报告/b.ts', 12))
    const noop = vi.fn(async () => null)
    const wrapped = '/项目文档/报告/b.ts'

    expect(texts(provideLinks(term, 1, noop, () => {}))).toEqual(['/a.ts', wrapped])
    expect(texts(provideLinks(term, 2, noop, () => {}))).toEqual([wrapped])
    expect(texts(provideLinks(term, 3, noop, () => {}))).toEqual([wrapped])
  })

  it('keeps a link that ends exactly on the column boundary', () => {
    // The path fills row 1 completely, so `end` is reported as the exclusive
    // (2,0) — row 2 is past the last cell. Such a link is visually confined to
    // row 1 and must survive there, while row 2 must not claim it.
    const term = fakeTerm(makeTerminalBuffer('/src/ab.ts,x', 10))
    const noop = vi.fn(async () => null)

    const head = provideLinks(term, 1, noop, () => {})
    expect(texts(head)).toEqual(['/src/ab.ts'])
    expect(head[0]!.range.end).toEqual({ x: 0, y: 2 })
    expect(texts(provideLinks(term, 2, noop, () => {}))).toEqual([])
  })

  it('keeps both links on a row that is one link’s tail and the next one’s head', () => {
    // row1 "/aaa/bbbbbb/firs" | row2 "t.ts /ccc/dddddd" | row3 "/second.ts"
    const term = fakeTerm(makeTerminalBuffer('/aaa/bbbbbb/first.ts /ccc/dddddd/second.ts', 16))
    const noop = vi.fn(async () => null)
    const first = '/aaa/bbbbbb/first.ts'
    const second = '/ccc/dddddd/second.ts'

    expect(texts(provideLinks(term, 2, noop, () => {}))).toEqual([first, second])
    // Row 3 only holds the tail of the second path.
    expect(texts(provideLinks(term, 3, noop, () => {}))).toEqual([second])
  })

  it('resolves only the paths it hands back, so no work is done for off-row links', () => {
    const term = fakeTerm(makeTerminalBuffer('/a/one.ts /src/foo/barbaz/qux.ts', 20))
    const resolveFile = vi.fn(async () => null)

    provideLinks(term, 2, resolveFile, () => {})

    expect(resolveFile).toHaveBeenCalledTimes(1)
    expect(resolveFile).toHaveBeenCalledWith('/src/foo/barbaz/qux.ts')
  })
})
