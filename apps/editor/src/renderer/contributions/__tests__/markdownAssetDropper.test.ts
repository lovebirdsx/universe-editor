/*---------------------------------------------------------------------------------------------
 *  Tests for saveDroppedImageAsset: mkdir assets/ + write bytes + return the
 *  markdown embed, with same-second name disambiguation and mime/error handling.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import { saveDroppedImageAsset, type AssetFileService } from '../markdownAssetDropper.js'

const MD = URI.file('C:/work/project/docs/notes.md')
const STAMP = '20260701-090503'

function stubFs(overrides: Partial<AssetFileService> = {}): {
  fs: AssetFileService
  writes: { uri: string; bytes: Uint8Array }[]
  dirs: string[]
} {
  const writes: { uri: string; bytes: Uint8Array }[] = []
  const dirs: string[] = []
  const fs: AssetFileService = {
    createDirectory: vi.fn(async (uri: URI) => {
      dirs.push(uri.toString())
    }),
    writeFile: vi.fn(async (uri: URI, content: Uint8Array | string) => {
      writes.push({ uri: uri.toString(), bytes: content as Uint8Array })
    }),
    exists: vi.fn(async () => false),
    ...overrides,
  }
  return { fs, writes, dirs }
}

describe('saveDroppedImageAsset', () => {
  it('creates assets/ beside the md file, writes the bytes, returns an embed snippet', async () => {
    const { fs, writes, dirs } = stubFs()
    const bytes = new Uint8Array([1, 2, 3])
    const link = await saveDroppedImageAsset(fs, MD, bytes, 'image/png', STAMP)

    expect(link).toBe('![${1:alt text}](assets/image-20260701-090503.png)')
    expect(dirs).toEqual(['file:///C:/work/project/docs/assets'])
    expect(writes).toHaveLength(1)
    expect(writes[0]?.uri).toBe('file:///C:/work/project/docs/assets/image-20260701-090503.png')
    expect(writes[0]?.bytes).toBe(bytes)
  })

  it('disambiguates when a same-second file already exists', async () => {
    // First candidate exists, second is free.
    const exists = vi
      .fn<(uri: URI) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const { fs, writes } = stubFs({ exists })
    const link = await saveDroppedImageAsset(fs, MD, new Uint8Array([9]), 'image/jpeg', STAMP)

    expect(link).toBe('![${1:alt text}](assets/image-20260701-090503-1.jpg)')
    expect(writes[0]?.uri).toBe('file:///C:/work/project/docs/assets/image-20260701-090503-1.jpg')
  })

  it('returns undefined for an unrecognised image mime (no write)', async () => {
    const { fs, writes, dirs } = stubFs()
    const link = await saveDroppedImageAsset(fs, MD, new Uint8Array([1]), 'text/plain', STAMP)

    expect(link).toBeUndefined()
    expect(dirs).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })

  it('returns undefined when the write throws', async () => {
    const { fs } = stubFs({
      writeFile: vi.fn(async () => {
        throw new Error('EACCES')
      }),
    })
    const link = await saveDroppedImageAsset(fs, MD, new Uint8Array([1]), 'image/png', STAMP)
    expect(link).toBeUndefined()
  })
})
