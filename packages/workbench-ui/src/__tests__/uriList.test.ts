import { describe, expect, it } from 'vitest'
import { parseUriList, writeUriList, dragContainsResources } from '../dnd/uriList.js'

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
  it('writes uri-list and text/plain mirrors', () => {
    const dt = makeDataTransfer()
    writeUriList(dt, ['file:///a.ts', 'file:///b.ts'])
    expect(dt.getData('text/uri-list')).toBe('file:///a.ts\r\nfile:///b.ts')
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

  it('parseUriList tolerates empty input', () => {
    expect(parseUriList('')).toEqual([])
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
