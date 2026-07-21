import { describe, expect, it } from 'vitest'
import { WEBVIEW_ORIGIN, WEBVIEW_RESOURCE_PREFIX, fsPathToWebviewUrl } from '../webviewProtocol.js'

describe('fsPathToWebviewUrl', () => {
  it('maps a POSIX absolute path under the resource prefix', () => {
    expect(fsPathToWebviewUrl('/home/user/file.png')).toBe(
      `${WEBVIEW_ORIGIN}/${WEBVIEW_RESOURCE_PREFIX}/home/user/file.png`,
    )
  })

  it('normalizes backslashes and ensures a leading slash for a Windows path', () => {
    // Each segment is encodeURIComponent-escaped, so the drive colon becomes %3A.
    expect(fsPathToWebviewUrl('C:\\Users\\me\\a.png')).toBe(
      `${WEBVIEW_ORIGIN}/${WEBVIEW_RESOURCE_PREFIX}/C%3A/Users/me/a.png`,
    )
  })

  it('percent-encodes each path segment (spaces, unicode) without escaping slashes', () => {
    const url = fsPathToWebviewUrl('/a b/файл.png')
    expect(url).toContain('/a%20b/')
    expect(url).toContain(encodeURIComponent('файл.png'))
    expect(url).not.toContain('/a b/')
  })

  it('does not double the leading slash for an already-absolute path', () => {
    const url = fsPathToWebviewUrl('/x')
    expect(url).toBe(`${WEBVIEW_ORIGIN}/${WEBVIEW_RESOURCE_PREFIX}/x`)
    expect(url).not.toContain('_resource_//')
  })
})
