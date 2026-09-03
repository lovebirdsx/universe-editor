import { describe, expect, it } from 'vitest'
import { normalizeGraphScopeSelection, scopePathKey } from '../graphScopeSelection.js'

describe('scopePathKey', () => {
  it('normalizes separators and the trailing slash', () => {
    expect(scopePathKey('X:\\p4ws\\main\\src\\')).toBe('x:/p4ws/main/src')
    expect(scopePathKey('/home/dev/ws/')).toBe('/home/dev/ws')
  })

  it('lowercases the drive letter only, never the rest of the path', () => {
    expect(scopePathKey('X:/p4ws/Main/A.txt')).toBe('x:/p4ws/Main/A.txt')
  })

  it('keeps a lone root slash', () => {
    expect(scopePathKey('/')).toBe('/')
  })
})

describe('normalizeGraphScopeSelection', () => {
  const A = { path: 'X:/p4ws/main/a.txt', isDirectory: false }
  const B = { path: 'X:/p4ws/main/b.txt', isDirectory: false }
  const LIB = { path: 'X:/p4ws/main/lib', isDirectory: true }

  it('is click-order independent', () => {
    const one = normalizeGraphScopeSelection([B, LIB, A])
    const two = normalizeGraphScopeSelection([A, B, LIB])
    expect(one).toEqual(two)
  })

  it('labels with the first basename plus +N', () => {
    expect(normalizeGraphScopeSelection([A]).label).toBe('a.txt')
    expect(normalizeGraphScopeSelection([A, B]).label).toBe('a.txt +1')
    expect(normalizeGraphScopeSelection([A, B, LIB]).label).toBe('a.txt +2')
  })

  it('drops duplicates, keeping the first occurrence', () => {
    const out = normalizeGraphScopeSelection([
      A,
      { path: 'X:\\p4ws\\main\\a.txt', isDirectory: false },
      { path: 'x:/p4ws/main/a.txt', isDirectory: false },
    ])
    expect(out.paths).toEqual([A])
    expect(out.label).toBe('a.txt')
  })

  it('keeps a file nested under a selected directory (collapsing is the query layer job)', () => {
    const nested = { path: 'X:/p4ws/main/lib/x.ts', isDirectory: false }
    const out = normalizeGraphScopeSelection([LIB, nested])
    expect(out.paths).toHaveLength(2)
  })

  it('does not fold paths differing only in a non-drive segment case', () => {
    const out = normalizeGraphScopeSelection([
      { path: 'X:/p4ws/main/A.txt', isDirectory: false },
      { path: 'X:/p4ws/main/a.txt', isDirectory: false },
    ])
    expect(out.paths).toHaveLength(2)
  })

  it('yields an empty scope for an empty (or blank-path) selection', () => {
    expect(normalizeGraphScopeSelection([])).toEqual({ paths: [], label: '' })
    expect(normalizeGraphScopeSelection([{ path: '', isDirectory: false }])).toEqual({
      paths: [],
      label: '',
    })
  })
})
