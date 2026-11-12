import { describe, expect, it } from 'vitest'
import {
  appendWorkspaceRelativePath,
  MAX_WORKSPACE_RELATIVE_PATH_LENGTH,
  parentWorkspaceRelativePath,
  parseWorkspaceRelativePath,
} from '../workspacePath.js'

describe('parseWorkspaceRelativePath', () => {
  it('treats missing and empty paths as the workspace root', () => {
    expect(parseWorkspaceRelativePath(undefined)).toStrictEqual({ path: '', segments: [] })
    expect(parseWorkspaceRelativePath(null)).toStrictEqual({ path: '', segments: [] })
    expect(parseWorkspaceRelativePath('')).toStrictEqual({ path: '', segments: [] })
  })

  it('accepts canonical relative paths', () => {
    expect(parseWorkspaceRelativePath('a')).toStrictEqual({ path: 'a', segments: ['a'] })
    expect(parseWorkspaceRelativePath('packages/ui')).toStrictEqual({
      path: 'packages/ui',
      segments: ['packages', 'ui'],
    })
    expect(parseWorkspaceRelativePath('中文 目录/a:b/c%d')).toStrictEqual({
      path: '中文 目录/a:b/c%d',
      segments: ['中文 目录', 'a:b', 'c%d'],
    })
  })

  it('rejects escaping, non-canonical, and oversized paths', () => {
    for (const value of [
      '/a',
      'a/',
      'a//b',
      '.',
      '..',
      'a/../b',
      'a/./b',
      'a\\b',
      '\\\\server\\share',
      'C:',
      'C:/windows',
      '\0',
      'a/\0b',
      'x'.repeat(MAX_WORKSPACE_RELATIVE_PATH_LENGTH + 1),
    ]) {
      expect(parseWorkspaceRelativePath(value)).toBeNull()
    }
  })
})

describe('appendWorkspaceRelativePath', () => {
  it('appends one directory segment', () => {
    expect(appendWorkspaceRelativePath('', 'packages')).toBe('packages')
    expect(appendWorkspaceRelativePath('packages', 'ui')).toBe('packages/ui')
  })

  it('rejects non-segment names and invalid parents', () => {
    expect(appendWorkspaceRelativePath('', '')).toBeNull()
    expect(appendWorkspaceRelativePath('', '.')).toBeNull()
    expect(appendWorkspaceRelativePath('', '..')).toBeNull()
    expect(appendWorkspaceRelativePath('', 'a/b')).toBeNull()
    expect(appendWorkspaceRelativePath('', 'a\\b')).toBeNull()
    expect(appendWorkspaceRelativePath('../x', 'a')).toBeNull()
    expect(
      appendWorkspaceRelativePath('x'.repeat(MAX_WORKSPACE_RELATIVE_PATH_LENGTH), 'a'),
    ).toBeNull()
  })
})

describe('parentWorkspaceRelativePath', () => {
  it('walks up to the root', () => {
    expect(parentWorkspaceRelativePath('')).toBeUndefined()
    expect(parentWorkspaceRelativePath('a')).toBe('')
    expect(parentWorkspaceRelativePath('a/b')).toBe('a')
    expect(parentWorkspaceRelativePath('a/b/c')).toBe('a/b')
  })

  it('rejects non-canonical paths', () => {
    expect(parentWorkspaceRelativePath('../x')).toBeUndefined()
    expect(parentWorkspaceRelativePath('/abs')).toBeUndefined()
  })
})
