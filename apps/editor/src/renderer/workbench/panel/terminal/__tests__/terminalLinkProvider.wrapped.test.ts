import { describe, expect, it, vi } from 'vitest'
import type { Terminal, ILink } from '@xterm/xterm'
import { URI } from '@universe-editor/platform'
import { createFileLinkProvider } from '../terminalLinkProvider.js'
import { makeTerminalBuffer, type FakeBuffer } from './terminalFakeBuffer.js'

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
