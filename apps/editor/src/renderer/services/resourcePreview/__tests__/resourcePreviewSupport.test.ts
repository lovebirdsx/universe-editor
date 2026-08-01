import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { isPreviewableResource, previewLanguageForResource } from '../resourcePreviewSupport.js'

const kind = (path: string) => previewLanguageForResource(URI.file(path))

describe('previewLanguageForResource', () => {
  it('maps markdown-family files to the markdown preview', () => {
    expect(kind('/proj/README.md')).toBe('markdown')
    expect(kind('/proj/README.markdown')).toBe('markdown')
    expect(kind('/proj/page.mdx')).toBe('markdown')
    expect(kind('/proj/README.MD')).toBe('markdown')
  })

  it('maps html files to the html preview', () => {
    expect(kind('/proj/index.html')).toBe('html')
    expect(kind('/proj/page.htm')).toBe('html')
    expect(kind('/proj/page.xhtml')).toBe('html')
  })

  it('returns undefined for non-previewable files', () => {
    expect(kind('/proj/main.ts')).toBeUndefined()
    expect(kind('/proj/notes.txt')).toBeUndefined()
    expect(kind('/proj/data.json')).toBeUndefined()
    expect(kind('/proj/LICENSE')).toBeUndefined()
  })

  it('isPreviewableResource mirrors the kind lookup', () => {
    expect(isPreviewableResource(URI.file('/proj/README.md'))).toBe(true)
    expect(isPreviewableResource(URI.file('/proj/index.html'))).toBe(true)
    expect(isPreviewableResource(URI.file('/proj/main.ts'))).toBe(false)
  })
})
