import { describe, expect, it } from 'vitest'
import { pastedImageFiles } from '../pastedImages.js'

interface FakeItem {
  readonly kind: string
  readonly type: string
  readonly getAsFile: () => File | null
}

function file(name: string, type: string): File {
  return new File(['x'], name, { type })
}

function imageItem(type: string, value: File | null = file('shot.png', type)): FakeItem {
  return { kind: 'file', type, getAsFile: () => value }
}

function clipboard(items: readonly FakeItem[] = [], files: readonly File[] = []): DataTransfer {
  return { items, files } as unknown as DataTransfer
}

describe('pastedImageFiles', () => {
  it('returns image files carried by items', () => {
    const shot = file('shot.png', 'image/png')
    expect(pastedImageFiles(clipboard([imageItem('image/png', shot)]))).toEqual([shot])
  })

  it('ignores text items and non-image files', () => {
    const note = file('notes.txt', 'text/plain')
    const data = clipboard([
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      imageItem('text/plain', note),
      imageItem('image/png', null),
    ])

    expect(pastedImageFiles(data)).toEqual([])
  })

  it('falls back to files when items carry no image', () => {
    const shot = file('shot.jpg', 'image/jpeg')
    expect(
      pastedImageFiles(
        clipboard([{ kind: 'string', type: 'text/plain', getAsFile: () => null }], [shot]),
      ),
    ).toEqual([shot])
  })

  it('uses the item type when the file has none', () => {
    const shot = file('shot', '')
    expect(pastedImageFiles(clipboard([imageItem('image/png', shot)]))).toEqual([shot])
  })

  it('uses the file type when the item has none', () => {
    const shot = file('shot.png', 'image/png')
    expect(pastedImageFiles(clipboard([imageItem('', shot)]))).toEqual([shot])
  })

  it('prefers items over files so nothing is counted twice', () => {
    const fromItems = file('items.png', 'image/png')
    const fromFiles = file('files.png', 'image/png')
    expect(pastedImageFiles(clipboard([imageItem('image/png', fromItems)], [fromFiles]))).toEqual([
      fromItems,
    ])
  })

  it('preserves the paste order and skips text between images', () => {
    const first = file('a.png', 'image/png')
    const second = file('b.webp', 'image/webp')
    const data = clipboard([
      imageItem('image/png', first),
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      imageItem('image/webp', second),
    ])

    expect(pastedImageFiles(data)).toEqual([first, second])
  })

  it('returns nothing for an empty or missing clipboard payload', () => {
    expect(pastedImageFiles(null)).toEqual([])
    expect(pastedImageFiles(clipboard())).toEqual([])
  })
})
