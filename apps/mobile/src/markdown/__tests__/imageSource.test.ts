import { describe, expect, it } from 'vitest'
import { MAX_DATA_IMAGE_CHARS, resolveMarkdownImageSource } from '../imageSource.js'

describe('resolveMarkdownImageSource', () => {
  it('renders previewable data images directly', () => {
    expect(resolveMarkdownImageSource('data:image/png;base64,AAA=')).toEqual({
      kind: 'direct',
      src: 'data:image/png;base64,AAA=',
    })
    expect(resolveMarkdownImageSource('DATA:image/JPEG;base64,AAA=')).toEqual({
      kind: 'direct',
      src: 'DATA:image/JPEG;base64,AAA=',
    })
  })

  it('rejects data images that are not raster previews', () => {
    expect(resolveMarkdownImageSource('data:image/svg+xml;base64,AAA=')).toBeUndefined()
    expect(resolveMarkdownImageSource('data:text/plain;base64,AAA=')).toBeUndefined()
    expect(
      resolveMarkdownImageSource(`data:image/png;base64,${'A'.repeat(MAX_DATA_IMAGE_CHARS)}`),
    ).toBeUndefined()
  })

  it('renders http(s) images directly and caps their length', () => {
    expect(resolveMarkdownImageSource('https://example.com/a.png')).toEqual({
      kind: 'direct',
      src: 'https://example.com/a.png',
    })
    expect(resolveMarkdownImageSource(`http://example.com/${'a'.repeat(8192)}.png`)).toBeUndefined()
  })

  it('resolves local and relative paths through the PC', () => {
    expect(resolveMarkdownImageSource('C:\\work\\shot.png')).toEqual({
      kind: 'workspace',
      src: 'C:\\work\\shot.png',
    })
    expect(resolveMarkdownImageSource('file:///home/dev/a.png')).toEqual({
      kind: 'workspace',
      src: 'file:///home/dev/a.png',
    })
    expect(resolveMarkdownImageSource('./img/a.png')).toEqual({
      kind: 'workspace',
      src: './img/a.png',
    })
  })

  it('keeps unknown schemes and blank sources inert', () => {
    expect(resolveMarkdownImageSource('')).toBeUndefined()
    expect(resolveMarkdownImageSource('   ')).toBeUndefined()
    expect(resolveMarkdownImageSource('a\0b.png')).toBeUndefined()
    expect(resolveMarkdownImageSource('javascript:alert(1)')).toBeUndefined()
    expect(resolveMarkdownImageSource('ftp://example.com/a.png')).toBeUndefined()
    expect(resolveMarkdownImageSource(`a/${'b'.repeat(4096)}.png`)).toBeUndefined()
  })
})
