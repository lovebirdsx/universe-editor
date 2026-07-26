import { describe, expect, it } from 'vitest'
import { sortOutputChannelNames } from '../outputChannelSort.js'

describe('sortOutputChannelNames', () => {
  it('pins All first and sorts the rest alphabetically', () => {
    expect(sortOutputChannelNames(['Renderer', 'All', 'Main', 'acp/claude/h1'])).toEqual([
      'All',
      'acp/claude/h1',
      'Main',
      'Renderer',
    ])
  })

  it('works without the pinned channel', () => {
    expect(sortOutputChannelNames(['b', 'a'])).toEqual(['a', 'b'])
  })

  it('handles empty and single-element lists', () => {
    expect(sortOutputChannelNames([])).toEqual([])
    expect(sortOutputChannelNames(['All'])).toEqual(['All'])
  })

  it('does not mutate the input', () => {
    const input = ['b', 'All', 'a']
    sortOutputChannelNames(input)
    expect(input).toEqual(['b', 'All', 'a'])
  })
})
