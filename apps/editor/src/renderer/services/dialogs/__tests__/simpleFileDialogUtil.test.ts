/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/dialogs/simpleFileDialogUtil.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  completePath,
  endsWithSeparator,
  expandTilde,
  findCompletion,
  isDeletion,
  prepareEntries,
  splitTrailingSegment,
  type DialogEntry,
} from '../simpleFileDialogUtil.js'

const entry = (name: string, isDirectory: boolean): DialogEntry => ({ name, isDirectory })

describe('prepareEntries', () => {
  it('orders directories before files, each group sorted by name', () => {
    const input = [
      entry('readme.md', false),
      entry('src', true),
      entry('apps', true),
      entry('package.json', false),
    ]
    const result = prepareEntries(input, { allowFiles: true, showDotFiles: false })
    expect(result.map((e) => e.name)).toEqual(['apps', 'src', 'package.json', 'readme.md'])
  })

  it('sorts numerically and case-insensitively', () => {
    const input = [entry('file10', false), entry('file2', false), entry('File1', false)]
    const result = prepareEntries(input, { allowFiles: true, showDotFiles: false })
    expect(result.map((e) => e.name)).toEqual(['File1', 'file2', 'file10'])
  })

  it('drops files when allowFiles is false', () => {
    const input = [entry('src', true), entry('readme.md', false)]
    const result = prepareEntries(input, { allowFiles: false, showDotFiles: false })
    expect(result.map((e) => e.name)).toEqual(['src'])
  })

  it('drops dotfiles when showDotFiles is false but keeps them otherwise', () => {
    const input = [entry('.git', true), entry('src', true)]
    expect(
      prepareEntries(input, { allowFiles: true, showDotFiles: false }).map((e) => e.name),
    ).toEqual(['src'])
    expect(
      prepareEntries(input, { allowFiles: true, showDotFiles: true }).map((e) => e.name),
    ).toEqual(['.git', 'src'])
  })
})

describe('findCompletion', () => {
  const entries = [entry('apps', true), entry('assets', true), entry('readme.md', false)]

  it('returns the first prefix match, case-insensitively', () => {
    expect(findCompletion(entries, 'ap')?.name).toBe('apps')
    expect(findCompletion(entries, 'AS')?.name).toBe('assets')
  })

  it('returns undefined for an empty segment or no match', () => {
    expect(findCompletion(entries, '')).toBeUndefined()
    expect(findCompletion(entries, 'zzz')).toBeUndefined()
  })
})

describe('splitTrailingSegment', () => {
  it('splits on the last separator, keeping it on the directory', () => {
    expect(splitTrailingSegment('/foo/bar/baz')).toEqual({ dir: '/foo/bar/', name: 'baz' })
    expect(splitTrailingSegment('C:\\foo\\bar')).toEqual({ dir: 'C:\\foo\\', name: 'bar' })
  })

  it('treats a value without a separator as a bare name', () => {
    expect(splitTrailingSegment('baz')).toEqual({ dir: '', name: 'baz' })
  })

  it('yields an empty name when the value ends with a separator', () => {
    expect(splitTrailingSegment('/foo/bar/')).toEqual({ dir: '/foo/bar/', name: '' })
  })
})

describe('endsWithSeparator', () => {
  it('detects both separator styles', () => {
    expect(endsWithSeparator('/foo/')).toBe(true)
    expect(endsWithSeparator('C:\\foo\\')).toBe(true)
    expect(endsWithSeparator('/foo/bar')).toBe(false)
  })
})

describe('completePath', () => {
  it('appends the matched suffix and selects the untyped tail', () => {
    const { value, selection } = completePath('/foo/', 'ap', 'apps')
    expect(value).toBe('/foo/apps')
    expect(selection).toEqual([7, 9])
  })
})

describe('expandTilde', () => {
  it('expands bare ~ to home plus separator', () => {
    expect(expandTilde('~', '/home/u', '/')).toBe('/home/u/')
    expect(expandTilde('~/', '/home/u', '/')).toBe('/home/u/')
    expect(expandTilde('~\\', 'C:\\Users\\u', '\\')).toBe('C:\\Users\\u\\')
  })

  it('expands ~/sub to home/sub', () => {
    expect(expandTilde('~/foo', '/home/u', '/')).toBe('/home/u/foo')
    expect(expandTilde('~\\foo', 'C:\\Users\\u', '\\')).toBe('C:\\Users\\u\\foo')
  })

  it('returns undefined when not tilde-prefixed', () => {
    expect(expandTilde('/home/u', '/home/u', '/')).toBeUndefined()
    expect(expandTilde('a~b', '/home/u', '/')).toBeUndefined()
  })
})

describe('isDeletion', () => {
  it('detects a strictly shorter prefix as a deletion', () => {
    expect(isDeletion('/foo/bar', '/foo/ba')).toBe(true)
    expect(isDeletion('/foo/', '/foo')).toBe(true)
  })

  it('is false for additions or unrelated edits', () => {
    expect(isDeletion('/foo/ba', '/foo/bar')).toBe(false)
    expect(isDeletion('/foo/bar', '/foo/baz')).toBe(false)
    expect(isDeletion('/foo', '/foo')).toBe(false)
  })
})
