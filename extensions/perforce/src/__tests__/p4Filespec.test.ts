import { describe, expect, it } from 'vitest'
import { buildScopeFilespec, escapeFilespecPath } from '../p4Filespec.js'

describe('escapeFilespecPath', () => {
  it('escapes each metacharacter to its percent form', () => {
    expect(escapeFilespecPath('a@b')).toBe('a%40b')
    expect(escapeFilespecPath('a#b')).toBe('a%23b')
    expect(escapeFilespecPath('a*b')).toBe('a%2Ab')
    expect(escapeFilespecPath('a%b')).toBe('a%25b')
  })

  it('escapes combinations in one pass without double-escaping', () => {
    expect(escapeFilespecPath('a@b#c%d*e')).toBe('a%40b%23c%25d%2Ae')
  })

  it('escapes % first so an introduced % is not re-escaped', () => {
    expect(escapeFilespecPath('100%')).toBe('100%25')
    expect(escapeFilespecPath('%40')).toBe('%2540')
  })
})

describe('buildScopeFilespec', () => {
  it('builds a recursive directory scope', () => {
    expect(buildScopeFilespec('X:/p4ws/main', true)).toBe('X:/p4ws/main/...')
  })

  it('trims a single trailing separator in directory scopes', () => {
    expect(buildScopeFilespec('X:/p4ws/main/', true)).toBe('X:/p4ws/main/...')
    expect(buildScopeFilespec('X:\\p4ws\\main\\', true)).toBe('X:\\p4ws\\main/...')
  })

  it('trims multiple trailing separators in directory scopes', () => {
    expect(buildScopeFilespec('X:/p4ws/main//', true)).toBe('X:/p4ws/main/...')
    expect(buildScopeFilespec('X:\\p4ws\\main\\\\', true)).toBe('X:\\p4ws\\main/...')
  })

  it('builds a file scope without appending /...', () => {
    expect(buildScopeFilespec('X:/p4ws/main/a.txt', false)).toBe('X:/p4ws/main/a.txt')
  })

  it('escapes metacharacters in both directory and file scopes', () => {
    expect(buildScopeFilespec('X:/p4ws/@dir#1', true)).toBe('X:/p4ws/%40dir%231/...')
    expect(buildScopeFilespec('X:/p4ws/main/a@1.txt', false)).toBe('X:/p4ws/main/a%401.txt')
    expect(buildScopeFilespec('X:/p4ws/main/a 100%.txt', false)).toBe('X:/p4ws/main/a 100%25.txt')
  })

  it('handles empty and separator-only input without crashing', () => {
    expect(buildScopeFilespec('', false)).toBe('')
    expect(buildScopeFilespec('', true)).toBe('/...')
    expect(buildScopeFilespec('/', true)).toBe('/...')
    expect(buildScopeFilespec('\\', true)).toBe('/...')
  })
})
