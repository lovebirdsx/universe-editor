/*---------------------------------------------------------------------------------------------
 *  Tests for the image-asset naming + link shaping helpers (mime→ext, timestamped
 *  file name, markdown embed vs link).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  assetFileName,
  formatAssetStamp,
  imageExtensionForMime,
  markdownLinkForPath,
} from '../markdownAssetLinks.js'

describe('imageExtensionForMime', () => {
  it('maps common image mimes to extensions', () => {
    expect(imageExtensionForMime('image/png')).toBe('png')
    expect(imageExtensionForMime('image/jpeg')).toBe('jpg')
    expect(imageExtensionForMime('image/svg+xml')).toBe('svg')
    expect(imageExtensionForMime('image/webp')).toBe('webp')
  })

  it('tolerates casing and a charset suffix', () => {
    expect(imageExtensionForMime('IMAGE/PNG')).toBe('png')
    expect(imageExtensionForMime('image/png;charset=binary')).toBe('png')
  })

  it('returns undefined for non-image or unknown mimes', () => {
    expect(imageExtensionForMime('text/plain')).toBeUndefined()
    expect(imageExtensionForMime('image/tiff')).toBeUndefined()
    expect(imageExtensionForMime('')).toBeUndefined()
  })
})

describe('formatAssetStamp', () => {
  it('formats a date as yyyyMMdd-HHmmss with zero padding', () => {
    // Local-time components; month is 0-based in the Date constructor.
    const d = new Date(2026, 6, 1, 9, 5, 3)
    expect(formatAssetStamp(d)).toBe('20260701-090503')
  })
})

describe('assetFileName', () => {
  it('omits the numeric suffix for the first image', () => {
    expect(assetFileName('png', '20260701-090503', 0)).toBe('image-20260701-090503.png')
  })

  it('appends the index to disambiguate same-second images', () => {
    expect(assetFileName('jpg', '20260701-090503', 2)).toBe('image-20260701-090503-2.jpg')
  })
})

describe('markdownLinkForPath', () => {
  it('emits an image embed / link snippet with a selected placeholder', () => {
    expect(markdownLinkForPath('assets/image-1.png', true)).toBe(
      '![${1:alt text}](assets/image-1.png)',
    )
    expect(markdownLinkForPath('docs/a.md', false)).toBe('[${1:text}](docs/a.md)')
  })

  it('angle-wraps a path containing spaces', () => {
    expect(markdownLinkForPath('assets/my pic.png', true)).toBe(
      '![${1:alt text}](<assets/my pic.png>)',
    )
  })
})
