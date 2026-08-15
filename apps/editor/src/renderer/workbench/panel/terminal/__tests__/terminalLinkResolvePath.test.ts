import { describe, expect, it } from 'vitest'
import { resolvePath } from '../terminalLinkProvider.js'

describe('resolvePath', () => {
  it('expands ~ against a POSIX home (remote scenario)', () => {
    expect(resolvePath('/home/u/proj', '~/x.md', '/home/u')).toBe('/home/u/x.md')
  })

  it('expands ~ against a Windows home and normalizes separators (local scenario)', () => {
    expect(resolvePath('C:/Users/u/proj', '~/x.md', 'C:/Users/u')).toBe('C:/Users/u/x.md')
  })

  it('joins ~ to cwd when home is undefined (fallback)', () => {
    expect(resolvePath('/home/u/proj', '~/x.md', undefined)).toBe('/home/u/proj/~/x.md')
  })

  it('keeps an absolute POSIX path untouched regardless of home', () => {
    expect(resolvePath('/home/u/proj', '/abs/path.md', '/home/u')).toBe('/abs/path.md')
  })

  it('joins a relative path to cwd', () => {
    expect(resolvePath('/home/u/proj', 'src/a.ts', '/home/u')).toBe('/home/u/proj/src/a.ts')
  })

  it('normalizes a Windows drive absolute path untouched', () => {
    expect(resolvePath('/home/u/proj', 'D:\\repo\\a.ts', '/home/u')).toBe('D:/repo/a.ts')
  })
})
