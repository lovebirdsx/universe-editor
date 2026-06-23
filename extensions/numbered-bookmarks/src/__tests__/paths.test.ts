import { describe, expect, it } from 'vitest'
import { keyToFsPath, uriToKey } from '../paths.js'

describe('paths', () => {
  it('derives a key from a URI', () => {
    expect(uriToKey({ scheme: 'file', path: '/D:/proj/a.ts' })).toBe('/D:/proj/a.ts')
  })

  it('strips the leading slash before a drive letter', () => {
    expect(keyToFsPath('/D:/proj/a.ts')).toBe('D:/proj/a.ts')
  })

  it('leaves POSIX paths untouched', () => {
    expect(keyToFsPath('/home/x/a.ts')).toBe('/home/x/a.ts')
  })
})
