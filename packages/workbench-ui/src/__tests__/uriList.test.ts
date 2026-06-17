import { describe, expect, it } from 'vitest'
import { parseUriList, writeUriList, readUriList, dragContainsResources } from '../dnd/uriList.js'

function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>()
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return Array.from(store.keys())
    },
  } as unknown as DataTransfer
}

describe('uriList', () => {
  it('writes uri-list, the private mirror, and text/plain', () => {
    const dt = makeDataTransfer()
    writeUriList(dt, ['file:///a.ts', 'file:///b.ts'])
    expect(dt.getData('text/uri-list')).toBe('file:///a.ts\r\nfile:///b.ts')
    expect(dt.getData('application/vnd.universe-editor.uri-list')).toBe(
      'file:///a.ts\nfile:///b.ts',
    )
    expect(dt.getData('text/plain')).toBe('file:///a.ts\nfile:///b.ts')
  })

  it('writes nothing for an empty list', () => {
    const dt = makeDataTransfer()
    writeUriList(dt, [])
    expect(dt.getData('text/uri-list')).toBe('')
  })

  it('parses entries, skipping blanks and comments', () => {
    const text = '# comment\r\nfile:///a.ts\r\n\r\n  file:///b.ts  \r\n# trailing'
    expect(parseUriList(text)).toEqual(['file:///a.ts', 'file:///b.ts'])
  })

  // Repro: some drag sources (Chromium's OS-file `text/uri-list`) separate
  // entries with a bare CR. `/\r?\n/` never splits those, collapsing every URI
  // into one — which surfaced as "drop many files, only one opens" and the
  // garbled single `@mention` in the prompt input.
  it('splits CR-only separated entries', () => {
    expect(parseUriList('file:///a.ts\rfile:///b.ts\rfile:///c.ts')).toEqual([
      'file:///a.ts',
      'file:///b.ts',
      'file:///c.ts',
    ])
  })

  it('splits LF-only separated entries', () => {
    expect(parseUriList('file:///a.ts\nfile:///b.ts')).toEqual(['file:///a.ts', 'file:///b.ts'])
  })

  it('parseUriList tolerates empty input', () => {
    expect(parseUriList('')).toEqual([])
  })

  describe('readUriList', () => {
    it('prefers the private mirror over the standard wire format', () => {
      const dt = makeDataTransfer()
      dt.setData('text/uri-list', 'file:///wrong.ts')
      dt.setData('application/vnd.universe-editor.uri-list', 'file:///a.ts\nfile:///b.ts')
      expect(readUriList(dt)).toEqual(['file:///a.ts', 'file:///b.ts'])
    })

    // Repro of the in-app Explorer → editor bug: the OS round-trips a multi-entry
    // `text/uri-list` into a single glued line, but the private mirror survives.
    it('recovers every URI from the private mirror when text/uri-list is glued', () => {
      const dt = makeDataTransfer()
      dt.setData('text/uri-list', 'file:///F:/x/a.mdfile:///f:/x/b.md')
      dt.setData('application/vnd.universe-editor.uri-list', 'file:///F:/x/a.md\nfile:///f:/x/b.md')
      expect(readUriList(dt)).toEqual(['file:///F:/x/a.md', 'file:///f:/x/b.md'])
    })

    it('falls back to text/uri-list for external sources with no private mirror', () => {
      const dt = makeDataTransfer()
      dt.setData('text/uri-list', 'file:///a.ts\r\nfile:///b.ts')
      expect(readUriList(dt)).toEqual(['file:///a.ts', 'file:///b.ts'])
    })
  })

  it('detects droppable resources from the type list', () => {
    const withFiles = makeDataTransfer()
    withFiles.setData('Files', '')
    expect(dragContainsResources(withFiles)).toBe(true)

    const withUris = makeDataTransfer()
    withUris.setData('text/uri-list', 'file:///a.ts')
    expect(dragContainsResources(withUris)).toBe(true)

    const plainOnly = makeDataTransfer()
    plainOnly.setData('text/plain', 'hi')
    expect(dragContainsResources(plainOnly)).toBe(false)

    expect(dragContainsResources(null)).toBe(false)
  })
})
