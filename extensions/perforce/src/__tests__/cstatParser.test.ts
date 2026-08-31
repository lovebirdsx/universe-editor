import { describe, expect, it } from 'vitest'
import { parseCstat } from '../cstatParser.js'

describe('parseCstat', () => {
  it('maps each changelist id to its sync status', () => {
    const map = parseCstat([
      { change: '4521', status: 'have' },
      { change: '4519', status: 'need' },
      { change: '4500', status: 'partial' },
    ])
    expect(map).toEqual(
      new Map([
        ['4521', 'have'],
        ['4519', 'need'],
        ['4500', 'partial'],
      ]),
    )
  })

  it('drops records with an unknown or empty status', () => {
    const map = parseCstat([
      { change: '1', status: 'unknown' },
      { change: '2', status: '' },
      { change: '3', status: 'have' },
    ])
    expect(map).toEqual(new Map([['3', 'have']]))
  })

  it('skips records without a change id', () => {
    const map = parseCstat([
      { status: 'need' },
      { change: '', status: 'need' },
      { change: '4521', status: 'need' },
    ])
    expect(map).toEqual(new Map([['4521', 'need']]))
  })

  it('returns an empty map for empty input', () => {
    expect(parseCstat([])).toEqual(new Map())
  })

  it('normalizes case and surrounding whitespace in status', () => {
    const map = parseCstat([
      { change: '1', status: ' NEED ' },
      { change: '2', status: 'Have' },
      { change: '3', status: 'PARTIAL' },
    ])
    expect(map).toEqual(
      new Map([
        ['1', 'need'],
        ['2', 'have'],
        ['3', 'partial'],
      ]),
    )
  })

  it('lets the last record win for a duplicated change id', () => {
    const map = parseCstat([
      { change: '4521', status: 'need' },
      { change: '4521', status: 'have' },
    ])
    expect(map).toEqual(new Map([['4521', 'have']]))
  })
})
