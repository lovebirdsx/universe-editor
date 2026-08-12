/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Unit tests for the prompt-image pure helpers: validation + wire-block shape.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  bytesToPromptImage,
  composeImageBlocks,
  isSupportedImageMime,
  mimeTypeForFileName,
  parseDataUri,
  toPngBase64,
  validateImage,
  type ImageLimits,
  type PromptImage,
} from '../promptImage.js'

const LIMITS: ImageLimits = { maxBytes: 5 * 1024 * 1024, maxCount: 3 }

function img(over: Partial<PromptImage> = {}): PromptImage {
  return {
    id: 'i1',
    mimeType: 'image/png',
    dataBase64: 'AAAA',
    byteSize: 4,
    ...over,
  }
}

describe('isSupportedImageMime', () => {
  it('accepts the whitelist', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(isSupportedImageMime(m)).toBe(true)
    }
  })
  it('rejects anything else', () => {
    expect(isSupportedImageMime('image/bmp')).toBe(false)
    expect(isSupportedImageMime('application/pdf')).toBe(false)
    expect(isSupportedImageMime('')).toBe(false)
  })
})

describe('validateImage', () => {
  it('accepts a valid image under the limits', () => {
    expect(validateImage({ mimeType: 'image/png', byteSize: 1000 }, 0, LIMITS)).toBeNull()
  })
  it('rejects an unsupported type', () => {
    expect(validateImage({ mimeType: 'image/bmp', byteSize: 10 }, 0, LIMITS)).toBe(
      'unsupported-type',
    )
  })
  it('rejects an oversized image', () => {
    expect(validateImage({ mimeType: 'image/png', byteSize: LIMITS.maxBytes + 1 }, 0, LIMITS)).toBe(
      'too-large',
    )
  })
  it('rejects when the count limit is reached', () => {
    expect(validateImage({ mimeType: 'image/png', byteSize: 10 }, 3, LIMITS)).toBe('too-many')
  })
  it('checks type before size before count', () => {
    // A bad type that is also oversized reports the type first.
    expect(validateImage({ mimeType: 'image/bmp', byteSize: LIMITS.maxBytes + 1 }, 5, LIMITS)).toBe(
      'unsupported-type',
    )
  })
})

describe('parseDataUri', () => {
  it('parses a base64 data URI into mime + bytes', () => {
    const parsed = parseDataUri('data:image/jpeg;base64,QUJD')
    expect(parsed).toBeDefined()
    expect(parsed!.mimeType).toBe('image/jpeg')
    expect([...parsed!.bytes]).toEqual([0x41, 0x42, 0x43])
  })

  it('tolerates a missing media type', () => {
    const parsed = parseDataUri('data:;base64,QUJD')
    expect(parsed).toEqual({ mimeType: '', bytes: new Uint8Array([0x41, 0x42, 0x43]) })
  })

  it('returns undefined for non-data URIs and non-base64 payloads', () => {
    expect(parseDataUri('https://example.com/a.jpg')).toBeUndefined()
    expect(parseDataUri('data:image/png,%89PNG')).toBeUndefined()
    expect(parseDataUri('')).toBeUndefined()
    expect(parseDataUri('data:image/png;base64,')).toBeUndefined()
  })

  it('returns undefined for invalid base64', () => {
    expect(parseDataUri('data:image/png;base64,!!!')).toBeUndefined()
  })
})

describe('toPngBase64', () => {
  // The canvas re-encode path needs createImageBitmap (unavailable in node);
  // only the passthrough branch is exercised here — parseDataUri above covers
  // the data-URI decoding that feeds it.
  it('passes a PNG data URI through untouched, without fetch', async () => {
    await expect(toPngBase64('data:image/png;base64,QUJD')).resolves.toBe('QUJD')
  })
})

describe('composeImageBlocks', () => {
  it('maps images to image ContentBlocks', () => {
    const blocks = composeImageBlocks([
      img({ id: 'a', mimeType: 'image/png', dataBase64: 'AAA' }),
      img({ id: 'b', mimeType: 'image/jpeg', dataBase64: 'BBB' }),
    ])
    expect(blocks).toEqual([
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
      { type: 'image', data: 'BBB', mimeType: 'image/jpeg' },
    ])
  })
  it('returns [] for no images', () => {
    expect(composeImageBlocks([])).toEqual([])
  })
})

describe('mimeTypeForFileName', () => {
  it('maps known image extensions', () => {
    expect(mimeTypeForFileName('a.png')).toBe('image/png')
    expect(mimeTypeForFileName('a.PNG')).toBe('image/png')
    expect(mimeTypeForFileName('a.jpg')).toBe('image/jpeg')
    expect(mimeTypeForFileName('a.jpeg')).toBe('image/jpeg')
    expect(mimeTypeForFileName('a.webp')).toBe('image/webp')
    expect(mimeTypeForFileName('a.gif')).toBe('image/gif')
  })
  it('returns empty for non-images', () => {
    expect(mimeTypeForFileName('a.txt')).toBe('')
    expect(mimeTypeForFileName('noext')).toBe('')
  })
})

describe('bytesToPromptImage', () => {
  it('builds a PromptImage from bytes with inferred mime + name', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const image = bytesToPromptImage(bytes, 'id1', 'pic.png')
    expect(image.id).toBe('id1')
    expect(image.name).toBe('pic.png')
    expect(image.mimeType).toBe('image/png')
    expect(image.byteSize).toBe(4)
    // Round-trips through base64.
    expect(atob(image.dataBase64)).toHaveLength(4)
  })
})
