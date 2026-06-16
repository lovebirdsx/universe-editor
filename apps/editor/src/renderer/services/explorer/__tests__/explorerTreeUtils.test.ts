import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  isDescendant,
  normalizeUri,
  relativeTo,
  sameUri,
  sameUriList,
} from '../explorerTreeUtils.js'

const winRoot = URI.from({ scheme: 'file', path: '/C:/workspace' })
const winRootLower = URI.from({ scheme: 'file', path: '/c:/workspace' })
const winFile = URI.from({ scheme: 'file', path: '/C:/workspace/src/index.ts' })
const winFileLower = URI.from({ scheme: 'file', path: '/c:/workspace/src/index.ts' })
const outside = URI.from({ scheme: 'file', path: '/C:/other/file.ts' })

describe('normalizeUri', () => {
  it('lowercases Windows drive letter', () => {
    expect(normalizeUri(winRoot).path).toBe('/c:/workspace')
    expect(normalizeUri(winRootLower).path).toBe('/c:/workspace')
  })

  it('returns same instance when path unchanged', () => {
    expect(normalizeUri(winRootLower)).toBe(winRootLower)
  })

  it('leaves non-Windows paths unchanged', () => {
    const unix = URI.from({ scheme: 'file', path: '/home/user/file.ts' })
    expect(normalizeUri(unix)).toBe(unix)
  })
})

describe('isDescendant', () => {
  it('returns true when target is under root (same case)', () => {
    expect(isDescendant(winRoot, winFile)).toBe(true)
  })

  it('returns true when root uppercase, target lowercase', () => {
    expect(isDescendant(winRoot, winFileLower)).toBe(true)
  })

  it('returns true when root lowercase, target uppercase', () => {
    expect(isDescendant(winRootLower, winFile)).toBe(true)
  })

  it('returns true when root === target (exact match)', () => {
    expect(isDescendant(winRoot, winRootLower)).toBe(true)
  })

  it('returns false when target is outside root', () => {
    expect(isDescendant(winRoot, outside)).toBe(false)
  })

  it('returns false when schemes differ', () => {
    const untitled = URI.from({ scheme: 'untitled', path: '/C:/workspace/file.ts' })
    expect(isDescendant(winRoot, untitled)).toBe(false)
  })
})

describe('relativeTo', () => {
  it('returns relative path when same case', () => {
    const child = URI.from({ scheme: 'file', path: '/c:/workspace/src/index.ts' })
    expect(relativeTo(winRootLower, child)).toBe('src/index.ts')
  })

  it('returns relative path when root uppercase, child lowercase', () => {
    expect(relativeTo(winRoot, winFileLower)).toBe('src/index.ts')
  })

  it('returns relative path when root lowercase, child uppercase', () => {
    expect(relativeTo(winRootLower, winFile)).toBe('src/index.ts')
  })

  it('returns empty string when child === root', () => {
    expect(relativeTo(winRoot, winRootLower)).toBe('')
  })

  it('returns raw path when child is outside root', () => {
    expect(relativeTo(winRoot, outside)).toBe('/C:/other/file.ts')
  })
})

describe('sameUri', () => {
  it('returns true for same URI instance', () => {
    expect(sameUri(winRoot, winRoot)).toBe(true)
  })

  it('returns true when only drive letter case differs', () => {
    expect(sameUri(winRoot, winRootLower)).toBe(true)
    expect(sameUri(winFile, winFileLower)).toBe(true)
  })

  it('returns false for different paths', () => {
    expect(sameUri(winRoot, outside)).toBe(false)
  })

  it('returns false when one side is null', () => {
    expect(sameUri(winRoot, null)).toBe(false)
    expect(sameUri(null, winRoot)).toBe(false)
  })

  it('returns true for both null', () => {
    expect(sameUri(null, null)).toBe(true)
  })
})

describe('sameUriList', () => {
  it('returns true when lists match with same case', () => {
    expect(sameUriList([winRoot, winFile], [winRoot, winFile])).toBe(true)
  })

  it('returns true when drive letter cases differ', () => {
    expect(sameUriList([winRoot, winFile], [winRootLower, winFileLower])).toBe(true)
  })

  it('returns false for different lengths', () => {
    expect(sameUriList([winRoot], [winRoot, winFile])).toBe(false)
  })

  it('returns false for different paths', () => {
    expect(sameUriList([winRoot], [outside])).toBe(false)
  })
})
