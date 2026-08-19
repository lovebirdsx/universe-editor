import { describe, expect, it } from 'vitest'
import { PreviewDocument, dirUri, fileUri, joinPath, renderHtml } from '../preview.js'

describe('path helpers', () => {
  it('joins segments onto a base path with forward slashes', () => {
    expect(joinPath('/root', 'assets')).toBe('/root/assets')
    expect(joinPath('C:\\root\\', 'assets')).toBe('C:\\root/assets')
  })

  it('builds file: UriComponents with a leading-slash path', () => {
    expect(fileUri('/tmp/a.txt')).toEqual({ scheme: 'file', path: '/tmp/a.txt' })
    expect(fileUri('C:\\tmp\\a.txt')).toEqual({ scheme: 'file', path: '/C:/tmp/a.txt' })
  })

  it('returns the parent directory of a file: UriComponents', () => {
    expect(dirUri({ scheme: 'file', path: '/tmp/a.txt' })).toEqual({
      scheme: 'file',
      path: '/tmp',
    })
    expect(dirUri({ scheme: 'file', path: '/' })).toEqual({ scheme: 'file', path: '/' })
  })
})

describe('renderHtml', () => {
  it('renders the display name and the file name', () => {
    const html = renderHtml(new PreviewDocument({ scheme: 'file', path: '/tmp/sample.__name__' }))
    expect(html).toContain('__displayName__')
    expect(html).toContain('sample.__name__')
  })
})
