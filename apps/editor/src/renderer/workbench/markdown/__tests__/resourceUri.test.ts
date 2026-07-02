/*---------------------------------------------------------------------------------------------
 *  Tests for asPreviewResourceUri — the markdown image src → loadable URL rewrite.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { asPreviewResourceUri } from '../resourceUri.js'

const base = URI.file('/proj/docs')
const root = URI.file('/proj')

describe('asPreviewResourceUri', () => {
  it('returns http(s) and data:image URLs unchanged', () => {
    expect(asPreviewResourceUri('https://x/a.png', base, root)).toBe('https://x/a.png')
    expect(asPreviewResourceUri('http://x/a.png', base, root)).toBe('http://x/a.png')
    const data = 'data:image/png;base64,AAAA'
    expect(asPreviewResourceUri(data, base, root)).toBe(data)
  })

  it('rewrites a relative path against the document dir', () => {
    const out = asPreviewResourceUri('./assets/a.png', base, root)
    expect(out).toBe('universe-app://root/_resource_/proj/docs/assets/a.png')
  })

  it('rewrites a parent-relative path', () => {
    const out = asPreviewResourceUri('../img/b.png', base, root)
    expect(out).toBe('universe-app://root/_resource_/proj/img/b.png')
  })

  it('falls back to the workspace root when no baseUri', () => {
    const out = asPreviewResourceUri('a.png', undefined, root)
    expect(out).toBe('universe-app://root/_resource_/proj/a.png')
  })

  it('rewrites a posix absolute path', () => {
    const out = asPreviewResourceUri('/pics/c.png', base, root)
    expect(out).toBe('universe-app://root/_resource_/pics/c.png')
  })

  it('rewrites a file: URL', () => {
    const out = asPreviewResourceUri('file:///pics/d.png', base, root)
    expect(out).toBe('universe-app://root/_resource_/pics/d.png')
  })

  it('percent-encodes spaces and unicode in the path', () => {
    const out = asPreviewResourceUri('./my pic.png', base, root)
    expect(out).toBe('universe-app://root/_resource_/proj/docs/my%20pic.png')
  })

  it('rejects dangerous or unknown schemes', () => {
    expect(asPreviewResourceUri('javascript:alert(1)', base, root)).toBeUndefined()
    expect(asPreviewResourceUri('vbscript:x', base, root)).toBeUndefined()
    expect(asPreviewResourceUri('', base, root)).toBeUndefined()
  })

  it('returns undefined for a relative path with no base or root', () => {
    expect(asPreviewResourceUri('./a.png', undefined, undefined)).toBeUndefined()
  })
})
