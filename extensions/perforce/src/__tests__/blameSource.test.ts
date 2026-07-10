import { describe, expect, it } from 'vitest'
import { parseAnnotate, annotatedChangelists, buildBlameResult } from '../blameSource.js'

describe('parseAnnotate', () => {
  it('assigns line numbers to records carrying data and reads lower/user/time', () => {
    const records = [
      { depotFile: '//depot/a.txt' }, // header — no data, no line consumed
      { data: 'first', lower: '10', user: 'alice', time: '1700000000' },
      { data: 'second', lower: '10', user: 'alice', time: '1700000000' },
      { data: 'third', lower: '12', user: 'bob', time: '1700000100' },
    ]
    const lines = parseAnnotate(records)
    expect(lines).toEqual([
      { line: 1, changelist: '10', user: 'alice', time: 1700000000000 },
      { line: 2, changelist: '10', user: 'alice', time: 1700000000000 },
      { line: 3, changelist: '12', user: 'bob', time: 1700000100000 },
    ])
  })

  it('falls back to upper when lower is missing and leaves time undefined', () => {
    const lines = parseAnnotate([{ data: 'x', upper: '5' }])
    expect(lines[0]).toEqual({ line: 1, changelist: '5', user: undefined, time: undefined })
  })
})

describe('annotatedChangelists', () => {
  it('returns the unique changelist ids', () => {
    const lines = parseAnnotate([
      { data: 'a', lower: '10' },
      { data: 'b', lower: '12' },
      { data: 'c', lower: '10' },
    ])
    expect(annotatedChangelists(lines).sort()).toEqual(['10', '12'])
  })
})

describe('buildBlameResult', () => {
  it('folds contiguous lines of a changelist into ranges', () => {
    const lines = parseAnnotate([
      { data: 'a', lower: '10', user: 'alice', time: '1700000000' },
      { data: 'b', lower: '10', user: 'alice', time: '1700000000' },
      { data: 'c', lower: '12', user: 'bob', time: '1700000100' },
      { data: 'd', lower: '10', user: 'alice', time: '1700000000' },
    ])
    const summaries = new Map([
      ['10', { summary: 'feature a' }],
      ['12', { summary: 'fix b' }],
    ])
    const result = buildBlameResult(lines, summaries)

    const cl10 = result.commits.find((c) => c.hash === '10')!
    expect(cl10.ranges).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 4, endLine: 4 },
    ])
    expect(cl10.summary).toBe('feature a')
    expect(cl10.authorName).toBe('alice')
    expect(cl10.authorDate).toBe(1700000000000)

    const cl12 = result.commits.find((c) => c.hash === '12')!
    expect(cl12.ranges).toEqual([{ startLine: 3, endLine: 3 }])
    expect(result.uncommittedLines).toEqual([])
  })

  it('reports lines without a changelist as uncommitted', () => {
    const lines = parseAnnotate([{ data: 'a' }, { data: 'b', lower: '9' }])
    const result = buildBlameResult(lines, new Map())
    expect(result.uncommittedLines).toEqual([1])
    expect(result.commits).toHaveLength(1)
  })

  it('falls back to describe metadata when the annotate line lacks user/time', () => {
    const lines = parseAnnotate([{ data: 'a', lower: '7' }])
    const result = buildBlameResult(
      lines,
      new Map([['7', { summary: 's', user: 'carol', time: 1700000500000 }]]),
    )
    expect(result.commits[0]!.authorName).toBe('carol')
    expect(result.commits[0]!.authorDate).toBe(1700000500000)
  })
})
