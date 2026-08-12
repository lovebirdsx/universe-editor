import { describe, expect, it } from 'vitest'
import { asRelativePathImpl, workspaceFolderName } from '../workspacePaths.js'

const isWindows = process.platform === 'win32'

describe('workspaceFolderName', () => {
  it('returns the basename of a root path with either separator', () => {
    expect(workspaceFolderName('/home/user/project')).toBe('project')
    expect(workspaceFolderName('C:\\ws\\project')).toBe('project')
    expect(workspaceFolderName('C:/ws/project/')).toBe('project')
  })

  it('keeps a bare name as-is', () => {
    expect(workspaceFolderName('project')).toBe('project')
  })
})

describe('asRelativePathImpl', () => {
  it('returns the root-relative path for an inside path', () => {
    expect(asRelativePathImpl('/ws', '/ws/src/a.ts', false)).toBe('src/a.ts')
    expect(asRelativePathImpl('/ws/', '/ws/src/a.ts', false)).toBe('src/a.ts')
  })

  it('normalizes backslashes and keeps forward slashes in the result', () => {
    expect(asRelativePathImpl('C:\\ws', 'C:\\ws\\src\\a.ts', false)).toBe('src/a.ts')
  })

  it('returns the input untouched for an outside path', () => {
    expect(asRelativePathImpl('/ws', '/other/a.ts', false)).toBe('/other/a.ts')
    expect(asRelativePathImpl('/ws', '/ws2/a.ts', false)).toBe('/ws2/a.ts')
    expect(asRelativePathImpl('/ws', 'relative/a.ts', false)).toBe('relative/a.ts')
  })

  it('prepends the folder name when includeFolder is set', () => {
    expect(asRelativePathImpl('/home/ws', '/home/ws/src/a.ts', true)).toBe('ws/src/a.ts')
  })

  it('returns the bare folder name for an outside path with includeFolder', () => {
    expect(asRelativePathImpl('/ws', '/other/a.ts', true)).toBe('/other/a.ts')
  })

  it('handles the root itself', () => {
    expect(asRelativePathImpl('/ws', '/ws', false)).toBe('.')
    expect(asRelativePathImpl('/ws', '/ws/', false)).toBe('.')
    expect(asRelativePathImpl('/ws', '/ws', true)).toBe('ws')
  })

  it.runIf(isWindows)('compares case-insensitively on Windows, preserving result casing', () => {
    expect(asRelativePathImpl('C:\\WS', 'c:\\ws\\Src\\A.ts', false)).toBe('Src/A.ts')
  })

  it.runIf(!isWindows)('compares case-sensitively off Windows', () => {
    expect(asRelativePathImpl('/WS', '/ws/a.ts', false)).toBe('/ws/a.ts')
  })
})
