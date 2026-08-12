/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/search/folderIncludes.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { escapeGlobPattern, folderIncludesForSearch } from '../folderIncludes.js'

const root = URI.file('/ws')

describe('folderIncludesForSearch', () => {
  it('prefixes a single folder with ./ and keeps forward slashes', () => {
    expect(folderIncludesForSearch(root, [URI.file('/ws/d.地图/110')])).toBe('./d.地图/110')
  })

  it('joins multiple folders with ", "', () => {
    expect(folderIncludesForSearch(root, [URI.file('/ws/a'), URI.file('/ws/b/c')])).toBe(
      './a, ./b/c',
    )
  })

  it('yields no include for the workspace root (whole-workspace search)', () => {
    expect(folderIncludesForSearch(root, [root])).toBe('')
  })

  it('skips folders outside the workspace root', () => {
    expect(folderIncludesForSearch(root, [URI.file('/elsewhere/dir')])).toBe('')
  })

  it('dedupes repeated folders', () => {
    expect(folderIncludesForSearch(root, [URI.file('/ws/a'), URI.file('/ws/a')])).toBe('./a')
  })

  it('escapes glob metacharacters so the folder name matches literally', () => {
    expect(folderIncludesForSearch(root, [URI.file('/ws/blog/[postId]')])).toBe(
      './blog/[[]postId[]]',
    )
  })
})

describe('escapeGlobPattern', () => {
  it('escapes ?, *, [ and ]', () => {
    expect(escapeGlobPattern('a?b*c[d]')).toBe('a[?]b[*]c[[]d[]]')
  })

  it('leaves plain paths untouched', () => {
    expect(escapeGlobPattern('d.地图/110')).toBe('d.地图/110')
  })
})
