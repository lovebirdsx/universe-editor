import { describe, expect, it } from 'vitest'
import { MAX_WEB_BUILD_ID_LENGTH, webBuildIdFromAssetUrl } from '../index.js'

describe('webBuildIdFromAssetUrl', () => {
  it('returns the entry file name for absolute, relative and versioned URLs', () => {
    expect(webBuildIdFromAssetUrl('/assets/index-_PQNuEOX.js')).toBe('index-_PQNuEOX.js')
    expect(webBuildIdFromAssetUrl('assets/index-old.js?v=1#x')).toBe('index-old.js')
    expect(webBuildIdFromAssetUrl('https://cdn.example.com/a/b/index-new.js')).toBe('index-new.js')
  })

  it('rejects missing, empty and oversized build ids', () => {
    expect(webBuildIdFromAssetUrl(undefined)).toBeUndefined()
    expect(webBuildIdFromAssetUrl('')).toBeUndefined()
    expect(webBuildIdFromAssetUrl('/assets/')).toBeUndefined()
    expect(
      webBuildIdFromAssetUrl(`/assets/${'x'.repeat(MAX_WEB_BUILD_ID_LENGTH + 1)}.js`),
    ).toBeUndefined()
  })
})
