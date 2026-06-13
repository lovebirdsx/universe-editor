import { describe, expect, it } from 'vitest'
import { parseConflicts } from '../conflictParser.js'

describe('parseConflicts', () => {
  it('returns no regions for conflict-free text', () => {
    expect(parseConflicts('line 1\nline 2\nline 3')).toEqual([])
  })

  it('parses a simple two-way conflict', () => {
    const text = [
      'before',
      '<<<<<<< HEAD',
      'ours line',
      '=======',
      'theirs line',
      '>>>>>>> feature',
      'after',
    ].join('\n')

    const regions = parseConflicts(text)
    expect(regions).toHaveLength(1)
    const region = regions[0]!
    expect(region.startLine).toBe(2)
    expect(region.endLine).toBe(6)
    expect(region.base).toBeUndefined()

    expect(region.current.name).toBe('HEAD')
    expect(region.current.content).toBe('ours line')
    expect(region.current.contentStartLine).toBe(3)
    expect(region.current.contentEndLine).toBe(3)

    expect(region.incoming.name).toBe('feature')
    expect(region.incoming.content).toBe('theirs line')
    expect(region.incoming.contentStartLine).toBe(5)
    expect(region.incoming.contentEndLine).toBe(5)
  })

  it('parses a diff3 conflict with a base side', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours',
      '||||||| merged common ancestors',
      'base',
      '=======',
      'theirs',
      '>>>>>>> branch',
    ].join('\n')

    const regions = parseConflicts(text)
    expect(regions).toHaveLength(1)
    const region = regions[0]!
    expect(region.base).toBeDefined()
    expect(region.base!.name).toBe('merged common ancestors')
    expect(region.base!.content).toBe('base')
    expect(region.base!.contentStartLine).toBe(4)
    expect(region.base!.contentEndLine).toBe(4)
    expect(region.current.content).toBe('ours')
    expect(region.incoming.content).toBe('theirs')
  })

  it('parses multiple consecutive conflicts', () => {
    const text = [
      '<<<<<<< HEAD',
      'a1',
      '=======',
      'b1',
      '>>>>>>> x',
      'middle',
      '<<<<<<< HEAD',
      'a2',
      '=======',
      'b2',
      '>>>>>>> y',
    ].join('\n')

    const regions = parseConflicts(text)
    expect(regions).toHaveLength(2)
    expect(regions[0]!.startLine).toBe(1)
    expect(regions[0]!.endLine).toBe(5)
    expect(regions[1]!.startLine).toBe(7)
    expect(regions[1]!.endLine).toBe(11)
    expect(regions[1]!.current.content).toBe('a2')
    expect(regions[1]!.incoming.content).toBe('b2')
  })

  it('handles empty sides', () => {
    const text = ['<<<<<<< HEAD', '=======', 'theirs', '>>>>>>> branch'].join('\n')
    const regions = parseConflicts(text)
    expect(regions).toHaveLength(1)
    const region = regions[0]!
    expect(region.current.content).toBe('')
    expect(region.current.contentStartLine).toBeGreaterThan(region.current.contentEndLine)
    expect(region.incoming.content).toBe('theirs')
  })

  it('preserves multi-line content', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours 1',
      'ours 2',
      '=======',
      'theirs 1',
      'theirs 2',
      'theirs 3',
      '>>>>>>> branch',
    ].join('\n')
    const region = parseConflicts(text)[0]!
    expect(region.current.content).toBe('ours 1\nours 2')
    expect(region.incoming.content).toBe('theirs 1\ntheirs 2\ntheirs 3')
    expect(region.incoming.contentEndLine).toBe(7)
  })

  it('discards an unterminated conflict and restarts at a new <<<<<<<', () => {
    const text = [
      '<<<<<<< HEAD',
      'orphan ours',
      'no splitter, just a new conflict starts',
      '<<<<<<< HEAD',
      'real ours',
      '=======',
      'real theirs',
      '>>>>>>> branch',
    ].join('\n')
    const regions = parseConflicts(text)
    expect(regions).toHaveLength(1)
    expect(regions[0]!.startLine).toBe(4)
    expect(regions[0]!.current.content).toBe('real ours')
  })

  it('ignores a splitter / closing marker outside any conflict', () => {
    expect(parseConflicts('=======\n>>>>>>> x\nplain')).toEqual([])
  })

  it('parses CRLF text', () => {
    const text = ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> branch'].join('\r\n')
    const regions = parseConflicts(text)
    expect(regions).toHaveLength(1)
    expect(regions[0]!.current.content).toBe('ours')
    expect(regions[0]!.incoming.content).toBe('theirs')
  })
})
