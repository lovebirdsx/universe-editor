import { describe, expect, it } from 'vitest'
import { filelogLabel, parseFilelog } from '../filelogParser.js'

describe('parseFilelog (numbered parallel keys)', () => {
  it('folds rev0/change0/… keys of a single record into revisions', () => {
    const revisions = parseFilelog([
      {
        depotFile: '//depot/main/a.txt',
        rev0: '#3',
        change0: '4521',
        action0: 'edit',
        time0: '1700000000',
        user0: 'alice',
        client0: 'alice-ws',
        desc0: 'Fix the widget',
        rev1: '2',
        change1: '4519',
        action1: 'edit',
        time1: '1699990000',
        user1: 'bob',
        client1: 'bob-ws',
        desc1: 'Tweak',
        rev2: '1',
        change2: '4500',
        action2: 'add',
        time2: '1699900000',
        user2: 'bob',
        client2: 'bob-ws',
        desc2: 'Initial',
      },
    ])
    expect(revisions).toEqual([
      {
        rev: '3',
        change: '4521',
        action: 'edit',
        time: 1700000000,
        user: 'alice',
        client: 'alice-ws',
        desc: 'Fix the widget',
      },
      {
        rev: '2',
        change: '4519',
        action: 'edit',
        time: 1699990000,
        user: 'bob',
        client: 'bob-ws',
        desc: 'Tweak',
      },
      {
        rev: '1',
        change: '4500',
        action: 'add',
        time: 1699900000,
        user: 'bob',
        client: 'bob-ws',
        desc: 'Initial',
      },
    ])
  })

  it('keeps a multi-line desc in full', () => {
    const revisions = parseFilelog([
      {
        depotFile: '//depot/main/a.txt',
        rev0: '1',
        change0: '4500',
        action0: 'add',
        time0: '1699900000',
        user0: 'bob',
        client0: 'bob-ws',
        desc0: 'Initial\n\nwith body',
      },
    ])
    expect(revisions[0]?.desc).toBe('Initial\n\nwith body')
  })

  it('defaults missing fields and skips entries without a rev', () => {
    const revisions = parseFilelog([
      { depotFile: '//depot/main/a.txt', rev0: '#2', change0: '7', desc1: 'orphan' },
    ])
    expect(revisions).toEqual([
      { rev: '2', change: '7', action: '', time: 0, user: '', client: '', desc: '' },
    ])
  })
})

describe('parseFilelog (single-valued keys, defensive)', () => {
  it('parses one record per revision', () => {
    const revisions = parseFilelog([
      {
        depotFile: '//depot/main/a.txt',
        rev: '#3',
        change: '4521',
        action: 'edit',
        time: '1700000000',
        user: 'alice',
        client: 'alice-ws',
        desc: 'Fix',
      },
      {
        depotFile: '//depot/main/a.txt',
        rev: '2',
        change: '4519',
        action: 'delete',
        time: '1699990000',
        user: 'bob',
        client: 'bob-ws',
        desc: 'Remove',
      },
    ])
    expect(revisions.map((r) => r.rev)).toEqual(['3', '2'])
    expect(revisions[1]).toMatchObject({ change: '4519', action: 'delete', time: 1699990000 })
  })
})

describe('parseFilelog (edge cases)', () => {
  it('returns an empty array for empty input and rev-less records', () => {
    expect(parseFilelog([])).toEqual([])
    expect(parseFilelog([{ depotFile: '//depot/main/a.txt' }])).toEqual([])
    expect(parseFilelog([{ data: 'collapsed blob line' }])).toEqual([])
  })
})

describe('filelogLabel', () => {
  it('is the first line of the description', () => {
    const [revision] = parseFilelog([{ rev0: '1', change0: '1', desc0: 'First line\nsecond line' }])
    expect(filelogLabel(revision!)).toBe('First line')
  })
})
